import fs from "node:fs";
import path from "node:path";

import { loadConfig, runtimeConfig, redactConfig, loadFieldTable, saveConfig, defaultsFromTable, getPath } from "./src/config.js";
import { createStore } from "./src/store.js";
import { createBot } from "./src/index.js";
import { createOneBot, probePort } from "./src/onebot.js";
import { createRuntime } from "./src/runtime.js";
import { runBrain, ensureBrainProfile, resolveDshCli } from "./src/brain.js";
import { personaFromConfig } from "./src/dshprofile.js";
import { createAuditor, setAuditChannel, loadRubric } from "./src/audit.js";
import { createSearch, SEARCH_PROFILE_ID, SEARCH_PERSONA } from "./src/search.js";
import { createMemeLibrary } from "./src/meme.js";
import { createWebUi } from "./src/webui.js";
import { createVision, VISION_PERSONA } from "./src/vision.js";
import { createTts, voiceCapability, listSapiVoices } from "./src/tts.js";
import { visionCapability } from "./src/vision.js";
import { CONFIG_FILE, DATA_ROOT, BRAIN_TMP_DIR, WORKSPACE_ROOT, DSH_HOME } from "./src/paths.js";
import { pickApiKey } from "./src/secrets.js";
import { checkUpdate, applyUpdate, createDepsProbe, runDepFix } from "./src/update.js";
import { createPluginProbe, installPlugin } from "./src/plugins.js";
import { discover as discoverNapCat, syncPlan as napcatSyncPlan, applyAdopt as napcatApplyAdopt, readWebuiToken } from "./src/napcat.js";
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
// 配置端里"当前生效"的那份配置对象（保存后会是新对象）—— 探测类代码要读它，别读启动时那份
let activeCfg = cfg;

// NapCat 自动对接（N28）：从 NapCat 自己的 onebot11 配置里读出它认的地址与令牌，
// 自动补上/对齐 —— 两边令牌写岔正是"重启之后连不上"最常见的原因。
// 动手的边界：只有"读得到 NapCat 配置"时才动；地址相同时令牌以 NapCat 为准（它才是服务端），
// 地址不一样时只提醒、不乱改；读不到配置就退回手填。
let napcatCache = { at: 0, value: null };
function scanNapCat(force) {
  if (!force && napcatCache.value && Date.now() - napcatCache.at < 5000) return napcatCache.value;
  const v = discoverNapCat({
    launchPath: getPath(activeCfg, "napcat.launchPath"),
    configPath: getPath(activeCfg, "napcat.configPath"),
    workspaceRoot: WORKSPACE_ROOT
  });
  napcatCache = { at: Date.now(), value: v };
  return v;
}
// NapCat 的网页控制台（6099）与 OneBot 服务端（3001）到底通不通 —— 这两个一分开看，
// "连不上"就有结论了：控制台通、3001 不通 = NapCat 在跑但服务端没起来（多半是 QQ 没登录）。
function napcatHint(plan, onebotUp, webuiUp, cur) {
  if (onebotUp && plan.matched !== false) return "";
  if (onebotUp) return "端口通了、但两边令牌不一样 —— 点「从 NapCat 自动填入」对齐。";
  if (webuiUp) {
    return "NapCat 在跑（网页控制台通），但 OneBot 的 WebSocket 服务端没开："
      + "最常见是 QQ 还没登录 —— 用托盘菜单「显示 NapCat 窗口」把登录窗/扫码露出来；"
      + "也可能是当前登录的那个号自己那份 onebot11_<号>.json 里没启用 WebSocket 服务端（在 NapCat 控制台 → 网络配置里开）。";
  }
  return "NapCat 没在跑（" + (cur.url || "OneBot 端口") + " 和网页控制台 " + (getPath(activeCfg, "runtime.napcatWebui") || "http://127.0.0.1:6099") + " 都不通）"
    + " —— 用托盘菜单的「启动」或「只启动 NapCat」把它拉起来。";
}
async function napcatView(force) {
  const info = scanNapCat(!!force);
  const cur = onebotOpts(liveCfg || cfg);
  const plan = napcatSyncPlan({ url: cur.url, token: cur.token }, info);
  const webuiUrl = getPath(activeCfg, "runtime.napcatWebui") || "http://127.0.0.1:6099";
  const probes = await Promise.all([probePort(cur.url, 900), probePort(webuiUrl, 900)]);
  return Object.assign({ ok: true }, plan, {
    file: info.file, webuiTokenMasked: info.webuiTokenMasked, webuiFile: info.webuiFile, servers: info.servers,
    roots: info.roots, scanned: info.scanned, error: info.error || null,
    webuiUrl: webuiUrl, webuiUp: !!probes[1].ok, onebotUp: !!probes[0].ok, onebotPort: probes[0].port || null,
    hint: napcatHint(plan, !!probes[0].ok, !!probes[1].ok, cur)
  });
}

// 用户点「显示控制台登录令牌」时才把明文给前端（NapCat 控制台登录要手输一次，不给就只能翻文件）
function napcatReveal() {
  const info = scanNapCat(true);
  if (!info.webuiFile) return { ok: false, error: "没找到 NapCat 的 webui.json —— 它的网页控制台登录令牌就存在那个文件里", file: null };
  const token = readWebuiToken(info.webuiFile);
  if (!token) return { ok: false, error: "webui.json 里没有 token 字段", file: info.webuiFile };
  return { ok: true, token: token, file: info.webuiFile };
}
function syncNapCatOnBoot() {
  const info = scanNapCat(true);
  const cur = onebotOpts(cfg);
  const plan = napcatSyncPlan({ url: cur.url, token: cur.token }, info);
  const changed = napcatApplyAdopt(cfg, plan.adopt);
  if (changed.length) saveConfig(cfg, CONFIG_FILE);
  // 刚刚按 NapCat 对齐过（或本来就一致）都算"和 NapCat 一条心"
  const aligned = plan.matched === true || plan.adopt.token != null;
  return { plan: plan, changed: changed, info: info, aligned: aligned };
}
// 用户点「从 NapCat 自动填入」/「清空本机令牌」时用的显式对齐动作（写配置 + 立刻重连）
async function adoptNapCat(mode) {
  const info = scanNapCat(true);
  const cur = onebotOpts(liveCfg);
  if (String(mode) === "clear") {
    const changed = napcatApplyAdopt(liveCfg, { token: "" });
    saveConfig(liveCfg, CONFIG_FILE);
    const re = reconnectOnebot(liveCfg);
    log("NapCat 对接：清空本机令牌（" + (changed.join(" ") || "没有变化") + "）");
    return { ok: true, mode: "clear", changed: changed, reconnect: re, info: await napcatView(true) };
  }
  if (!info.found) return { ok: false, error: "没找到 NapCat 的 onebot11 配置文件 —— 先把「NapCat 启动程序路径」或「NapCat 配置文件路径」填对", info: await napcatView(false) };
  if (!info.server) return { ok: false, error: "NapCat 配置里没有启用的 WebSocket 服务端 —— 先去它网页控制台开一个", info: await napcatView(false) };
  const adopt = {};
  if (info.url && info.url !== cur.url) adopt.url = info.url;
  adopt.token = info.token || "";
  const changed = napcatApplyAdopt(liveCfg, adopt);
  saveConfig(liveCfg, CONFIG_FILE);
  const re = reconnectOnebot(liveCfg);
  log("NapCat 对接：按 NapCat 配置填入 " + (changed.join(" ") || "（没有变化）"));
  return { ok: true, mode: "napcat", changed: changed, reconnect: re, info: await napcatView(true) };
}
const napcatBoot = syncNapCatOnBoot();
log("NapCat 对接：" + (napcatBoot.plan.note || napcatBoot.plan.warn[0] || "没有可对齐的信息") + (napcatBoot.changed.length ? "（已写入配置：" + napcatBoot.changed.join(" ") + "）" : ""));
for (const w of napcatBoot.plan.warn) log("NapCat 提醒：" + w);
const rc = runtimeConfig(cfg);
// 能力声明：写进人设的"我看得到图 / 我能发语音"必须和这台机器真做得到的事一致。
// 音色只在开了语音时探一次（spawn 一次 PowerShell）。
const ttsVoices = rc.voice.enabled ? listSapiVoices() : null;
const voiceCap = voiceCapability(rc.voice, { voices: ttsVoices });
const visionCap = visionCapability(rc.vision);
const persona = personaFromConfig(cfg, { ttsVoices: ttsVoices });

log("模式：" + (rc.stageMode === "auto" ? "auto（新群观察 " + rc.observeUntilMessages + " 条 → 半自动 " + rc.semiAutoDays + " 天 → 全自动）" : rc.stageMode === "observe" ? "强制观察" : "直接实际发送"));
log("数据根：" + DATA_ROOT);
log("人设：" + persona.botName + " / " + persona.age);
log("接入：" + rc.onebot.wsUrl + (rc.onebot.token ? "（已带令牌）" : "（无令牌）") + (napcatBoot.aligned ? " · 与 NapCat 一致" : ""));
log("预算：日 " + rc.budget.dailyTokens + " token，超 " + (rc.budget.softRatio * 100) + "% 关主动");
log("搜索：通道 " + rc.searchMode.toUpperCase() + "（" + (rc.searchMode === "b" ? "DSH 独立调用" : "本机直搜") + "），外审：qq-audit / 8s 超时 → 不确定");
// 判定阈值直接打出来：配置端「调整」页改了到底有没有吃进去，看这一行就知道
log("判定阈值：开口线 " + rc.gates.bounds.lo + " / 灰区上界 " + rc.gates.bounds.hi
  + " / 三档线 " + rc.gates.tiers.speakAt + "·" + rc.gates.tiers.terseAt + "·" + rc.gates.tiers.detailedAt
  + " / 成本权重 λ " + rc.gates.weights.lambda
  + "（点名·求展开·问句另有「至少中档」的地板）");

const store = createStore(path.join(DATA_ROOT, "data"));
const bot = createBot({
  dataRoot: path.join(DATA_ROOT, "data"), botNames: [persona.botName], nicknames: [persona.botName],
  bounds: rc.gates.bounds, tiers: rc.gates.tiers, utilityWeights: rc.gates.weights,  // 判定阈值现在真的生效
  rescueAsk: rc.gates.rescueAsk, blockInjected: rc.gates.blockInjected, audit: rc.audit
});
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
      if (s.state !== "reconnecting" || (s.retry || 0) % 5 === 0) {
        const tail = (s.state === "closed" || s.state === "error") ? " @ " + o.url : "";
        log("onebot: " + s.state + (s.error ? " " + s.error : "") + (s.reason ? " ｜ " + s.reason : "") + (s.code != null && s.code !== 1000 ? "（" + s.code + "）" : "") + tail);
      }
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
  timeoutMs: (rc.audit && rc.audit.timeoutMs) || rc.auditTimeoutMs || 8000,
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
  // 判定为"没有视觉能力"时直接关掉这条通道：省一次没意义的调用，也避免"看了但没看到"的幻觉
  config: Object.assign({}, rc.vision, { mode: visionCap.capable ? rc.vision.mode : "off" }),
  runner: async function (req) {
    if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
    // 配置端改完立刻生效（人设是保存时就重写的，通道也别等到重启）
    const live = visionCapability(runtimeConfig(liveCfg).vision);
    if (!live.capable) return { ok: false, error: "当前识图模型没有视觉能力（" + live.source + "）" };
    ensureBrainProfile({ cliPath: cli, profile: req.profile, personaText: VISION_PERSONA });
    return runBrain({ cliPath: cli, profile: req.profile, promptText: req.promptText, timeoutMs: req.timeoutMs });
  }
});
// N18 语音：TTS 走 Windows 自带 SAPI（离线、零依赖）
const tts = createTts({ config: Object.assign({}, rc.voice, { enabled: rc.voice.enabled && voiceCap.capable }), outDir: path.join(DATA_ROOT, "voice") });
log("识图：" + (rc.vision.enabled ? rc.vision.mode + " / " + rc.vision.model : "关闭") + "；语音：" + (rc.voice.enabled ? rc.voice.voice : "关闭"));
log("能力声明 · 看图：" + (visionCap.enabled ? (visionCap.capable ? "会写进人设（" + visionCap.source + "）" : "不写进人设（" + visionCap.source + "：" + visionCap.note + "）") : "关闭")
  + "　发音：" + (voiceCap.enabled ? (voiceCap.capable ? "会写进人设（" + voiceCap.source + "：" + voiceCap.note + "）" : "不写进人设（" + voiceCap.source + "：" + voiceCap.note + "）") : "关闭")
  + "　听语音：不做转写（人设写死"听不到内容"）");
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
  napcatCache = { at: 0, value: null };      // 配置变了，NapCat 对齐情况要重新读
  // 接入类改动（WS 地址 / token）不需要重启：直接重建 OneBot 客户端
  const before = onebotOpts(liveCfg), after = onebotOpts(next);
  liveCfg = next;
  activeCfg = next;
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
  napcatInfo: napcatView, napcatAdopt: adoptNapCat, napcatReveal: napcatReveal,
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
  try { runtime.budget.flush(); } catch (e) {}          // 用量平时就攒着写，这里只是最后一次
  try { bot.saveState(); } catch (e) {}                // 学习权重同理
  if (link.ob) link.ob.close();
  clearInterval(timer);
  setTimeout(function () { process.exit(0); }, 200);
});
