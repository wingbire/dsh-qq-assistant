// B 站"看视频"：标题/简介/字幕 + 抽帧识图。匿名即可，不需要账号。
// 抽帧是临时文件，识完图立刻删；没有 ffmpeg 时自动降级成"只看字幕/简介"。
// 另外支持"自己找"：findAndWatch(keyword) → 搜 → 过滤 → 随机挑一个 → 看。
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REF = "https://www.bilibili.com/";
const BAD_TITLE = /裸|脱|床|情趣|约炮|成人|福利|涩|色情|爆乳|女生身体/;

export function resolveBvid(text) {
  const s = String(text || "");
  const m = s.match(/BV([0-9A-Za-z]{10})/);
  if (m) return "BV" + m[1];
  const a = s.match(/\bav(\d+)/i);
  if (a) return "av" + a[1];
  return null;
}

export function hasBiliUrl(text) { return !!resolveBvid(text) || /b23\.tv|bilibili\.com\/video/i.test(String(text || "")); }

// 抽帧时间点：片头片尾各留一帧（看包装/结尾），剩下的向中间聚拢 ——
// 因为视频的干货通常在中间，片头多是 logo/开场白、片尾多是结束语/广告。
// 用 Box-Muller 造标准正态，截到 ±2σ 再映射到 [0.08, 0.92] 的时长区间。
export function sampleTimes(durationSec, count) {
  const dur = Math.max(10, Number(durationSec) || 60);
  const k = Math.max(0, Math.floor(Number(count) || 0));
  if (!k) return [];
  if (k === 1) return [Math.floor(dur * 0.5)];
  const out = [Math.floor(dur * 0.12)];                       // 早段一帧
  const mid = k - 2;                                          // 中间的正态帧
  for (let i = 0; i < mid; i++) {
    const u1 = Math.max(1e-9, Math.random()), u2 = Math.random();
    let z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    z = Math.max(-2, Math.min(2, z));
    const t = 0.5 + z * 0.16;                                 // 中间 ±2σ(0.16) → 0.18~0.82
    out.push(Math.floor(dur * Math.max(0.18, Math.min(0.82, t))));
  }
  out.push(Math.floor(dur * 0.9));                           // 尾段一帧
  return out;
}

export function createBilibili(opts) {
  const o = opts || {};
  const fetchFn = o.fetch || fetch;
  let vision = o.vision || null;
  let stt = o.stt || null;                 // 本地语音转写：抽一段音频听
  const listenSec = Math.max(0, Math.min(120, Number(o.listenSec || 0)));   // 0 = 不听
  const tmpDir = o.tmpDir || null;
  const frames = Math.max(0, Number(o.frames == null ? 4 : o.frames));
  const maxMinutes = Math.max(0, Number(o.maxMinutes == null ? 30 : o.maxMinutes));
  const timeoutMs = Number(o.timeoutMs) || 60000;

  async function fetchJson(url) {
    const ac = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    const r = await fetchFn(url, { headers: { "User-Agent": UA, Referer: REF }, signal: ac });
    if (!r || !r.ok) throw new Error("HTTP " + (r && r.status));
    return r.json();
  }

  function grabFrame(url, sec, out) {
    return new Promise(function (resolve) {
      const args = ["-y", "-loglevel", "error", "-headers", "Referer: " + REF + "\r\n", "-user_agent", UA,
        "-ss", String(sec), "-i", url, "-frames:v", "1", "-vf", "scale=480:-1", out];
      try {
        execFile("ffmpeg", args, { timeout: 40000, windowsHide: true }, function (err) {
          resolve(!err && fs.existsSync(out));
        });
      } catch (e) { resolve(false); }
    });
  }

  // 从视频里抽一段音频（给语音转写听）
  function grabAudio(url, sec, durSec, out) {
    return new Promise(function (resolve) {
      const args = ["-y", "-loglevel", "error", "-headers", "Referer: " + REF + "\r\n", "-user_agent", UA,
        "-ss", String(sec), "-t", String(durSec), "-i", url, "-vn", "-ac", "1", "-ar", "16000", out];
      try { execFile("ffmpeg", args, { timeout: 60000, windowsHide: true }, function (err) { resolve(!err && fs.existsSync(out)); }); } catch (e) { resolve(false); }
    });
  }

  async function watch(link, opts) {
    const bvid = resolveBvid(link);
    if (!bvid) return { ok: false, error: "没认出 BV 号" };
    let v;
    try { v = await fetchJson("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid); } catch (e) { return { ok: false, error: String(e && e.message) }; }
    if (!v || v.code !== 0 || !v.data) return { ok: false, error: "拿不到视频信息（code " + (v && v.code) + "）" };
    const d = v.data || {};
    const cid = d.cid;
    const lines = [];
    lines.push("标题：" + String(d.title || ""));
    if (d.owner && d.owner.name) lines.push("UP主：" + d.owner.name);
    if (d.duration) lines.push("时长：" + Math.round(Number(d.duration) / 60) + " 分钟");
    if (d.desc) lines.push("简介：" + String(d.desc).replace(/\s+/g, " ").slice(0, 220));
    try {
      const p = await fetchJson("https://api.bilibili.com/x/player/v2?bvid=" + bvid + "&cid=" + cid);
      const list = (p && p.data && p.data.subtitle && p.data.subtitle.subtitles) || [];
      if (list.length && list[0].subtitle_url) {
        let u = String(list[0].subtitle_url);
        if (u.indexOf("//") === 0) u = "https:" + u;
        const s = await fetchJson(u);
        const body = ((s && s.body) || []).map(function (x) { return x.content; }).join(" ").replace(/\s+/g, " ");
        if (body) lines.push("字幕片段：" + body.slice(0, 600));
      }
    } catch (e) { }
    const shots = [];
    let mediaUrl = "";
    if ((frames > 0 || listenSec > 0) && !longVideo) {
      try {
        const pu = await fetchJson("https://api.bilibili.com/x/player/playurl?bvid=" + bvid + "&cid=" + cid + "&qn=16&fnval=1&platform=html5");
        mediaUrl = (pu && pu.data && pu.data.durl && pu.data.durl[0] && pu.data.durl[0].url) || "";
      } catch (e) { }
    }
    const longVideo = !!(maxMinutes && Number(d.duration) > maxMinutes * 60);
    const wantFrames = Math.max(0, Math.min(12, Number(opts && opts.frames != null ? opts.frames : frames)));
    if (vision && tmpDir && wantFrames > 0 && !longVideo) {
      try {
        const url = mediaUrl;
        if (url) {
          const dur = Math.max(10, Number(d.duration) || 60);
          for (const sec of sampleTimes(dur, wantFrames)) {
            const f = path.join(tmpDir, "bili-" + bvid + "-" + sec + ".jpg");
            const got = await grabFrame(url, sec, f);
            if (!got) continue;
            let r2 = null;
            try { r2 = await vision.describe({ ok: true, path: f, bytes: fs.statSync(f).size, mime: "image/jpeg" }, {}); } catch (e) { r2 = null; }
            try { fs.unlinkSync(f); } catch (e) { }
            if (r2 && r2.ok && r2.text) shots.push(String(r2.text).slice(0, 200));
          }
        }
      } catch (e) { }
    }
    if (shots.length) lines.push("画面（抽了几帧看了下）：" + shots.join(" ／ "));
    // 听声音：从片子中段抽 1~2 段音频交给本地语音转写（每段约 20 秒）
    if (stt && tmpDir && listenSec > 0 && mediaUrl && !longVideo) {
      const heard = [];
      const clips = listenSec >= 40 ? 2 : 1;
      const each = Math.max(10, Math.floor(listenSec / clips));
      for (let ci = 0; ci < clips; ci++) {
        const start = Math.floor(dur * (clips === 1 ? 0.4 : (ci === 0 ? 0.25 : 0.7)));
        const af = path.join(tmpDir, "bili-a-" + bvid + "-" + start + ".wav");
        const okA = await grabAudio(mediaUrl, start, each, af);
        if (!okA) continue;
        let tr = null;
        try { tr = await stt.transcribe(af); } catch (e) { tr = null; }
        try { fs.unlinkSync(af); } catch (e) { }
        if (tr && tr.ok && tr.text) heard.push(String(tr.text).slice(0, 220));
      }
      if (heard.length) lines.push("声音（听了几段）：" + heard.join(" ／ "));
    }
    return { ok: true, bvid: bvid, title: d.title, shots: shots.length, text: lines.join(String.fromCharCode(10)) };
  }

  // 自己找一个：按关键词搜 → 过滤不合适的 → 从播放量高的前几名里随机挑一个 → 看
  async function findAndWatch(keyword, opts) {
    const kw = String(keyword || "").trim();
    if (!kw) return { ok: false, error: "没有关键词" };
    let list = [];
    try {
      const j = await fetchJson("https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=" + encodeURIComponent(kw) + "&page=1");
      list = ((j && j.data && j.data.result) || []);
    } catch (e) { return { ok: false, error: String(e && e.message) }; }
    const cands = list.filter(function (x) { return x && x.bvid && !BAD_TITLE.test(String(x.title || "")); }).slice(0, 10);
    if (!cands.length) return { ok: false, error: "没搜到合适的视频" };
    const pick = cands[Math.floor(Math.random() * cands.length)];
    const r = await watch(pick.bvid, opts);
    if (!r.ok) return r;
    r.keyword = kw;
    r.pickedFrom = cands.length;
    return r;
  }

  function setVision(v) { vision = v; }
  function setStt(v) { stt = v; }
  return { watch: watch, findAndWatch: findAndWatch, resolveBvid: resolveBvid, setVision: setVision, setStt: setStt };
}
