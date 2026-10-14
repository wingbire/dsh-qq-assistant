import fs from "node:fs";
import path from "node:path";

import { loadConfig, runtimeConfig, redactConfig, loadFieldTable, saveConfig, defaultsFromTable, getPath } from "./src/config.js";
import { createStore } from "./src/store.js";
import { createBot } from "./src/index.js";
import { createOneBot } from "./src/onebot.js";
import { createRuntime } from "./src/runtime.js";
import { runBrain, ensureBrainProfile, resolveDshCli } from "./src/brain.js";
import { personaFromConfig } from "./src/dshprofile.js";
import { createAuditor, setAuditChannel, loadRubric } from "./src/audit.js";
import { createSearch, SEARCH_PROFILE_ID, SEARCH_PERSONA } from "./src/search.js";
import { createMemeLibrary } from "./src/meme.js";
import { createWebUi } from "./src/webui.js";
import { createVision, VISION_PERSONA } from "./src/vision.js";
import { createTts } from "./src/tts.js";
import { CONFIG_FILE, DATA_ROOT, BRAIN_TMP_DIR, WORKSPACE_ROOT, DSH_HOME } from "./src/paths.js";
import { pickApiKey } from "./src/secrets.js";
import { checkUpdate, applyUpdate, createDepsProbe, runDepFix } from "./src/update.js";
import { createPluginProbe, installPlugin } from "./src/plugins.js";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const selftest = args.includes("--selftest");
const tickMs = Number((args.find(function (a) { return a.indexOf("--tick=") === 0; }) || "").split("=")[1]) || 500;

function log() {
  const a = Array.prototype.slice.call(arguments);
  console.log("[" + new Date().toISOString().slice(11, 19) + "] " + a.join(" "));
}

log("DSH-QQ 群小助手 启动");
const table = loadFieldTable();
let cfg = loadConfig({ table: table });
if (!fs.existsSync(CONFIG_FILE)) { saveConfig(cfg, CONFIG_FILE); log("已生成默认配置：" + CONFIG_FILE); }
const rc = runtimeConfig(cfg);
const persona = personaFromConfig(cfg);

log("模式：" + (rc.stageMode === "auto" ? "auto（新群观察 " + rc.observeUntilMessages + " 条 → 半自动 " + rc.semiAutoDays + " 天 → 全自动）" : rc.stageMode === "observe" ? "强制观察" : "直接实际发送"));
log("数据根：" + DATA_ROOT);
log("人设：" + persona.botName + " / " + persona.age);
log("接入：" + rc.onebot.wsUrl + "（N7 占位，等真实参数）");
log("预算：日 " + rc.budget.dailyTokens + " token，超 " + (rc.budget.softRatio * 100) + "% 关主动");
log("搜索：通道 " + rc.searchMode.toUpperCase() + "（" + (rc.searchMode === "b" ? "DSH 独立调用" : "本机直搜") + "），外审：qq-audit / 8s 超时 → 不确定");

const store = createStore(path.join(DATA_ROOT, "data"));
const bot = createBot({ dataRoot: path.join(DATA_ROOT, "data"), botNames: [persona.botName], nicknames: [persona.botName] });
const cli = resolveDshCli();
const boot = ensureBrainProfile({ cliPath: cli, persona: persona, personaText: (String(getPath(cfg, "persona.globalText") || "").trim() || undefined), model: channelModel("brain", cfg) });
log("大脑 profile：" + JSON.stringify({ ok: boot.ok, patch: boot.patch || null, error: boot.error || null }));

// OneBot 客户端做成可重建的：改完接入设置点「重连」就能立刻生效，不用重启程序
const link = { ob: null };
let liveCfg = cfg;                      // 配置端改过的配置（内存里这份才是"当前"）
function onebotOpts(c) {
  const r = runtimeConfig(c);
  return { url: r.onebot.wsUrl, token: r.onebot.token, reconnectMs: r.onebot.reconnectMs };
}
function buildOneBot(c) {
  const o = onebotOpts(c);
  return createOneBot({
    url: o.url, token: o.token, reconnectMs: o.reconnectMs,
    onEvent: function (evt) { runtime.onEvent(evt); },
    onStatus: function (s) {
      if (s.state === "rejected") { log("onebot: 被服务端拒绝 —— " + s.message + "（retcode " + s.retcode + "）"); return; }
      if (s.state !== "reconnecting" || (s.retry || 0) % 5 === 0) log("onebot: " + s.state + (s.error ? " " + s.error : ""));
    },
    onRejected: function (info) { log("onebot: 服务端说 " + info.message + "（把 token 抄对，或干脆在 NapCat 里留空）"); }
  });
}
function reconnectOnebot(c) {
  const next = c || liveCfg;
  liveCfg = next;
  const o = onebotOpts(next);
  try { if (link.ob) link.ob.close(); } catch (e) {}
  link.ob = buildOneBot(next);
  link.ob.connect();
  log("onebot: 重新连接 " + o.url + (o.token ? "（带 token）" : "（无 token）"));
  return { ok: true, url: o.url, tokenSet: !!o.token, state: link.ob.state() };
}
reconnectOnebot(cfg);

// N11 外审通道：独立 qq-audit profile，超时 → 不确定
// 走官方模型时 8 秒够用；走 Our Free Model 的免费池要放宽（实测约 13 秒），所以做成可配
const auditor = createAuditor({
  timeoutMs: rc.auditTimeoutMs || 8000,
  rubric: loadRubric(),
  runner: async function (req) {
    if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
    ensureBrainProfile({ cliPath: cli, profile: req.profile, personaText: req.personaText, model: channelModel("audit") });
    return runBrain({ cliPath: cli, profile: req.profile, promptText: req.promptText, timeoutMs: req.timeoutMs });
  }
});
setAuditChannel(auditor);

// N12 搜索：默认 C（本机直搜，零模型调用）；B 走独立的 qq-search profile
const searchSvc = createSearch({
  mode: rc.searchMode,
  freeSearchEnabled: rc.plugins ? rc.plugins.freeSearch : true,
  freeSearchEngine: rc.plugins ? rc.plugins.freeSearchEngine : "bing",
  brainSearch: async function (req) {
    if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
    ensureBrainProfile({ cliPath: cli, profile: SEARCH_PROFILE_ID, personaText: SEARCH_PERSONA });
    const r = await runBrain({ cliPath: cli, profile: SEARCH_PROFILE_ID, promptText: "搜索这几个关键词并总结：" + req.query, timeoutMs: 30000 });
    if (!r.ok) return { ok: false, error: r.error, usage: r.usage };
    return { ok: true, summary: r.text, usage: r.usage };
  }
});

// N15 图库：直接读 dsh-meme 的图库（sqlite index.db）
const memes = createMemeLibrary({});
log("图库：" + (memes.ready ? memes.rows.length + " 张 / " + memes.tags().length + " 个情绪标签 @ " + memes.packDir : "没找到（配图会跳过）"));

// N18 识图：独立一次多模态调用（http 直连 / dsh 跑 Our Free Model）
const vision = createVision({
  config: rc.vision,
  runner: async function (req) {
    if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
    ensureBrainProfile({ cliPath: cli, profile: req.profile, personaText: VISION_PERSONA });
    return runBrain({ cliPath: cli, profile: req.profile, promptText: req.promptText, timeoutMs: req.timeoutMs });
  }
});
// N18 语音：TTS 走 Windows 自带 SAPI（离线、零依赖）
const tts = createTts({ config: rc.voice, outDir: path.join(DATA_ROOT, "voice") });
log("识图：" + (rc.vision.enabled ? rc.vision.mode + " / " + rc.vision.model : "关闭") + "；语音：" + (rc.voice.enabled ? rc.voice.voice : "关闭"));
log("NapCat 配置页：" + rc.napcatWebui + "（配置端右上角有快捷入口）");

const runtime = createRuntime({
  config: cfg, runtime: rc, store: store, bot: bot, search: searchSvc, memes: memes, vision: vision, tts: tts,
  imageDir: path.join(BRAIN_TMP_DIR, "images"),
  sendRecord: function (gid, file) { log("→语音 " + gid + " : " + path.basename(file)); return link.ob ? link.ob.sendGroupRecord(gid, file) : false; },
  sendImage: function (gid, file) { log("→图 " + gid + " : " + path.basename(file)); return link.ob ? link.ob.sendGroupImage(gid, file) : false; },
  evtDefaults: { botNames: [persona.botName], nicknames: [persona.botName], interests: persona.interests, dislikes: persona.dislikes },
  send: function (gid, text) { log("→ " + gid + " : " + text); return link.ob ? link.ob.sendGroupMsg(gid, text) : false; },
  askBrain: async function (o) {
    if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
    return runBrain({ cliPath: cli, promptText: o.promptText, timeoutMs: 60000 });
  },
  log: log
});

// N25 配置端：本地 HTTP 服务，只听 127.0.0.1
// 配置端要能看 OneBot/NapCat 的真实状态与群列表，所以给它两个探测函数（带短缓存，别把 OneBot 打爆）
let obCache = { at: 0, value: null };
async function probeOnebot(force) {
  if (!force && obCache.value && Date.now() - obCache.at < 5000) return obCache.value;
  const obc = link.ob;
  const o2 = onebotOpts(liveCfg);
  const v = {
    state: obc ? obc.state() : "idle", selfId: obc ? obc.selfId() : null,
    url: obc ? obc.url() : null,                             // 运行中的客户端实际在连哪个地址
    tokenSet: obc ? obc.tokenSet() : false,
    savedUrl: o2.url, savedTokenSet: !!o2.token,             // 配置里现在存的是哪个
    online: false, good: false, version: null, nickname: null, protocol: null, error: null, at: Date.now()
  };
  if (obc && obc.lastMessage && obc.lastMessage()) {
    const lm = obc.lastMessage();
    v.error = lm.message + "（retcode " + lm.retcode + "）";
  }
  if (obc && obc.state() === "open") {
    const st = await obc.callActionAsync("get_status", {}, 4000);
    const li = await obc.callActionAsync("get_login_info", {}, 4000);
    const vi = await obc.callActionAsync("get_version_info", {}, 4000);
    v.online = !!(st.ok && st.data && st.data.online);
    v.good = !!(st.data && st.data.good);
    v.error = st.ok ? null : (st.error || "get_status 失败");
    if (li.ok && li.data) { v.selfId = String(li.data.user_id); v.nickname = li.data.nickname || null; }
    if (vi.ok && vi.data) {
      v.version = (vi.data.app_name || "NapCat") + " " + (vi.data.app_version || "?");
      v.protocol = vi.data.protocol_version ? String(vi.data.protocol_version) : null;
    }
  }
  obCache = { at: Date.now(), value: v };
  return v;
}
async function listGroups() {
  if (!link.ob || link.ob.state() !== "open") return [];
  const r = await link.ob.callActionAsync("get_group_list", {}, 6000);
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data.map(function (g) {
    return { group_id: String(g.group_id), group_name: g.group_name || "", member_count: g.member_count, max_member_count: g.max_member_count };
  });
}

// API 通道：大脑与二判都可以选择走社区插件 Our Free Model（provider 固定为 our-free-model）
const OFM_PROVIDER = "our-free-model";
// 实测可用的免费车道（OpenCode 那条车道会指纹识别客户端，不能用；sealIds 那条要登录）
const OFM_FALLBACK_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
function channelModel(kind, c) {
  const conf = (c || (webui ? webui.getConfig() : cfg)) || {};
  const p = conf.plugins || {};
  if (kind === "brain") {
    if (!p.ourFreeModelBrain) return null;
    return { provider: OFM_PROVIDER, model: p.ourFreeModelBrainId || OFM_FALLBACK_MODEL };
  }
  if (!p.ourFreeModel) return null;
  return { provider: OFM_PROVIDER, model: p.ourFreeModelId || OFM_FALLBACK_MODEL };
}

// 人设改了要立刻重渲染 profile 里的 personaPrefix（下一轮大脑调用生效），否则改了要等重启
async function onConfigSaved(next) {
  // 接入类改动（WS 地址 / token）不需要重启：直接重建 OneBot 客户端
  const before = onebotOpts(liveCfg), after = onebotOpts(next);
  liveCfg = next;
  let linkNote = null;
  if (before.url !== after.url || before.token !== after.token) {
    linkNote = reconnectOnebot(next);
    log("接入设置变了 → 已自动重连：" + after.url);
  }
  if (!cli) return { ok: false, error: "找不到 DSH 启动器，改完要重启程序才生效", reconnect: linkNote };
  const p = personaFromConfig(next);
  const text = String(getPath(next, "persona.globalText") || "").trim();
  const r = ensureBrainProfile({ cliPath: cli, persona: p, personaText: text || undefined, model: channelModel("brain", next) });
  if (!r.ok) return { ok: false, error: r.error || "写 profile 失败", reconnect: linkNote };
  return { ok: true, source: text ? "手写的全局人设" : "按字段拼装", patch: r.patch, reconnect: linkNote };
}

// 设置页：git 更新 + 依赖体检（依赖探测里有些要起进程，内部有 20 秒缓存）
const depsProbe = createDepsProbe({
  dshCli: cli,
  onebotState: function () { return link.ob ? link.ob.state() : "idle"; },
  hasApiKey: function () { return !!pickApiKey(); },
  requireFn: _require,
  qqPaths: cfg && cfg.runtime && cfg.runtime.qqPaths ? cfg.runtime.qqPaths : undefined
});
async function doCheckUpdate() {
  try { return checkUpdate(WORKSPACE_ROOT); } catch (e) { return { ok: false, error: String(e && e.message) }; }
}
async function doApplyUpdate() {
  try { return applyUpdate(WORKSPACE_ROOT); } catch (e) { return { ok: false, error: String(e && e.message) }; }
}
let depFixLock = false;
async function doDepFix(id) {
  if (depFixLock) return { ok: false, error: "上一个安装还没结束" };
  const probe = depsProbe.probe();
  const dep = (probe.items || []).filter(function (x) { return x.id === id; })[0];
  if (!dep) return { ok: false, error: "未知依赖：" + id };
  depFixLock = true;
  try { return runDepFix(dep); }
  finally { depFixLock = false; depsProbe.reset(); }
}

// 社区插件兼容：探测 + 一键安装（动作写死在 plugins.js 的白名单里）
const VENDOR_DIR = path.join(WORKSPACE_ROOT, "vendor");
const pluginProbe = createPluginProbe({
  dshHome: DSH_HOME, vendorDir: VENDOR_DIR, memeLib: memes,
  config: function () { return webui ? webui.getConfig() : cfg; }
});
let pluginLock = false;
async function doPluginInstall(id) {
  if (pluginLock) return { ok: false, error: "上一个安装还没结束" };
  pluginLock = true;
  try { return installPlugin(id, { dshHome: DSH_HOME, vendorDir: VENDOR_DIR }); }
  finally { pluginLock = false; }
}

const webui = createWebUi({
  config: cfg, table: table, store: store, memes: memes, runtime: runtime, labels: runtime.labels,
  plugins: async function () { return pluginProbe.probe(); }, installPlugin: doPluginInstall,
  configFile: CONFIG_FILE, probeOnebot: probeOnebot, listGroups: listGroups, onConfigSaved: onConfigSaved,
  checkUpdate: doCheckUpdate, applyUpdate: doApplyUpdate, depsProbe: async function () { return depsProbe.probe(); }, depFix: doDepFix,
  reconnect: function () { return reconnectOnebot(liveCfg); }
});

if (selftest) {
  if (rc.webuiEnabled) {
    const info = await webui.listen(0);
    const probe = await fetch(info.url + "/api/status").then(function (r) { return r.json(); }).catch(function () { return null; });
    log("配置端自检：" + info.url + "  /api/status ok=" + !!(probe && probe.ok) + "  /api/config 分组=" + table.分组.length);
    await webui.close();
  } else {
    log("配置端：已停用");
  }
  const st = runtime.status();
  log("自检通过：" + JSON.stringify({ mode: st.mode, onebotState: link.ob ? link.ob.state() : "idle", config: redactConfig(cfg, table).runtime || null }));
  const ls = runtime.labelStatus();
  log("学习：待标注 " + (ls ? ls.pending : 0) + " 条 / 已标注 " + (ls ? ls.labeled : 0) + " 条（满 " + (ls ? ls.minSamples : 30) + " 条自动回流标定）");
  log("配置片断：" + JSON.stringify({ persona: redactConfig(cfg, table).persona, napcat: redactConfig(cfg, table).napcat }));
  process.exit(0);
}

if (rc.webuiEnabled) {
  webui.listen(rc.webuiPort).then(function (info) { log("配置端：" + info.url); })
    .catch(function (e) { log("配置端启动失败：" + e.message); });
}

const timer = setInterval(function () { runtime.tick().catch(function (e) { log("tick 失败：" + e.message); }); }, tickMs);
if (timer.unref) timer.unref();
setInterval(function () {
  const s = runtime.status();
  log("状态 " + JSON.stringify(Object.assign({}, s.stats, { 待定反馈: runtime.pendingFeedback(), 预算: s.budget.mode, 阶段: "按群" })));
}, 30000);

process.on("SIGINT", function () {
  log("收到 SIGINT，收尾中…");
  runtime.budget.save(path.join(DATA_ROOT, "data", "budget.json"));
  store.saveBandit({ state: bot.bandit.state(), at: new Date().toISOString() });
  if (link.ob) link.ob.close();
  clearInterval(timer);
  setTimeout(function () { process.exit(0); }, 200);
});
