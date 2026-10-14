import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

// 语音转写侧车客户端。
// 背景：实测 NapCat 不上报 QQ 的官方转写（record 段只有 file/path/url/file_size），
// 所以"听懂语音"只能自己转：把音频喂给本机 STT 侧车（tools/stt-server.py，OpenAI 兼容接口）。
// 设计对齐 vision.js：能力判定 + 失败降级 + 同段音频不重复转写；音频不出本机（默认端点就是 127.0.0.1）。
export const STT_DEFAULTS = {
  enabled: false,
  endpoint: "http://127.0.0.1:8910/v1/audio/transcriptions",
  timeoutMs: 30000,
  maxBytes: 8 * 1024 * 1024,
  lang: "zh"
};

// AbortSignal.timeout() 会在退出时留下定时器句柄，Windows 上 libuv 会在进程退出时断言崩溃
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94）。
// 所以自己管这个定时器：用完 clearTimeout，并 unref 掉别钉住进程。
function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(function () { try { c.abort(); } catch (e) { /* 已经结束 */ } }, ms || 30000);
  if (typeof t.unref === "function") t.unref();
  return {
    signal: c.signal,
    done: function () { try { clearTimeout(t); } catch (e) { /* ignore */ } }
  };
}

export const AUDIO_EXT = [".amr", ".silk", ".slk", ".wav", ".mp3", ".m4a", ".ogg", ".aac", ".flac", ".opus", ".webm"];

export function audioExtOf(ref) {
  const s = String((ref && (ref.file || ref.path || ref.url)) || "");
  const m = s.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  const e = m ? "." + m[1].toLowerCase() : "";
  return AUDIO_EXT.indexOf(e) >= 0 ? e : ".amr";     // QQ 语音默认 amr
}

// 归一化 record 段 → 本地文件；本地读不到就按 url 下载
export async function resolveLocalAudio(ref, opts) {
  const o = opts || {};
  const raw = String((ref && (ref.path || ref.file || ref.url)) || "");
  const local = raw.replace(/^file:\/\//i, "");
  if (local && !/^https?:\/\//i.test(local)) {
    try {
      const abs = path.resolve(local);
      const st = fs.statSync(abs);
      if (!st.isFile()) return { ok: false, error: "不是文件" };
      if (st.size > (o.maxBytes || STT_DEFAULTS.maxBytes)) return { ok: false, error: "音频过大 " + st.size + " 字节" };
      return { ok: true, path: abs, bytes: st.size, ext: audioExtOf(ref) };
    } catch (e) { /* 本地没有就往下走下载 */ }
  }
  const url = String((ref && ref.url) || (/^https?:\/\//i.test(raw) ? raw : ""));
  if (!url) return { ok: false, error: "没有可用的音频地址" };
  return { ok: false, needDownload: true, url: url };
}

export async function downloadAudio(url, outDir, opts) {
  const o = opts || {};
  const doFetch = o.fetch || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { ok: false, error: "运行时不带 fetch" };
  try {
    const res = await doFetch(url, { headers: { "User-Agent": "dshqq/3.0" } });
    if (!res || !res.ok) return { ok: false, error: "HTTP " + (res && res.status) };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > (o.maxBytes || STT_DEFAULTS.maxBytes)) return { ok: false, error: "音频过大 " + buf.length + " 字节" };
    fs.mkdirSync(outDir, { recursive: true });
    const ext = audioExtOf({ url: url });
    const file = path.join(outDir, "voice-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + ext);
    fs.writeFileSync(file, buf);
    return { ok: true, path: file, bytes: buf.length, ext: ext };
  } catch (e) { return { ok: false, error: String(e && e.message) }; }
}

// 侧车的返回：{ text, language, duration, ms, model } —— 只取 text，其余丢了
export function parseSttAnswer(json) {
  if (!json || typeof json !== "object") return "";
  return String(json.text == null ? "" : json.text).trim().slice(0, 300);
}

// GET /health（把 endpoint 的路径部分换成 /health）
export function healthUrlOf(endpoint) {
  const e = String(endpoint || STT_DEFAULTS.endpoint);
  try { const u = new URL(e); u.pathname = "/health"; u.search = ""; return u.toString(); }
  catch (err) { return "http://127.0.0.1:8910/health"; }
}

export function createStt(opts) {
  const o = opts || {};
  const cfg = Object.assign({}, STT_DEFAULTS, o.config || {});
  const doFetch = o.fetch || (typeof fetch === "function" ? fetch : null);
  const stats = { calls: 0, ok: 0, fail: 0, skipped: 0, msTotal: 0, lastError: null, lastMs: 0 };

  function enabled() { return cfg.enabled === true && !!cfg.endpoint; }

  async function transcribe(filePath) {
    if (!enabled()) { stats.skipped += 1; return { ok: false, error: "语音转写未启用" }; }
    if (!doFetch) { stats.skipped += 1; return { ok: false, error: "运行时不带 fetch" }; }
    let buf = null;
    try { buf = fs.readFileSync(filePath); } catch (e) { return { ok: false, error: "读不到音频：" + String(e && e.message) }; }
    const t0 = Date.now();
    stats.calls += 1;
    try {
      const fd = new FormData();
      fd.append("file", new Blob([buf]), path.basename(filePath));
      if (cfg.lang) fd.append("language", String(cfg.lang));
      const tm = withTimeout(cfg.timeoutMs || STT_DEFAULTS.timeoutMs);
      let res = null, json = null;
      try {
        res = await doFetch(cfg.endpoint, { method: "POST", body: fd, signal: tm.signal });
        if (!res || !res.ok) throw new Error("HTTP " + (res && res.status));
        json = await res.json();
      } finally { tm.done(); }
      const text = parseSttAnswer(json);
      if (!text) throw new Error("侧车没返回文字");
      const ms = Date.now() - t0;
      stats.ok += 1; stats.msTotal += ms; stats.lastMs = ms;
      return { ok: true, text: text, ms: ms, bytes: buf.length, model: json && json.model ? String(json.model) : null };
    } catch (e) {
      stats.fail += 1; stats.lastError = String(e && e.message);
      return { ok: false, error: stats.lastError, ms: Date.now() - t0 };
    }
  }

  // 体检：能不能连上侧车（给设置页「拓展依赖」和启动日志用）
  // 用 node:http + agent:false，**不走 fetch 的连接池**：池化 socket 会在"干净退出"时
  // 还挂着未关闭的句柄，Windows 上 libuv 直接断言崩（实测 --selftest 就是这么崩的）。
  function probeOnce(url, ms) {
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (v) { if (done) return; done = true; try { clearTimeout(t); } catch (e) {} try { req.destroy(); } catch (e) {} resolve(v); };
      let u = null;
      try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: "地址不对：" + url }); }
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request({
        hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, method: "GET", agent: false, headers: { "User-Agent": "dshqq/3.0" }
      }, function (res) {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", function (c) { body += c; });
        res.on("end", function () {
          let j = null; try { j = JSON.parse(body); } catch (e) { j = null; }
          finish({ ok: res.statusCode === 200 && !!(j && j.ok), model: j && j.model ? String(j.model) : null, device: j && j.device ? String(j.device) : null, status: res.statusCode });
        });
      });
      const t = setTimeout(function () { finish({ ok: false, error: "超时" }); }, ms || 3000);
      if (typeof t.unref === "function") t.unref();
      req.on("error", function (e) { finish({ ok: false, error: String(e && e.message) }); });
      req.end();
    });
  }

  async function probe() {
    // 测试注入了 fetch → 走 fetch（可控、不打真实网络）；生产不注入 → 走上面那条非池化 http
    if (o.fetch) {
      try {
        const tm = withTimeout(3000);
        let res = null, j = null;
        try {
          res = await doFetch(healthUrlOf(cfg.endpoint), { signal: tm.signal });
          if (!res || !res.ok) return { ok: false, error: "HTTP " + (res && res.status) };
          j = await res.json().catch(function () { return null; });
        } finally { tm.done(); }
        return { ok: !!(j && j.ok), model: j && j.model ? String(j.model) : null, device: j && j.device ? String(j.device) : null };
      } catch (e) { return { ok: false, error: String(e && e.message) }; }
    }
    return probeOnce(healthUrlOf(cfg.endpoint), 3000);
  }

  return { config: cfg, enabled: enabled, transcribe: transcribe, probe: probe, stats: function () { return Object.assign({}, stats); } };
}
