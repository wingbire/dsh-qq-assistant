// B 站"看视频"：标题/简介/字幕 + 抽帧识图。匿名即可，不需要账号。
// 抽帧是临时文件，识完图立刻删；没有 ffmpeg 时自动降级成"只看字幕/简介"。
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REF = "https://www.bilibili.com/";

// 从一段话里认出 B 站视频：BV 号 / av 号 / b23.tv 短链
export function resolveBvid(text) {
  const s = String(text || "");
  const m = s.match(/BV([0-9A-Za-z]{10})/);
  if (m) return "BV" + m[1];
  const a = s.match(/\bav(\d+)/i);
  if (a) return "av" + a[1];
  return null;
}

export function hasBiliUrl(text) { return !!resolveBvid(text) || /b23\.tv|bilibili\.com\/video/i.test(String(text || "")); }

export function createBilibili(opts) {
  const o = opts || {};
  const fetchFn = o.fetch || fetch;
  let vision = o.vision || null;   // main 里 vision 建得晚，后面用 setVision 补
  const tmpDir = o.tmpDir || null;
  const frames = Math.max(0, Number(o.frames == null ? 4 : o.frames));
  const timeoutMs = Number(o.timeoutMs) || 60000;

  async function getJson(url) {
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

  async function watch(link) {
    const bvid = resolveBvid(link);
    if (!bvid) return { ok: false, error: "没认出 BV 号" };
    let v;
    try { v = await getJson("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid); } catch (e) { return { ok: false, error: String(e && e.message) }; }
    if (!v || v.code !== 0 || !v.data) return { ok: false, error: "拿不到视频信息（code " + (v && v.code) + "）" };
    const d = v.data || {};
    const cid = d.cid;
    const lines = [];
    lines.push("标题：" + String(d.title || ""));
    if (d.owner && d.owner.name) lines.push("UP主：" + d.owner.name);
    if (d.duration) lines.push("时长：" + Math.round(Number(d.duration) / 60) + " 分钟");
    if (d.desc) lines.push("简介：" + String(d.desc).replace(/\s+/g, " ").slice(0, 220));

    // 字幕（有就取，没就算了）
    try {
      const p = await getJson("https://api.bilibili.com/x/player/v2?bvid=" + bvid + "&cid=" + cid);
      const list = (p && p.data && p.data.subtitle && p.data.subtitle.subtitles) || [];
      if (list.length && list[0].subtitle_url) {
        let u = String(list[0].subtitle_url);
        if (u.indexOf("//") === 0) u = "https:" + u;
        const s = await getJson(u);
        const body = ((s && s.body) || []).map(function (x) { return x.content; }).join(" ").replace(/\s+/g, " ");
        if (body) lines.push("字幕片段：" + body.slice(0, 600));
      }
    } catch (e) { }

    // 抽帧 + 识图（临时文件，识完即删）
    const shots = [];
    if (vision && tmpDir && frames > 0) {
      try {
        const pu = await getJson("https://api.bilibili.com/x/player/playurl?bvid=" + bvid + "&cid=" + cid + "&qn=16&fnval=1&platform=html5");
        const url = (pu && pu.data && pu.data.durl && pu.data.durl[0] && pu.data.durl[0].url) || "";
        if (url) {
          const dur = Math.max(10, Number(d.duration) || 60);
          for (let i = 1; i <= frames; i++) {
            const sec = Math.floor(dur * i / (frames + 1));
            const f = path.join(tmpDir, "bili-" + bvid + "-" + sec + ".jpg");
            const got = await grabFrame(url, sec, f);
            if (!got) continue;
            let r = null;
            try { r = await vision.describe({ ok: true, path: f, bytes: fs.statSync(f).size, mime: "image/jpeg" }, {}); } catch (e) { r = null; }
            try { fs.unlinkSync(f); } catch (e) { }        // 临时帧，识完就删
            if (r && r.ok && r.text) shots.push(String(r.text).slice(0, 200));
          }
        }
      } catch (e) { }
    }
    if (shots.length) lines.push("画面（抽了几帧看了下）：" + shots.join(" ／ "));
    return { ok: true, bvid: bvid, title: d.title, hasSub: lines.join("").indexOf("字幕片段") >= 0, shots: shots.length, text: lines.join("\n") };
  }

  function setVision(v) { vision = v; }
  return { watch: watch, resolveBvid: resolveBvid, setVision: setVision };
}
