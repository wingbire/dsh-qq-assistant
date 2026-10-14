import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// 设置页要的两块：① 从 git 仓库检查/一键更新 ② 依赖体检 + 一键安装通道
// 全部走可注入的 run()，所以单测不需要真的执行 git / powershell。

export function defaultRun(args, opts) {
  return spawnSync(args[0], args.slice(1), Object.assign({ encoding: "utf8", windowsHide: true, timeout: 60000 }, opts || {}));
}

function out(r) { return r && r.status === 0 ? String(r.stdout || "").trim() : ""; }
function tail(s, n) { const t = String(s || "").trim().split(String.fromCharCode(10)); return t.slice(-(n || 12)).join(String.fromCharCode(10)); }

// ---------- ① git 更新 ----------
export function gitInfo(repoRoot, opts) {
  const o = opts || {};
  const run = o.run || defaultRun;
  const g = function (args) { return run(["git", "-C", repoRoot].concat(args), { cwd: repoRoot }); };
  const inside = out(g(["rev-parse", "--is-inside-work-tree"]));
  if (inside !== "true") return { isRepo: false, repoRoot: repoRoot };
  const dirtyList = String(out(g(["status", "--porcelain"])) || "").split(String.fromCharCode(10)).filter(Boolean);
  return {
    isRepo: true, repoRoot: repoRoot,
    branch: out(g(["rev-parse", "--abbrev-ref", "HEAD"])) || "",
    head: out(g(["rev-parse", "--short", "HEAD"])) || "",
    subject: out(g(["log", "-1", "--pretty=%s"])) || "",
    date: out(g(["log", "-1", "--pretty=%ci"])) || "",
    dirty: dirtyList.length > 0,
    dirtyFiles: dirtyList.slice(0, 20)
  };
}

export function checkUpdate(repoRoot, opts) {
  const o = opts || {};
  const run = o.run || defaultRun;
  const remote = o.remote || "origin";
  const branch = o.branch || "main";
  const info = gitInfo(repoRoot, { run: run });
  if (!info.isRepo) return { ok: false, isRepo: false, error: "这不是一个 git 仓库（分发版请手动下载新版覆盖）", info: info };
  const g = function (args) { return run(["git", "-C", repoRoot].concat(args), { cwd: repoRoot, timeout: 90000 }); };
  const fetched = g(["fetch", "--prune", remote]);
  if (!fetched || fetched.status !== 0) {
    return {
      ok: false, isRepo: true, info: info,
      error: "连不上远端仓库（检查网络/代理）",
      detail: tail((fetched && (fetched.stderr || fetched.stdout)) || "", 4)
    };
  }
  const counts = String(out(g(["rev-list", "--left-right", "--count", "HEAD..." + remote + "/" + branch])) || "").split(/\s+/);
  const ahead = Number(counts[0]) || 0;
  const behind = Number(counts[1]) || 0;
  const incoming = String(out(g(["log", "--oneline", "--no-decorate", "HEAD.." + remote + "/" + branch, "-n", "20"])) || "")
    .split(String.fromCharCode(10)).filter(Boolean);
  return {
    ok: true, isRepo: true, info: info,
    remote: remote, branch: branch,
    ahead: ahead, behind: behind,
    upToDate: behind === 0,
    canFastForward: info.dirty ? false : true,
    incoming: incoming,
    remoteHead: out(g(["rev-parse", "--short", remote + "/" + branch])) || ""
  };
}

export function applyUpdate(repoRoot, opts) {
  const o = opts || {};
  const run = o.run || defaultRun;
  const remote = o.remote || "origin";
  const branch = o.branch || "main";
  const before = gitInfo(repoRoot, { run: run });
  if (!before.isRepo) return { ok: false, error: "不是 git 仓库" };
  if (before.dirty) return { ok: false, error: "本地有未提交的改动，先处理干净再更新", dirtyFiles: before.dirtyFiles };
  const r = run(["git", "-C", repoRoot, "pull", "--ff-only", remote, branch], { cwd: repoRoot, timeout: 180000 });
  const ok = !!(r && r.status === 0);
  const after = gitInfo(repoRoot, { run: run });
  return {
    ok: ok,
    before: before.head, after: after.head,
    changed: before.head !== after.head,
    log: tail((r && (r.stdout || r.stderr)) || "", 12),
    error: ok ? null : tail((r && (r.stderr || r.stdout)) || "git pull 失败", 6),
    needRestart: ok && before.head !== after.head
  };
}

// ---------- ② 依赖体检 ----------
export const DEP_IDS = ["node", "dsh", "apikey", "napcat", "qq", "sapi", "ffmpeg", "sqlite", "git"];

export function createDepsProbe(opts) {
  const o = opts || {};
  const run = o.run || defaultRun;
  const env = o.env || process.env;
  const nowFn = o.now || function () { return Date.now(); };
  const cacheMs = o.cacheMs != null ? o.cacheMs : 20000;
  let cache = { at: 0, value: null };
  let sapiCache = null;

  function which(exe) {
    const r = run(["where", exe], {});
    const line = String((r && r.stdout) || "").split(String.fromCharCode(10))[0].trim();
    return r && r.status === 0 && line ? line : null;
  }
  function hasSqlite() {
    try { const req = o.requireFn || null; if (req) return !!req("node:sqlite"); } catch (e) {}
    return !!(o.sqliteAvailable != null ? o.sqliteAvailable : true);
  }
  function sapiVoices() {
    if (sapiCache != null) return sapiCache;
    if (process.platform !== "win32") { sapiCache = 0; return 0; }
    const r = run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices().Count"], { timeout: 30000 });
    const n = parseInt(String((r && r.stdout) || "0").trim(), 10);
    sapiCache = isNaN(n) ? 0 : n;
    return sapiCache;
  }
  // winget 装完只对**新开的 shell** 生效，所以 where 找不到时再按安装目录找一遍
  function findFfmpeg() {
    const w = which("ffmpeg");
    if (w) return w;
    if (o.run) return null;             // 注入了 run（测试）就只信它，别去扫真实磁盘，免得结果跟机器相关
    try {
      const home = env.LOCALAPPDATA || env.USERPROFILE || "";
      const base = path.join(home, "Microsoft", "WinGet", "Packages");
      let names = [];
      try { names = fs.readdirSync(base); } catch (e) { return null; }
      for (const n of names) {
        if (!/ffmpeg/i.test(n)) continue;
        const stack = [path.join(base, n)];
        while (stack.length) {
          const dir = stack.pop();
          let subs = [];
          try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
          for (const s of subs) {
            const p = path.join(dir, s.name);
            if (s.isDirectory()) stack.push(p);
            else if (s.name.toLowerCase() === "ffmpeg.exe") return p;
          }
        }
      }
    } catch (e) {}
    return null;
  }
  // STT 侧车在不在：直接看端口有没有人在听（netstat 是同步的，比异步探活省事）
  function portListening(port) {
    if (!port) return false;
    const r = run(["netstat", "-ano"], {});
    const out = String((r && r.stdout) || "");
    return new RegExp("[:.]" + port + "\\s").test(out);
  }
  let whisperCache = null;
  function hasWhisper() {
    if (whisperCache != null) return whisperCache;
    const r = run(["python", "-c", "import faster_whisper"], {});
    whisperCache = !!(r && r.status === 0);
    return whisperCache;
  }
  function findQq() {
    const cands = ["E:\\qq\\QQ.exe", "D:\\qq\\QQ.exe", "C:\\Program Files\\Tencent\\QQNT\\QQ.exe"];
    if (o.qqPaths) cands.unshift.apply(cands, o.qqPaths);
    for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
    return null;
  }

  function probe() {
    if (cache.value && nowFn() - cache.at < cacheMs) return cache.value;
    const major = parseInt(String(process.versions.node || "0").split(".")[0], 10) || 0;
    const dshCli = o.dshCli !== undefined ? o.dshCli : null;
    const napcatState = o.onebotState ? o.onebotState() : "unknown";
    const hasKey = o.hasApiKey ? o.hasApiKey() : false;
    const qq = findQq();
    const ff = findFfmpeg();
    const sttPort = (function () {
      try { const u = new URL(o.sttEndpoint || "http://127.0.0.1:8910/v1/audio/transcriptions"); return parseInt(u.port || "80", 10); }
      catch (e) { return 8910; }
    })();
    const sttOn = !!o.sttEnabled;
    const sttOk = portListening(sttPort);
    const whisper = hasWhisper();
    const sq = o.sqliteSupported ? o.sqliteSupported() : true;
    const gv = (() => { const r = run(["git", "--version"], {}); return out(r); })();

    const list = [
      { id: "node", name: "Node.js 运行时", required: true, ok: major >= 22, version: process.version,
        detail: major >= 22 ? "程序本体跑在这上面" : "版本太低（需要 ≥ 22）",
        fix: { kind: "url", value: "https://nodejs.org/zh-cn/download", note: "下载 LTS 装完重启程序" } },
      { id: "dsh", name: "DeepSeek Harness（大脑）", required: true, ok: !!dshCli, version: dshCli ? path.basename(dshCli) : null,
        detail: dshCli || "没找到 dsh.cmd——不装它小助手一句都回不了（本地判定照跑）",
        fix: { kind: "url", value: "https://github.com/deepseek-ai", note: "请从你获得 DSH 的渠道安装，然后在「调整 → 再装」或 app.json 里填 dsh 路径" } },
      { id: "apikey", name: "DeepSeek API Key", required: true, ok: !!hasKey, version: hasKey ? "已配置" : null,
        detail: hasKey ? "只存在本机 app/dsh-data/config/secrets.json" : "没配 key，大脑调不动",
        fix: { kind: "url", value: "https://platform.deepseek.com/api_keys", note: "建一把 key，然后 node demo/import-key.mjs 或用配置端填" } },
      { id: "napcat", name: "NapCat（收发 QQ）", required: true, ok: napcatState === "open", version: napcatState === "open" ? "已连接" : napcatState,
        detail: napcatState === "open" ? "OneBot 已连上" : "没连上——推荐用 NapCat.Shell（自带 QQ），装完填进「接入」页",
        fix: { kind: "url", value: "https://github.com/NapNeko/NapCatQQ/releases", note: "下 NapCat.Shell.zip，解压到独立目录，用小号扫码" } },
      { id: "qq", name: "QQ 客户端", required: false, ok: !!qq, version: qq ? qq : null,
        detail: qq ? "找到了本地 QQ" : "用 NapCat.Shell 的话不需要单独装 QQ",
        fix: { kind: "url", value: "https://im.qq.com/pcqq/", note: "别用主号挂机器人" } },
      { id: "sapi", name: "Windows 语音（TTS）", required: false, ok: sapiVoices() > 0, version: sapiVoices() ? sapiVoices() + " 个音色" : null,
        detail: sapiVoices() > 0 ? "系统自带 SAPI，离线合成语音（语音功能要用）" : "没检测到可用音色",
        fix: { kind: "manual", value: "Windows 设置 → 时间和语言 → 语音 → 添加语音包", note: "装上中文语音包即可" } },
      { id: "ffmpeg", name: "ffmpeg", required: false, ok: !!ff, version: ff || null,
        detail: ff ? "语音转码（QQ 语音是 amr，转写前要先转码）" : "没装——语音转文字要用它",
        fix: { kind: "winget", value: "Gyan.FFmpeg", note: "点一下后台用 winget 装" } },
      { id: "whisper", name: "faster-whisper（本机语音识别）", required: false, ok: whisper, version: whisper ? "已安装" : null,
        detail: whisper ? "本机转写引擎（模型另存，首次用会下载）" : "没装：python -m pip install faster-whisper",
        fix: { kind: "manual", value: "python -m pip install faster-whisper", note: "装完再起 STT 侧车" } },
      { id: "sttserver", name: "语音转写服务（STT 侧车）", required: false, ok: sttOk, version: sttOk ? "127.0.0.1:" + sttPort : null,
        detail: sttOk ? (sttOn ? "已就绪，配置里也开着" : "在跑——去配置端打开「语音转写」就生效") : (sttOn ? "配置开了，但服务没在跑" : "未启用（不影响其它功能）"),
        fix: { kind: "manual", value: "python tools/stt-server.py --model small", note: "本机转写，音频不出本机" } },
      { id: "sqlite", name: "node:sqlite", required: false, ok: !!sq, version: sq ? "可用" : null,
        detail: sq ? "读表情包图库的索引（index.db）要用" : "不可用——图库会退回按目录名扫",
        fix: { kind: "manual", value: "升级 Node 到 22.5+", note: "随 Node 自带" } },
      { id: "git", name: "git", required: false, ok: !!gv, version: gv || null,
        detail: gv ? "「一键更新」要靠它" : "没装 git —— 分发版可以手动下载新版覆盖",
        fix: { kind: "url", value: "https://git-scm.com/download/win", note: "装完重启程序" } }
    ];
    const value = {
      ok: true,
      items: list,
      missingRequired: list.filter(function (x) { return x.required && !x.ok; }).map(function (x) { return x.id; })
    };
    cache = { at: nowFn(), value: value };
    return value;
  }

  return { probe: probe, reset: function () { cache = { at: 0, value: null }; sapiCache = null; } };
}

// 一键安装：只认白名单动作，别让它变成任意命令执行
export function runDepFix(dep, opts) {
  const o = opts || {};
  const run = o.run || defaultRun;
  if (!dep || !dep.fix) return { ok: false, error: "没有可用的安装方式" };
  if (dep.fix.kind === "url") return { ok: true, open: dep.fix.value, note: dep.fix.note || "" };
  if (dep.fix.kind === "manual") return { ok: false, error: "需要手动处理：" + dep.fix.value, manual: true };
  if (dep.fix.kind === "winget") {
    const r = run(["winget", "install", "--id", String(dep.fix.value), "--accept-source-agreements", "--accept-package-agreements", "--silent"], { timeout: 300000 });
    const ok = !!(r && r.status === 0);
    return { ok: ok, output: tail((r && (r.stdout || r.stderr)) || "", 15), error: ok ? null : tail((r && (r.stderr || r.stdout)) || "winget 失败", 6) };
  }
  return { ok: false, error: "未知的安装方式：" + dep.fix.kind };
}
