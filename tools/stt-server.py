#!/usr/bin/env python3
"""本机 STT 侧车：OpenAI 兼容 /v1/audio/transcriptions（faster-whisper + ffmpeg）。

为什么需要它：QQ 语音在 NapCat 事件里只给文件路径/URL（实测字段 file/path/url/file_size，没有转写），
所以要自己把音频转成文字。本服务只监听 127.0.0.1，音频不出本机。

用法：
    python tools/stt-server.py --model small --port 8910
    curl -F "file=@a.amr" http://127.0.0.1:8910/v1/audio/transcriptions

模型：tiny / base / small（默认，中文够用，约 470MB）/ medium / large-v3
设备：默认自动（有 CUDA 且 cuDNN 就上 GPU，否则 CPU int8）
"""
import argparse, glob, json, os, shutil, subprocess, sys, tempfile, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def resolve_ffmpeg(preferred=None):
    """找 ffmpeg：先用显式配置/PATH，再找 winget 装的位置，最后几个常见目录。
    为什么要这样：winget 装完只对**新开的 shell** 生效，服务进程里常常 PATH 里没有它。"""
    if preferred and os.path.exists(preferred):
        return preferred
    hit = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    if hit:
        return hit
    pats = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "**", "bin", "ffmpeg.exe"),
        os.path.join(os.environ.get("ProgramFiles", "C:/Program Files"), "ffmpeg", "bin", "ffmpeg.exe"),
        "C:/ffmpeg/bin/ffmpeg.exe",
    ]
    for p in pats:
        for f in glob.glob(p, recursive=True):
            if os.path.exists(f):
                return f
    return preferred or "ffmpeg"


FFMPEG = resolve_ffmpeg(os.environ.get("STT_FFMPEG"))
MODEL = os.environ.get("STT_MODEL") or "small"
DEVICE = os.environ.get("STT_DEVICE") or "auto"
LANG = os.environ.get("STT_LANG") or "zh"
_model = None


def load_model(force_cpu=False):
    global _model
    if _model is not None and not force_cpu:
        return _model
    from faster_whisper import WhisperModel
    # 本地模型目录要给**绝对路径**，否则会被当成 HuggingFace 仓库名
    target = os.path.abspath(MODEL) if os.path.isdir(MODEL) else MODEL
    order = [("cpu", "int8")] if (force_cpu or DEVICE == "cpu") else [("cuda", "float16"), ("cpu", "int8")]
    last = None
    for dev, ct in order:
        try:
            _model = WhisperModel(target, device=dev, compute_type=ct)
            sys.stderr.write("[stt] 模型就绪：%s / %s / %s" % (MODEL, dev, ct) + chr(10))
            return _model
        except Exception as e:
            last = e
            sys.stderr.write("[stt] %s 不可用（%s），试下一个" % (dev, str(e)[:120]) + chr(10))
    raise RuntimeError("模型加载失败：%s" % last)


def to_wav(src, dst):
    subprocess.run([FFMPEG, "-y", "-i", src, "-ar", "16000", "-ac", "1", "-f", "wav", dst],
                   check=True, capture_output=True)


def read_wav_mono16k(wav):
    """自己读 16k/mono/16bit wav（stdlib wave + numpy）。
    为什么要自己读：faster-whisper 走 PyAV 解码时和某些 av 版本不兼容（open() got an unexpected
    keyword argument 'metadata_errors'）。反正我们已经用 ffmpeg 转成标准 wav 了，直接喂数组最稳。"""
    import wave
    import numpy as np
    with wave.open(wav, "rb") as w:
        ch, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(frames)
    if width != 2:
        raise RuntimeError("只支持 16bit wav（ffmpeg 已经保证）")
    a = np.frombuffer(raw, dtype=np.int16).astype("float32") / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if rate != 16000:                      # ffmpeg 已转 16k，这里只是兜底
        raise RuntimeError("采样率不是 16000（ffmpeg 已经保证）")
    return a


def transcribe(path, lang):
    wav = path + ".16k.wav"
    to_wav(path, wav)
    model = load_model()
    audio = None
    try:
        audio = read_wav_mono16k(wav)
    except Exception as e:
        sys.stderr.write("[stt] 数组解码失败（%s），退回按文件路径解码" % str(e)[:80] + chr(10))
    target = audio if audio is not None else wav

    def run(m):
        # 注意：faster-whisper 的 transcribe() 是**生成器**，真正的计算发生在遍历 segs 时 ——
        # 所以必须把"消费片段"这一步也放进 try 里，CUDA 报错才抓得住。
        segs, info = m.transcribe(target, language=(lang or None), vad_filter=True, beam_size=5)
        return "".join(s.text for s in segs).strip(), info

    try:
        return run(model)
    except Exception as e:
        msg = str(e)
        low = msg.lower()
        if ("cublas" in low or "cudnn" in low or "cuda" in low) and DEVICE != "cpu":
            global _model
            sys.stderr.write("[stt] GPU 不可用（%s）→ 退回 CPU int8 重来一次" % msg[:80] + chr(10))
            _model = None
            _model = load_model(force_cpu=True)
            return run(_model)
        raise


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode("utf8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {"ok": True, "model": MODEL, "device": DEVICE})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/v1/audio/transcriptions"):
            return self._json(404, {"error": "not found"})
        ctype = self.headers.get("Content-Type", "") or ""
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        boundary = ctype.split("boundary=")[-1]
        if not boundary:
            return self._json(400, {"error": "need multipart/form-data"})
        data, lang, name = None, None, "a.amr"
        for p in raw.split(("--" + boundary).encode()):
            if b"filename=" in p:
                head, _, body = p.partition(b"\r\n\r\n")
                data = body.rstrip(b"\r\n-")
                m = head.split(b'filename="')
                if len(m) > 1:
                    name = m[1].split(b'"')[0].decode("utf8", "ignore")
            elif b'name="language"' in p:
                _, _, body = p.partition(b"\r\n\r\n")
                lang = body.strip().decode("utf8", "ignore")
        if not data:
            return self._json(400, {"error": "no file"})
        ext = os.path.splitext(name)[1] or ".amr"
        t0 = time.time()
        try:
            with tempfile.TemporaryDirectory() as d:
                f = os.path.join(d, "in" + ext)
                with open(f, "wb") as fp:
                    fp.write(data)
                text, info = transcribe(f, lang or LANG)
        except Exception as e:
            return self._json(500, {"error": str(e)[:200]})
        return self._json(200, {
            "text": text,
            "language": getattr(info, "language", None),
            "duration": round(float(getattr(info, "duration", 0) or 0), 2),
            "ms": int((time.time() - t0) * 1000),
            "model": MODEL,
        })


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8910)
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--device", default=DEVICE)
    ap.add_argument("--ffmpeg", default=FFMPEG)
    ap.add_argument("--lang", default=LANG)
    a = ap.parse_args()
    MODEL, DEVICE, FFMPEG, LANG = a.model, a.device, a.ffmpeg, a.lang
    sys.stderr.write("[stt] 监听 http://%s:%d/v1/audio/transcriptions  model=%s device=%s" % (a.host, a.port, MODEL, DEVICE) + chr(10))
    ThreadingHTTPServer((a.host, a.port), H).serve_forever()
