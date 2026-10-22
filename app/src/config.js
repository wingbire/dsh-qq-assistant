import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, CONFIG_FILE, CONFIG_DIR, ensureDir } from "./paths.js";

// 配置契约：prompts/配置端字段表.json 就是 schema（其「说明」原本就这么写）。
// 运行期用户配置覆盖在 <程序目录>/dsh-data/config/app.json。
export const FIELD_TABLE_FILE = path.join(APP_ROOT, "..", "prompts", "配置端字段表.json");

export function loadFieldTable(file) {
  try { return JSON.parse(fs.readFileSync(file || FIELD_TABLE_FILE, "utf8")); } catch (e) { return { 分组: [] }; }
}

export function fieldEntries(table) {
  const out = [];
  for (const g of ((table || {}).分组 || [])) for (const f of (g.字段 || [])) out.push(Object.assign({ 分组: g.名 }, f));
  return out;
}

export function setPath(obj, dotted, value) {
  const parts = String(dotted).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

export function getPath(obj, dotted) {
  let cur = obj;
  for (const p of String(dotted).split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

export function defaultsFromTable(table) {
  const cfg = {};
  for (const f of fieldEntries(table)) if (f.键) setPath(cfg, f.键, f.默认);
  return cfg;
}

export function loadConfig(opts) {
  const o = opts || {};
  const table = o.table || loadFieldTable(o.tableFile);
  const cfg = defaultsFromTable(table);
  let user = {};
  try { user = JSON.parse(fs.readFileSync(o.file || CONFIG_FILE, "utf8")); } catch (e) { user = {}; }
  return deepMerge(cfg, user);
}

export function saveConfig(cfg, file) {
  const f = file || CONFIG_FILE;
  ensureDir(path.dirname(f));
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  fs.renameSync(tmp, f);
  return f;
}

export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch === null || typeof patch !== "object") return patch === undefined ? base : patch;
  const out = (base && typeof base === "object" && !Array.isArray(base)) ? Object.assign({}, base) : {};
  for (const k of Object.keys(patch)) out[k] = deepMerge(out[k], patch[k]);
  return out;
}

// secret 字段永不回给前端 —— 只回一个「已配置」的遮蔽值。
export const REDACTED = "<已配置>";

export function redactConfig(cfg, table) {
  const out = JSON.parse(JSON.stringify(cfg || {}));
  const entries = fieldEntries(table || loadFieldTable());
  for (const f of entries) {
    if (f.类型 !== "secret") continue;
    const v = getPath(out, f.键);
    setPath(out, f.键, v ? REDACTED : "");
  }
  return out;
}

// 配置端保存时的安全合并：secret 字段前端永远只拿到遮蔽值（甚至空串，
// 因为密码框不回显），所以这两种值必须理解为「没改」，保留原值。
// 少了这一步，一次普通保存就会把真令牌写成 "<已配置>"：
// 客户端随后带着假令牌去连 NapCat，表现就是"重启之后再也连不上"。
export function mergeConfigSafe(cur, patch, table) {
  const next = deepMerge(cur, patch || {});
  // 按字段表把类型扳回来：配置端表单提交的值都是字符串，直接合并会把 bool 存成 "true"
  // （实测踩过：runtime.voice.enabled / plugins.ourFreeModel 变成了字符串，=== true 的比较全部失效）。
  for (const f of fieldEntries(table || loadFieldTable())) {
    if (!f.键 || f.类型 === "secret") continue;
    const v = getPath(next, f.键);
    if (v === undefined || v === null) continue;
    if (v === "") {
      // 空串＝表单没给值：bool 要保留 cur 里的原值（否则一次空提交会把 true 清成空串，等于把功能关掉）
      if (f.类型 === "bool") setPath(next, f.键, getPath(cur, f.键) === true);
      continue;
    }
    if (f.类型 === "bool") {
      if (typeof v === "string") setPath(next, f.键, !/^(false|0|no|off|否|关)$/i.test(v.trim()));
      else if (typeof v === "number") setPath(next, f.键, v !== 0);
    } else if (f.类型 === "number") {
      if (typeof v === "string" && v.trim() !== "") { const n = Number(v); if (isFinite(n)) setPath(next, f.键, n); }
    }
  }
  for (const f of fieldEntries(table || loadFieldTable())) {
    if (f.类型 !== "secret" || !f.键) continue;
    const v = getPath(next, f.键);
    // 遮蔽值（"<已配置>"，或 sk-abc...1234 这种掩码）都算"没改" —— 掩码不是密钥。
    const masked = typeof v === "string" && (v.indexOf("...") >= 0 || v.indexOf("…") >= 0);
    if (v === undefined || v === null || v === "" || v === REDACTED || masked) {
      const keep = getPath(cur, f.键);
      setPath(next, f.键, keep === undefined ? "" : keep);
    }
  }
  return next;
}

function numOf(v, d) { const n = Number(v); return isFinite(n) ? n : d; }

// 三档字数上限 [短评, 总结, 详细]：gates.depthChars 一处配置，判定流水与大脑提示词共用
export function depthCharsOf(cfg) {
  const v = getPath(cfg || {}, "gates.depthChars");
  if (Array.isArray(v) && v.length >= 3) {
    const a = v.slice(0, 3).map(function (x) { return numOf(x, 0); });
    if (a.every(function (n) { return n > 0; })) return a;
  }
  return [30, 100, 250];
}

// 判定阈值（开口线/三档线/灰区/六因子权重）。
// 以前这几项只写在字段表里、**没有任何代码读它们** —— 配置端改了没反应，等于摆设。
export function gatesFromConfig(cfg) {
  const c = cfg || {};
  const w = getPath(c, "gates.weights");
  const weights = (Array.isArray(w) && w.length >= 4)
    ? { w1: numOf(w[0], 0.40), w2: numOf(w[1], 0.20), w3: numOf(w[2], 0.25), w4: numOf(w[3], 0.15) }
    : null;
  return {
    bounds: { lo: numOf(getPath(c, "gates.greyLo"), 0.40), hi: numOf(getPath(c, "gates.greyHi"), 0.75) },
    tiers: {
      speakAt: numOf(getPath(c, "gates.utilitySpeakAt"), 0.15),
      terseAt: numOf(getPath(c, "gates.utilityTerseAt"), 0.20),
      detailedAt: numOf(getPath(c, "gates.utilityDetailedAt"), 0.65),
      maxChars: depthCharsOf(c)
    },
    weights: Object.assign({ lambda: numOf(getPath(c, "gates.utilityLambda"), 0.5) }, weights || {}),
    // 语义补救：本地判否但像个"没点名的真问题"时怎么办（关 / 短句 / 中档）
    rescueAsk: getPath(c, "gates.rescueAsk") || "中档",
    // 疑似注入指令：直接不回（默认开）
    blockInjected: getPath(c, "gates.blockInjected") !== false
  };
}

// 外审（二判）：既复核"该不该开口"，也复核"该说多长"
export function auditFromConfig(cfg) {
  const c = cfg || {};
  return {
    timeoutMs: numOf(getPath(c, "audit.timeoutMs"), 30000),
    scope: getPath(c, "audit.scope") || "灰区也审",       // 只审高档 / 高档+复核救回 / 灰区也审
    onTimeout: getPath(c, "audit.onTimeout") || "降档",         // 降档 / 保持
    maxPerHour: numOf(getPath(c, "audit.maxPerHour"), 30),     // 0 = 不限
    auditUnaddressed: getPath(c, "audit.auditUnaddressed") !== false,  // 未点名却要进大脑的也审（默认开）
    noAudit: getPath(c, "audit.noAudit") || "边界判否",   // 部分判否也送审：关 / 边界判否 / 边界或提问
    noMaxPerHour: numOf(getPath(c, "audit.noMaxPerHour"), 6)   // 边界判否复核的独立限流（0 = 不限）
  };
}

// 运行期用的派生配置（把判定/主动/接入的默认值集中到一处，供 runtime 消费）
export function runtimeConfig(cfg) {
  const c = cfg || {};
  const depthChars = getPath(c, "gates.depthChars") || [20, 60, 200];
  return {
    // N9 修订：默认 auto —— 新群先观察，攒满 80 条转半自动，3 天后全自动。
    // 兼容旧语义：runtime.observe=true 强制观察，=false 直接实际发送。
    stageMode: getPath(c, "runtime.stageMode") || (getPath(c, "runtime.observe") === true ? "observe" : getPath(c, "runtime.observe") === false ? "live" : "auto"),
    observeUntilMessages: getPath(c, "runtime.observeUntilMessages") != null ? getPath(c, "runtime.observeUntilMessages") : 80,
    semiAutoDays: getPath(c, "runtime.semiAutoDays") != null ? getPath(c, "runtime.semiAutoDays") : 3,
    contextWindow: getPath(c, "runtime.contextWindow") != null ? getPath(c, "runtime.contextWindow") : 20, // N8
    depthChars: depthChars,
    gates: gatesFromConfig(c),
    audit: auditFromConfig(c),
    searchPerTier: getPath(c, "runtime.searchPerTier") || [0, 1, 1],
    coalesceWindowMs: getPath(c, "runtime.coalesceWindowMs") != null ? getPath(c, "runtime.coalesceWindowMs") : 6000,  // N23
    coalesceMaxBatch: getPath(c, "runtime.coalesceMaxBatch") != null ? getPath(c, "runtime.coalesceMaxBatch") : 5,
    maxSegments: getPath(c, "runtime.maxSegments") != null ? getPath(c, "runtime.maxSegments") : 6,                    // N6：超长按标点拆成多条（不再合并压缩）
    autoTrainAt: Math.max(0, Number(getPath(c, "runtime.autoTrainAt")) || 30),   // 已标 N 条就自动训练一轮（0=关）
    bili: {
      frames: Math.min(12, Math.max(0, numOf(getPath(c, "runtime.bili.frames"), 4))),
      maxMinutes: Math.max(0, numOf(getPath(c, "runtime.bili.maxMinutes"), 30)),
      listenSec: Math.max(0, Math.min(120, numOf(getPath(c, "runtime.bili.listenSec"), 0)))   // 0 = 不听声音；20~60 = 抽几段音频转写
    },
    // 记忆：每 N 条发言，让她自己总结一次「想记住的事」，写进群档案（profiles/g-<gid>.json）
    memory: {
      enabled: getPath(c, "runtime.memory.enabled") !== false,
      everyN: Math.max(5, Number(getPath(c, "runtime.memory.everyN")) || 30)
    },
    uiMessageLimit: numOf(getPath(c, "runtime.uiMessageLimit"), 30),   // 配置端"收到的消息"每群保留多少条（满了丢最旧）
    // 语音转写侧车（tools/stt-server.py，OpenAI 兼容；默认端点就是本机，音频不出本机）
    stt: {
      enabled: getPath(c, "runtime.stt.enabled") === true,
      endpoint: getPath(c, "runtime.stt.endpoint") || "http://127.0.0.1:8910/v1/audio/transcriptions",
      timeoutMs: numOf(getPath(c, "runtime.stt.timeoutMs"), 30000),
      maxBytes: numOf(getPath(c, "runtime.stt.maxBytes"), 8 * 1024 * 1024),
      lang: getPath(c, "runtime.stt.lang") || "zh"
    },
    quoteReply: getPath(c, "runtime.quoteReply") || "自动",            // 引用回复：关 / 自动 / 仅标记
    poke: getPath(c, "runtime.poke") || "短答",                        // 被戳：关 / 短答
    pokeBackRate: numOf(getPath(c, "runtime.pokeBackRate"), 0.35),     // 回戳概率
    pokeGapSec: numOf(getPath(c, "runtime.pokeGapSec"), 60),           // 同一个人两次反应的间隔（秒）
    budget: {
      dailyTokens: getPath(c, "runtime.budget.dailyTokens") != null ? getPath(c, "runtime.budget.dailyTokens") : 5000000, // N23
      softRatio: 0.8,
      hardRatio: 1.0,
      groupHourlyLimit: getPath(c, "runtime.budget.groupHourlyLimit") != null ? getPath(c, "runtime.budget.groupHourlyLimit") : 0
    },
    onebot: {
      wsUrl: getPath(c, "napcat.wsUrl") || "ws://127.0.0.1:3001",
      token: getPath(c, "napcat.token") || "",
      reconnectMs: getPath(c, "runtime.onebot.reconnectMs") || 3000,
      dedupeWindowMs: getPath(c, "runtime.onebot.dedupeWindowMs") || 180000
    },
    searchMode: String(getPath(c, "runtime.search.mode") || "c").toLowerCase() === "b" ? "b" : "c",   // N12：B/C 可切换
    memeFreq: getPath(c, "persona.memeFreq") || "少",                                                  // N15：关/少/中
    memeGapReplies: getPath(c, "runtime.memeGapReplies") != null ? getPath(c, "runtime.memeGapReplies") : 3,
    proactive: {
      enabled: getPath(c, "autojoin.enabled") !== false,
      rate: getPath(c, "autojoin.rate") != null ? getPath(c, "autojoin.rate") : 0.25,
      minGapSec: getPath(c, "autojoin.minGapSec") != null ? getPath(c, "autojoin.minGapSec") : 120,
      maxPerHour: getPath(c, "autojoin.maxPerHour") != null ? getPath(c, "autojoin.maxPerHour") : 6,
      maxChars: 20
    },
    vision: {                                                       // N18：识图走独立一次多模态调用
      enabled: getPath(c, "runtime.vision.enabled") === true,
      mode: getPath(c, "runtime.vision.mode") || "off",              // off | http | dsh
      endpoint: getPath(c, "runtime.vision.endpoint") || "",
      apiKey: getPath(c, "runtime.vision.apiKey") || "",
      model: getPath(c, "runtime.vision.model") || "同大脑",
      provider: getPath(c, "runtime.vision.provider") || "",
      capable: getPath(c, "runtime.vision.capable") || "自动",     // 自动 / 有 / 无：模型有没有视觉能力
      profile: getPath(c, "runtime.vision.profile") || "qq-vision",
      timeoutMs: getPath(c, "runtime.vision.timeoutMs") || 20000,
      maxChars: getPath(c, "runtime.vision.maxChars") || 300
    },
    voice: {                                                        // N18：TTS 用 Windows 自带 SAPI
      enabled: getPath(c, "runtime.voice.enabled") === true,
      voice: getPath(c, "runtime.voice.voice") || "Microsoft Huihui",
      rate: getPath(c, "runtime.voice.rate") || 0,
      maxChars: getPath(c, "runtime.voice.maxChars") || 60
    },
    plugins: {
      ourFreeModel: getPath(c, "plugins.ourFreeModel") !== false,
      ourFreeModelId: getPath(c, "plugins.ourFreeModelId") || "",
      freeSearch: getPath(c, "plugins.freeSearch") !== false,
      freeSearchEngine: getPath(c, "plugins.freeSearchEngine") || "bing",
      archify: getPath(c, "plugins.archify") !== false,
      archifyCleanup: getPath(c, "plugins.archifyCleanup") !== false,
      meme: getPath(c, "plugins.meme") !== false
    },
    auditTimeoutMs: Number(getPath(c, "audit.timeoutMs")) || 30000,
    ageStage: getPath(c, "persona.ageStage") === "幼年" ? "幼年" : "成年",
    illustrations: {
      young: getPath(c, "persona.illustrationYoung") || "角色形象图/幼年.jpg",
      adult: getPath(c, "persona.illustrationAdult") || "角色形象图/成年.jpg"
    },
    napcatWebui: getPath(c, "runtime.napcatWebui") || "http://127.0.0.1:6099",
    webuiEnabled: getPath(c, "runtime.webui.enabled") !== false,
    webuiPort: getPath(c, "runtime.webui.port") != null ? getPath(c, "runtime.webui.port") : 8799,
    autojoinRate: getPath(c, "autojoin.rate") != null ? getPath(c, "autojoin.rate") : 0.25,
    minGapSec: getPath(c, "autojoin.minGapSec") != null ? getPath(c, "autojoin.minGapSec") : 120
  };
}
