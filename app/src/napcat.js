import fs from "node:fs";
import path from "node:path";
import { setPath } from "./config.js";

// N28 NapCat 自动对接：从 NapCat 自己的配置里读出它期望的 OneBot 地址与令牌，
// 让「接入」页能自动填入 —— 不用手抄 token，两边也不会写岔。
// 写岔的典型症状：客户端一直连不上（端口不通）或者连上就被顶掉（令牌不符）。
//
// NapCat.Shell 实测布局（版本号/宿主目录名会变，所以按相对结构找，不写死版本）：
//   <NapCat>\<宿主目录>\versions\<版本>\resources\app\napcat\config\onebot11_<QQ>.json
// 同目录下的 webui.json 是它网页控制台的登录令牌，顺手读出来给人看，省得去翻配置文件。

export const OB_CONFIG_RE = /^onebot11(_\d+)?\.json$/i;
export const DEFAULT_WS_URL = "ws://127.0.0.1:3001";
// 这些目录又大又不可能放 onebot 配置，兜底递归时直接跳过
const SKIP_DIRS = new Set(["node_modules", ".git", "cache", "logs", "static", "assets", "fonts", "worker", "native", "temp"]);

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function dirsOf(p) {
  try {
    return fs.readdirSync(p).map(function (n) { return path.join(p, n); }).filter(isDir);
  } catch (e) { return []; }
}
function filesOf(p, re) {
  try {
    return fs.readdirSync(p).map(function (n) { return path.join(p, n); }).filter(function (f) {
      if (re && !re.test(path.basename(f))) return false;
      try { return fs.statSync(f).isFile(); } catch (e) { return false; }
    });
  } catch (e) { return []; }
}

// 可能藏着 NapCat 的根目录：显式路径优先，然后是常见安装位置
export function candidateRoots(opts) {
  const o = opts || {};
  const roots = [];
  function push(p) {
    if (!p) return;
    let abs = "";
    try { abs = path.resolve(String(p)); } catch (e) { return; }
    for (const r of roots) if (r.toLowerCase() === abs.toLowerCase()) return;
    roots.push(abs);
  }
  const launch = o.launchPath && String(o.launchPath).trim();
  if (launch) {                                    // 从启动程序所在目录往上抬三层（exe 常在 bootmain/bin/shell 子目录里）
    let d = path.dirname(path.resolve(launch));
    for (let i = 0; i < 3 && d; i++) {
      push(d);
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  if (o.configPath) push(path.dirname(path.resolve(String(o.configPath))));
  if (o.workspaceRoot) push(path.join(String(o.workspaceRoot), "napcat"));   // 项目自带的 napcat/ 目录
  const drives = o.drives || ["E:", "D:", "C:"];
  for (const d of drives) for (const n of ["NapCat", "Napcat", "napcat"]) push(String(d) + path.sep + n);
  for (const r of (o.roots || [])) push(r);
  return roots;
}

// 在候选根目录下找 onebot11*.json。先按已知结构直取（快），找不到再浅层递归兜底。
export function findOnebotConfigs(roots, opts) {
  const o = opts || {};
  const maxDepth = o.maxDepth != null ? o.maxDepth : 6;
  const found = [];
  const seen = new Set();
  function add(file) {
    let abs = "";
    try { abs = path.resolve(file); } catch (e) { return; }
    const key = abs.toLowerCase();
    if (seen.has(key)) return;
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { return; }
    if (!st.isFile()) return;
    seen.add(key);
    found.push({ file: abs, mtime: st.mtimeMs, size: st.size });
  }
  function addDir(configDir) { for (const f of filesOf(configDir, OB_CONFIG_RE)) add(f); }
  function probe(root) {
    addDir(path.join(root, "config"));
    addDir(path.join(root, "napcat", "config"));
    addDir(path.join(root, "app", "napcat", "config"));
    addDir(path.join(root, "resources", "app", "napcat", "config"));
    for (const v of dirsOf(path.join(root, "versions"))) addDir(path.join(v, "resources", "app", "napcat", "config"));
    for (const host of dirsOf(root)) {              // 宿主目录再贴一层：<宿主>/versions/<ver>/...
      addDir(path.join(host, "config"));
      for (const v of dirsOf(path.join(host, "versions"))) addDir(path.join(v, "resources", "app", "napcat", "config"));
    }
  }
  for (const r of roots) probe(r);
  if (!found.length) for (const r of roots) walk(r, 0, maxDepth, add);
  return found.sort(function (a, b) { return b.mtime - a.mtime; });
}

function walk(dir, depth, maxDepth, add) {
  if (depth > maxDepth) return;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (const n of names) {
    if (SKIP_DIRS.has(n)) continue;
    const p = path.join(dir, n);
    let st = null;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) walk(p, depth + 1, maxDepth, add);
    else if (OB_CONFIG_RE.test(n)) add(p);
  }
}

// onebot11 json → 我们关心的那点结构（服务端列表）
export function parseOnebot(text) {
  let obj = null;
  try { obj = JSON.parse(String(text)); } catch (e) { return { ok: false, error: "配置文件不是合法 JSON" }; }
  const net = (obj && obj.network) || {};
  const raw = Array.isArray(net.websocketServers) ? net.websocketServers : [];
  const servers = raw.filter(function (s) { return s && typeof s === "object"; }).map(function (s) {
    return {
      name: s.name != null ? String(s.name) : "",
      host: (s.host != null && String(s.host)) ? String(s.host) : "127.0.0.1",
      port: Number(s.port) || 0,
      token: s.token == null ? "" : String(s.token),
      enable: s.enable !== false,                    // NapCat 里默认是开
      debug: s.debug === true
    };
  });
  return { ok: true, servers: servers };
}

export function readOnebotConfig(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return { ok: false, file: file, error: "读不到文件：" + String(e && e.message) }; }
  const p = parseOnebot(text);
  if (!p.ok) return { ok: false, file: file, error: p.error };
  return { ok: true, file: file, servers: p.servers };
}

export function wsUrlOf(server) {
  if (!server || !server.port) return "";
  const host = (server.host && server.host !== "0.0.0.0" && server.host !== "::") ? server.host : "127.0.0.1";
  return "ws://" + host + ":" + server.port;
}

// 挑一个服务端：优先"和本机配置同一个地址"的那个（同名不同端口的多份配置很常见），
// 否则取第一个启用的。
export function pickServer(servers, preferredUrl) {
  const list = (Array.isArray(servers) ? servers : []).filter(function (s) { return s.enable; });
  if (!list.length) return null;
  const want = String(preferredUrl || "").trim();
  if (want) {
    const hit = list.filter(function (s) { return wsUrlOf(s) === want; })[0];
    if (hit) return hit;
  }
  return list[0];
}

export function readWebuiToken(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    return obj && obj.token != null ? String(obj.token) : null;
  } catch (e) { return null; }
}

// 给前端的服务端清单：绝不带明文令牌，只带"有没有设"和形状
export function publicServer(s) {
  return {
    name: s.name, host: s.host, port: s.port, url: wsUrlOf(s), enable: s.enable, debug: s.debug,
    tokenSet: !!s.token, tokenMasked: maskToken(s.token)
  };
}

// 令牌是机密：给前端只回一个一眼能认出来的形状
export function maskToken(t) {
  const s = String(t == null ? "" : t);
  if (!s) return "";
  if (s.length <= 4) return s.charAt(0) + "…";
  return s.slice(0, 3) + "…" + s.slice(-2);
}

export function discover(opts) {
  const o = opts || {};
  const roots = (o.roots && o.roots.length) ? o.roots.map(function (r) { return path.resolve(String(r)); }) : candidateRoots(o);
  const files = o.files ? o.files.slice() : findOnebotConfigs(roots, { maxDepth: o.maxDepth });
  const out = {
    ok: true, found: false, file: null, server: null, url: "", token: "", tokenSet: false, tokenMasked: "",
    servers: [], extraServers: [], webuiFile: null, webuiToken: null, webuiTokenMasked: "",
    roots: roots, scanned: files.length, error: null, note: ""
  };
  if (!files.length) {
    out.note = "没找到 NapCat 的 onebot11 配置文件（找过 " + roots.length + " 个位置）";
    return out;
  }
  const picked = files[0];
  const conf = readOnebotConfig(picked.file);
  if (!conf.ok) { out.error = conf.error; out.note = conf.error + "：" + picked.file; return out; }
  out.found = true;
  out.file = picked.file;
  out.rawServers = conf.servers;                       // 只在进程内用，不进 API
  out.servers = conf.servers.map(publicServer);        // 给前端的那份：令牌只有形状
  const srv = pickServer(conf.servers, o.preferredUrl);
  out.server = srv;
  out.url = wsUrlOf(srv);
  out.token = srv ? srv.token : "";
  out.tokenSet = !!out.token;
  out.tokenMasked = maskToken(out.token);
  out.extraServers = conf.servers.filter(function (s) { return s !== srv; }).map(function (s) {
    const p = publicServer(s);
    return { name: p.name, url: p.url, enable: p.enable, tokenSet: p.tokenSet };
  });
  const wf = path.join(path.dirname(picked.file), "webui.json");
  if (fs.existsSync(wf)) {
    out.webuiFile = wf;
    out.webuiToken = readWebuiToken(wf);
    out.webuiTokenMasked = maskToken(out.webuiToken);
  }
  out.note = "找到 " + picked.file + (srv && srv.name ? "（" + srv.name + "）" : "");
  return out;
}

// 本机配置 vs NapCat 配置：算出"该自动补什么"和"要提醒用户什么"
export function syncPlan(current, info) {
  const cur = current || {};
  const curUrl = String(cur.url || "").trim();
  const curToken = String(cur.token == null ? "" : cur.token);
  const targetUrl = info && info.url ? String(info.url) : "";
  const targetToken = info && info.token != null ? String(info.token) : "";
  const notes = [];
  const plan = {
    found: !!(info && info.found),
    file: info ? info.file : null,
    url: targetUrl, tokenMasked: info ? info.tokenMasked : "",
    serverName: (info && info.server && info.server.name) || "",
    targetTokenSet: !!targetToken, oursTokenSet: !!curToken, oursUrl: curUrl,
    matched: null, adopt: {}, warn: [], note: "", action: "none",
    webuiTokenMasked: (info && info.webuiTokenMasked) || "",
    servers: (info && info.servers) || [], extraServers: (info && info.extraServers) || []
  };
  if (!plan.found) {
    plan.action = "manual";
    plan.note = "没找到 NapCat 的 onebot11 配置文件 —— 令牌只能手填（改过目录的话把「NapCat 配置文件路径」指过去）";
    plan.warn.push(plan.note);
    return plan;
  }
  if (!info.server) {
    plan.action = "napcat-off";
    plan.note = "NapCat 配置里没有启用的 WebSocket 服务端";
    plan.warn.push("NapCat 里没有启用的 WebSocket 服务端 —— 去 NapCat 网页控制台 → 网络配置 → OneBot 11 新建一个 WebSocket 服务端（端口 3001），再回来点重连");
    return plan;
  }
  const urlSame = !!targetUrl && targetUrl === curUrl;
  if (!urlSame && targetUrl) {
    if (!curUrl || curUrl === DEFAULT_WS_URL) { plan.adopt.url = targetUrl; notes.push("地址按 NapCat 填成 " + targetUrl); }
    else plan.warn.push("地址不一致：本机 " + curUrl + "，NapCat " + targetUrl);
  }
  if (targetToken === curToken) {
    plan.matched = true;
    notes.push(targetToken ? "地址与令牌都和 NapCat 一致" : "两边都没设令牌（一致）");
  } else if (targetToken && !curToken) {
    plan.adopt.token = targetToken;
    plan.matched = false;
    plan.action = "adopt";
    notes.push("本机没填令牌 → 按 NapCat 自动填入");
  } else if (!targetToken && curToken) {
    plan.matched = false;
    plan.action = "clear";
    plan.warn.push("NapCat 侧没设令牌，本机却填了 —— 两边要么都空、要么一样；点「清空本机令牌」可对齐");
  } else if (urlSame) {
    // 同一个服务端，令牌却不一样 —— NapCat 那份才是它认的，直接对齐
    plan.adopt.token = targetToken;
    plan.matched = false;
    plan.action = "align";
    notes.push("令牌与 NapCat 不一致（NapCat 是 " + info.tokenMasked + "）→ 按 NapCat 对齐");
  } else {
    plan.matched = false;
    plan.action = "align";
    plan.warn.push("令牌与 NapCat 不一致（NapCat 是 " + info.tokenMasked + "），地址也不一样 —— 先确认地址，再点「从 NapCat 自动填入」");
  }
  plan.note = notes.join("；");
  return plan;
}

export function applyAdopt(cfg, adopt) {
  const a = adopt || {};
  const changed = [];
  if (a.url) { setPath(cfg, "napcat.wsUrl", String(a.url)); changed.push("wsUrl=" + a.url); }
  if (a.token != null) { setPath(cfg, "napcat.token", String(a.token)); changed.push("token=" + maskToken(a.token)); }
  return changed;
}
