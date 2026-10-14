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
  for (const f of fieldEntries(table || loadFieldTable())) {
    if (f.类型 !== "secret" || !f.键) continue;
    const v = getPath(next, f.键);
    if (v === undefined || v === null || v === "" || v === REDACTED) {
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
  return [20, 60, 200];
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
    weights: Object.assign({ lambda: numOf(getPath(c, "gates.utilityLambda"), 0.5) }, weights || {})
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
    contextWindow: getPath(c, "runtime.contextWindow") != null ? getPath(c, "runtime.contextWindow") : 10, // N8
    depthChars: depthChars,
    gates: gatesFromConfig(c),
    searchPerTier: getPath(c, "runtime.searchPerTier") || [0, 1, 1],
    coalesceWindowMs: getPath(c, "runtime.coalesceWindowMs") != null ? getPath(c, "runtime.coalesceWindowMs") : 6000,  // N23
    coalesceMaxBatch: getPath(c, "runtime.coalesceMaxBatch") != null ? getPath(c, "runtime.coalesceMaxBatch") : 5,
    maxSegments: getPath(c, "runtime.maxSegments") != null ? getPath(c, "runtime.maxSegments") : 3,                    // N6
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
      model: getPath(c, "runtime.vision.model") || "mimo-v2.6-flash-free",
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
    auditTimeoutMs: Number(getPath(c, "audit.timeoutMs")) || 8000,
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
