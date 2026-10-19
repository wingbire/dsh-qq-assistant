import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DSH_HOME, BRAIN_TMP_DIR } from "./paths.js";
import { pickApiKey } from "./secrets.js";
import { PROFILE_ID, ensureProfile, buildPersonaText, writeProfilePatch, writeAllTierOverlays } from "./dshprofile.js";

export { buildPersonaText };
export const PROFILE_DEFAULT = PROFILE_ID;   // N1/F-3 决策：与 profile 实际名字统一为 qq-brain
export const APP_NAME = "headless";
export const LAUNCH_LAYOUT = ["app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"];

const _launchCache = new Map();

export function layoutCliJs(binDir) {
  return path.resolve(binDir, "..", "..", "..", ...LAUNCH_LAYOUT);
}

export function parseCmdLauncher(cliPath) {
  try {
    const binDir = path.dirname(cliPath);
    const text = fs.readFileSync(cliPath, "utf8");
    const exeMatch = text.match(/"([^"]*\.exe)"/i);
    if (!exeMatch) return null;
    const exe = path.resolve(binDir, exeMatch[1].replace(/%~dp0/gi, binDir + path.sep));
    if (!fs.existsSync(exe)) return null;
    const rest = text.slice(text.indexOf(exeMatch[0]) + exeMatch[0].length);
    const jsMatch = rest.match(/"([^"]*\.js)"/i);
    const cliJs = jsMatch ? path.resolve(binDir, jsMatch[1].replace(/%~dp0/gi, binDir + path.sep)) : layoutCliJs(binDir);
    return { exe: exe, cliJs: cliJs, installRoot: path.dirname(exe), source: "cmd" };
  } catch (e) { return null; }
}

export function resolveDshLaunch(cliPath) {
  if (!cliPath) return null;
  const cached = _launchCache.get(cliPath);
  if (cached && Date.now() - cached.at < 60000) return cached.launch;
  const binDir = path.dirname(cliPath);
  let launch = null;
  if (/\.(cmd|bat)$/i.test(cliPath) && fs.existsSync(cliPath)) launch = parseCmdLauncher(cliPath);
  if (!launch) {
    const installRoot = path.resolve(binDir, "..", "..", "..", "..");
    const exe = path.join(installRoot, "DeepSeek Harness.exe");
    if (fs.existsSync(exe)) launch = { exe: exe, cliJs: layoutCliJs(binDir), installRoot: installRoot, source: "layout" };
  }
  if (!launch) {
    const exe = path.join(path.dirname(cliPath), "..", "..", "DeepSeek Harness.exe");
    if (fs.existsSync(exe)) launch = { exe: path.resolve(exe), cliJs: layoutCliJs(binDir), installRoot: path.dirname(path.resolve(exe)), source: "probe" };
  }
  _launchCache.set(cliPath, { at: Date.now(), launch: launch });
  return launch;
}

// 找 DSH 启动器：环境变量优先，其次 PATH，最后几个常见安装位置。
// 分发版不应该假设安装盘符。
export function resolveDshCli(env) {
  const e = env || process.env;
  const cands = [];
  if (e.DSHQQ_DSH_CLI) cands.push(e.DSHQQ_DSH_CLI);
  for (const p of String(e.PATH || "").split(path.delimiter)) {
    if (!p) continue;
    cands.push(path.join(p, "dsh.cmd"), path.join(p, "dsh.bat"), path.join(p, "dsh.exe"), path.join(p, "dsh"));
  }
  if (e.DSH_HOME) cands.push(path.join(e.DSH_HOME, "..", "dsh", "bin", "dsh.cmd"));
  const local = e.LOCALAPPDATA ? path.join(e.LOCALAPPDATA, "Programs") : null;
  if (local) cands.push(path.join(local, "DeepSeekHarness", "resources", "runtime", "cli", "bin", "dsh.cmd"));
  if (e.ProgramFiles) cands.push(path.join(e.ProgramFiles, "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"));
  // 装到别的盘根目录（例如 E:\DeepseekHarness）是常见的自定义安装位置。
  // 扫一遍盘根是通用做法（不写死任何一台机器的路径）；也可以直接用 brain.dshCliPath 指定。
  for (const drive of ["C:", "D:", "E:", "F:", "G:"]) {
    cands.push(drive + path.sep + "DeepseekHarness" + path.sep + "resources" + path.sep + "runtime" + path.sep + "cli" + path.sep + "bin" + path.sep + "dsh.cmd");
    cands.push(drive + path.sep + "DeepSeekHarness" + path.sep + "resources" + path.sep + "runtime" + path.sep + "cli" + path.sep + "bin" + path.sep + "dsh.cmd");
  }
  for (const c of cands) {
    try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (err) {}
  }
  return null;
}

export function killTree(child) {
  if (!child) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    }
  } catch (e) {}
  try { child.kill("SIGKILL"); } catch (e) {}
}

export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

export function accumulateUsage(usage, u) {
  if (!u) return usage;
  usage.inputTokens += Number(u.inputTokens || 0);
  usage.outputTokens += Number(u.outputTokens || 0);
  usage.cacheReadTokens += Number(u.cacheReadTokens || 0);
  usage.cacheWriteTokens += Number(u.cacheWriteTokens || 0);
  usage.totalTokens += Number(u.totalTokens || 0);
  return usage;
}

export function cacheHitRate(u) {
  if (!u) return 0;
  const cacheable = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  if (cacheable <= 0) return 0;
  return u.cacheReadTokens / cacheable;
}

export const DEPTH_POLICY_DEFAULT = {
  low:  { callBrain: false, model: "deepseek-flash", reasoningEffort: "off",  search: 0, maxChars: 30,  contextWindow: 0 },
  mid:  { callBrain: true,  model: "deepseek-flash", reasoningEffort: "low",  search: 0, maxChars: 100,  contextWindow: 20 },   // N22：搜不搜由搜索闸门按信号决定，这里只是兜底
  high: { callBrain: true,  model: "deepseek-flash", reasoningEffort: "high", search: 1, maxChars: 250, contextWindow: 20 }
};

export function depthPolicy(depth, cfg) {
  const c = cfg || {};
  // 按档位深合并：配置只想改某一档的 maxChars 时，不能把那一档的 model/effort/search 冲掉
  const over = (c.depthPolicy || {})[depth] || {};
  const one = Object.assign({}, DEPTH_POLICY_DEFAULT[depth] || DEPTH_POLICY_DEFAULT.mid, over);
  const cw = c.contextWindow != null ? c.contextWindow : one.contextWindow;
  return Object.assign({}, one, { contextWindow: cw });
}

export function buildTaskText(depth, policy, keywords) {
  const lines = [];
  lines.push("【本轮任务】");
  lines.push("档位：" + (depth === "high" ? "详细" : depth === "mid" ? "总结" : "短评"));
  lines.push("字数上限：" + policy.maxChars);
  lines.push("搜索次数：" + policy.search + (policy.search ? "；关键词：" + (keywords || []).join("、") : "（凭已有知识回答，不要编造实时信息）"));
  lines.push("要专门回某一条消息（而不是顺着聊）时，在正文里写 [引用]；别人 @ 你则不用。");
  lines.push("直接输出要发到群里的正文，不要解释。");
  return lines.join(String.fromCharCode(10));
}

// 真实 headless CLI 的事件形状（2026-10-14 实测）：
//   {"type":"session","sessionId":"..."}
//   {"type":"status","phase":"turn_start"|"step_start"|"step_end"|"turn_end", ...}
//   {"type":"thinking","text":""}
//   {"type":"text","text":"..."}          ← 流式片段
//   {"type":"final","text":"..."}         ← 最终正文
// mock CLI 会直接吐一行裸文本 —— 保留兜底，避免 demo 失效。
export function parseEvents(stdout) {
  const usage = emptyUsage();
  const finals = [];
  const texts = [];
  const plain = [];
  let sessionId = null;
  let steps = 0;
  let error = null;
  for (const raw of String(stdout || "").split(String.fromCharCode(10))) {
    const line = raw.trim();
    if (!line) continue;
    let e = null;
    if (line.startsWith("{")) { try { e = JSON.parse(line); } catch (err) { e = null; } }
    if (!e) { plain.push(line); continue; }
    if (e.sessionId) sessionId = e.sessionId;
    if (e.type === "status" && e.phase === "step_end") { steps += 1; accumulateUsage(usage, e.usage); }
    else if (e.type === "status" && e.phase === "turn_end" && e.reason && e.reason.kind === "error") {
      error = (e.reason.error && (e.reason.error.message || e.reason.error.code)) || "turn_end error";
    }
    else if (e.type === "final" && typeof e.text === "string") finals.push(e.text);
    else if (e.type === "text" && typeof e.text === "string") texts.push(e.text);
    else if ((e.type === "message" || e.type === "result") && typeof e.text === "string") texts.push(e.text);
  }
  const text = finals.length ? finals.join(String.fromCharCode(10))
    : texts.length ? texts.join("")
    : plain.join(String.fromCharCode(10));
  return { text: String(text).trim(), usage: usage, sessionId: sessionId, steps: steps, error: error };
}

export function buildArgs(o) {
  const launch = o.launch;
  const args = ["--expose-internals", launch.cliJs, "--profile", o.profile];
  // --patch 是启动器级参数，必须排在 app 名（headless）之前
  for (const p of (o.patchFiles || [])) args.push("--patch", p);
  args.push(o.appName);
  if (o.json !== false) args.push("--json");
  args.push(o.promptText || "");
  for (const extra of (o.extraArgs || [])) args.push(extra);
  return args;
}

export function brainEnv(o) {
  const opts = o || {};
  const env = Object.assign({}, process.env, opts.env || {});
  // 【关键】官方 dsh.cmd 就是先 set ELECTRON_RUN_AS_NODE=1 再跑 DeepSeek Harness.exe。
  // 少了这个变量，exe 会以 Electron GUI 启动 —— 每判定一条消息，DSH 窗口就弹到最前一次。
  // 设上之后同一个 exe 以纯 Node 模式跑，完全无窗口（而且它读得到 app.asar 里的 cli.js）。
  env.ELECTRON_RUN_AS_NODE = "1";
  env.DSH_HOME = opts.dshHome || DSH_HOME;          // N1：profile 与状态落工作区，零写入 ~/.dsh
  // apiKey 语义：undefined = 自动取（工作区文件 > 环境变量）；null = 明确不要；字符串 = 就用它
  const key = opts.apiKey === undefined ? pickApiKey() : opts.apiKey;
  if (key) env.DEEPSEEK_API_KEY = key;              // 凭据只经环境变量传给子进程
  return env;
}

export function runBrain(opts) {
  const o = opts || {};
  return new Promise(function (resolve) {
    const launch = o.overrideLaunch || resolveDshLaunch(o.cliPath || resolveDshCli());
    if (!launch) return resolve({ ok: false, error: "找不到 DSH 启动器（cliPath 无效）", usage: emptyUsage(), cacheHitRate: 0 });
    const profile = o.profile || PROFILE_DEFAULT;
    const appName = o.appName || APP_NAME;
    const args = buildArgs({ launch: launch, profile: profile, appName: appName, promptText: o.promptText, json: o.json, extraArgs: o.extraArgs, patchFiles: o.patchFiles });

    const mode = o.outputMode || "file";
    let outFd = null, errFd = null, outPath = null, errPath = null, child = null;
    let done = false;

    function finish(code, forcedErr) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let out = "", err = "";
      try { if (outPath) out = fs.readFileSync(outPath, "utf8"); } catch (e) {}
      try { if (errPath) err = fs.readFileSync(errPath, "utf8"); } catch (e) {}
      const parsed = parseEvents(out);
      const errText = forcedErr || parsed.error || (code === 0 ? null : "退出码 " + code + (err ? " :: " + err.slice(0, 200) : ""));
      resolve({
        ok: (code === 0 || code === null) && !forcedErr && !parsed.error,
        code: code, error: errText || null,
        text: parsed.text, usage: parsed.usage, cacheHitRate: cacheHitRate(parsed.usage),
        sessionId: parsed.sessionId, steps: parsed.steps, stdoutBytes: out.length, stderr: err
      });
      try { if (outPath) fs.unlinkSync(outPath); } catch (e) {}
      try { if (errPath) fs.unlinkSync(errPath); } catch (e) {}
    }

    const timer = setTimeout(function () { killTree(child); finish(null, "超时 " + (o.timeoutMs || 60000) + "ms"); }, o.timeoutMs || 60000);

    let stdio = "pipe";
    try {
      if (mode === "file") {
        const dir = o.outputDir || BRAIN_TMP_DIR;
        fs.mkdirSync(dir, { recursive: true });
        const stamp = Date.now() + "-" + Math.floor(Math.random() * 1e6);
        outPath = path.join(dir, "dsh-brain-" + stamp + ".out");
        errPath = path.join(dir, "dsh-brain-" + stamp + ".err");
        outFd = fs.openSync(outPath, "w");
        errFd = fs.openSync(errPath, "w");
        stdio = ["ignore", outFd, errFd];
      }
    } catch (e) { return finish(null, "创建输出文件失败: " + String(e && e.message)); }

    try {
      // 【重要】别用 DeepSeek Harness.exe 起子进程：那是 Electron 启动器，
      // 每起一次都会抢焦点/闪一下窗口（用户实测：她想事情的时候窗口会弹一下）。
      // args 的形状是 ["--expose-internals", cliJs, "--profile", ...]，用 node 直跑完全一致，
      // 纯控制台进程 + windowsHide 就彻底没有窗口。拿不到 cliJs 时才退回 exe。
      const nodeExe = process.execPath;
      const canNode = !!(launch.cliJs && fs.existsSync(launch.cliJs) && /node(\.exe)?$/i.test(nodeExe));
      const exe = canNode ? nodeExe : launch.exe;
      child = spawn(exe, args, { windowsHide: true, stdio: stdio, env: brainEnv(o) });
    } catch (e) { return finish(null, "spawn 失败: " + String(e && e.message)); }

    if (mode === "pipe") {
      let out = "", err = "";
      child.stdout.on("data", function (d) { out += d.toString(); });
      child.stderr.on("data", function (d) { err += d.toString(); });
      child.on("close", function (code) { finish(code); });
    } else {
      child.on("close", function (code) { finish(code); });
    }
    child.on("error", function (e) { finish(null, "进程错误: " + String(e && e.message)); });
  });
}

// 首次运行：确保工作区内的工作 profile 存在，并把当前人设灌进 personaPrefix。
export function ensureBrainProfile(opts) {
  const o = opts || {};
  const launch = o.overrideLaunch || resolveDshLaunch(o.cliPath || resolveDshCli());
  if (!launch) return { ok: false, error: "找不到 DSH 启动器" };
  const dshHome = o.dshHome || DSH_HOME;
  const profileId = o.profile || PROFILE_DEFAULT;
  const r = ensureProfile({ dshHome: dshHome, profileId: profileId, launch: launch, timeoutMs: o.timeoutMs });
  if (!r.ok) return r;
  const personaText = o.personaText != null ? String(o.personaText) : buildPersonaText(o.persona);
  // 模型通道：不传就维持官方默认；传了（社区插件 Our Free Model）就连 patch 带三档一起改
  const model = o.model || null;
  const tierBase = Object.assign(
    {},
    model ? { provider: model.provider, model: model.model, reasoningEffort: null } : {},
    o.efforts ? { efforts: o.efforts } : {}          // 三档思考强度（配置端可调）
  );
  const file = writeProfilePatch(dshHome, profileId, personaText, null, model);
  const tiers = writeAllTierOverlays(dshHome, profileId, tierBase);
  return { ok: true, created: r.created, dir: r.dir, patch: file, tiers: tiers };
}
