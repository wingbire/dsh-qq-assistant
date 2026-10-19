import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadFieldTable, defaultsFromTable, deepMerge, redactConfig, mergeConfigSafe, runtimeConfig, saveConfig, getPath, setPath, REDACTED } from "./config.js";
import { createLabelQueue, agreementStats, foldLabels, pendingOf, labeledOf } from "./label.js";
import { corpusFile, loadCorpus, saveCorpus, labelCorpus, corpusStats, fromDecisions } from "./corpus.js";
import { buildProfilePrompt } from "./profile.js";
import { moneyOfRows, costOf, isPeakTime, PRICE_MODEL, PRICE_NOTE } from "./cost.js";

// N25 决策：有设计感的配置端 —— 本地 HTTP 服务，只听 127.0.0.1，无登录。
// 前端是零依赖的原生 HTML/CSS/JS（不分发 node_modules 也能跑）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, "webui");
export const DEFAULT_PORT = 8799;

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon"
};

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function sendText(res, code, text, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}
function readBody(req, limit) {
  return new Promise(function (resolve) {
    let data = "";
    req.on("data", function (c) { data += c; if (data.length > (limit || 2e6)) req.destroy(); });
    req.on("end", function () { resolve(data); });
    req.on("error", function () { resolve(""); });
  });
}

export function startOfToday(nowMs) {
  const d = new Date(nowMs == null ? Date.now() : nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 成本口径（技术架构文档 §7.1）：输入 ×1 + 输出 ×2
export function summarizeCost(rows, opts) {
  const o = opts || {};
  const gid = o.gid ? String(o.gid) : null;
  const since = o.since != null ? o.since : startOfToday();
  const per = new Map();
  const perTier = {};
  let units = 0, outTokens = 0, inTokens = 0, cacheRead = 0, cacheInput = 0;
  let replies = 0, messages = 0, brainCalls = 0, searches = 0, cacheHits = 0, memes = 0, voice = 0, proactives = 0;
  const scopeRows = [];
  for (const r of (rows || [])) {
    if (!r) continue;
    const t = r.at ? Date.parse(r.at) : NaN;
    // 设了下界就只认带时间戳、且在界内的记录；没设下界（since=0）则宽容处理
    if (since && (isNaN(t) || t < since)) continue;
    scopeRows.push(r);
    const g = String(r.gid || "-");
    if (gid && g !== gid) continue;
    let b = per.get(g);
    if (!b) { b = { gid: g, units: 0, replies: 0, messages: 0, money: 0 }; per.set(g, b); }
    if (r.kind === "decision" || r.kind === "observe_only" || r.kind === "merged_ignore") {
      messages += 1; b.messages += 1;
      if (r.tier) perTier[r.tier] = (perTier[r.tier] || 0) + 1;
    }
    if (r.kind === "sent") {
      replies += 1; b.replies += 1;
      if (r.usage && r.usage.totalTokens) brainCalls += 0;  // 次数由下行的 usage 判定
      if (r.search && r.search.ok) { searches += 1; if (r.search.cached) cacheHits += 1; }
      if (r.meme) memes += 1;
      if (r.voice && r.voice.bytes) voice += 1;
      const u = r.usage || {};
      const i2 = Number(u.inputTokens) || 0, o2 = Number(u.outputTokens) || 0;
      const cr = Number(u.cacheReadTokens) || 0, cw = Number(u.cacheWriteTokens) || 0;
      const u2 = i2 + 2 * o2;
      units += u2; b.units += u2;
      const ts2 = r.at ? Date.parse(r.at) : NaN;
      b.money += costOf(u, (isFinite(ts2) && isPeakTime(ts2)) ? "peak" : "offPeak");
      inTokens += i2; outTokens += o2; cacheRead += cr; cacheInput += i2 + cr + cw;
      if (u2 > 0) brainCalls += 1;
    }
    if (r.kind === "proactive_sent") proactives += 1;
  }
  // 钱：今天的总花费 / 每条均价 / 缓存省下的 / 本地判掉的那批"本来要花多少"（估算）
  const money = moneyOfRows(scopeRows);
  const notReplied = Math.max(0, messages - replies);
  const saved = notReplied * money.perReplyAvg;
  return {
    gid: gid, since: since,
    units: units, inTokens: inTokens, outTokens: outTokens,
    replies: replies, messages: messages, brainCalls: brainCalls,
    searches: searches, searchCacheHits: cacheHits, memes: memes, voice: voice, proactives: proactives,
    cacheHitRate: cacheInput > 0 ? Math.round((cacheRead / cacheInput) * 1000) / 1000 : null,
    avgUnitsPerReply: replies > 0 ? Math.round(units / replies) : 0,
    money: {
      today: money.today,                 // 元（按官方价目、按时段计价）
      perReplyAvg: money.perReplyAvg,     // 元 / 条
      cacheSaved: money.cacheSaved,       // 缓存命中相比全未命中省下的
      saved: saved,                       // 本地判否那批的"本来要花"（估算）
      savedReplies: notReplied,
      costedReplies: money.replies,
      model: PRICE_MODEL,
      note: PRICE_NOTE
    },
    perGroup: Array.from(per.values()).sort(function (a, b) { return b.units - a.units; }),
    perTier: perTier
  };
}

// 兼容旧的状态页（观察日志统计）
export function summarizeObservations(rows) {
  const c = summarizeCost(rows, { since: 0 });
  const verdicts = {}, tiers = {}, hours = new Array(24).fill(0);
  for (const r of (rows || [])) {
    if (!r) continue;
    if (r.kind === "decision" || r.kind === "observe_only") {
      if (r.verdict) verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
      if (r.tier) tiers[r.tier] = (tiers[r.tier] || 0) + 1;
      hours[new Date(r.at || Date.now()).getHours()] += 1;
    }
  }
  return {
    verdicts: verdicts, tiers: tiers, hours: hours, rows: (rows || []).length,
    tokens: c.units, replies: c.replies, memes: c.memes, proactives: c.proactives,
    cacheHitRate: c.cacheHitRate
  };
}

export function createWebUi(deps) {
  const d = deps || {};
  let cfg = d.config || {};
  const table = d.table || loadFieldTable();
  const store = d.store || null;
  const memes = d.memes || null;
  const runtime = d.runtime || null;
  const configFile = d.configFile;
  const labels = d.labels || (store ? createLabelQueue({ store: store }) : null);
  const onConfigSaved = d.onConfigSaved || null;  // async (nextCfg) => void —— 人设改了要重渲染 profile patch
  const checkUpdateFn = d.checkUpdate || null;    // async () => 更新检查结果
  const applyUpdateFn = d.applyUpdate || null;    // async () => 执行更新
  const depsProbeFn = d.depsProbe || null;        // async () => { items: [...] }
  const modelListFn = d.modelList || null;        // async () => { ok, models: [...], current }
  const modelProbeFn = d.modelProbe || null;      // async () => { ok, at, results, models }
  const secretValues = d.secretValues || null;    // async () => ({ llm: { deepseekApiKey: "sk-abc...1234" } }) 遮蔽值
  const keyStatusFn = d.keyStatus || null;        // async () => ({ set, masked, source, ofm }) 当前 key 打哪来
  const onSecrets = d.onSecrets || null;          // async (patch) => 把真密钥写进工作区的 secrets.json
  const capsFn = d.caps || null;                  // async () => ({ brain, rows }) 能力总览（模型能力 ↔ 人设声明）
  const visionProbeFn = d.visionProbe || null;
  const selectOptionsFn = d.selectOptions || null;   // async () => ({ "brain.provider": [...], ... }) 可下拉字段的候选    // async ({endpoint, apiKey}) => ({ ok, models, picked }) 多模态接口自检
  const depFixFn = d.depFix || null;              // async (id) => { ok, open?, output? }
  const reconnectFn = d.reconnect || null;        // async () => { ok, url, state } —— 接入设置改完不用重启
  const shutdownFn = d.shutdown || null;          // () => void —— 托盘的停止：先温和收尾再被杀
  const pluginsProbeFn = d.plugins || null;       // async () => { items: [...] } —— 社区插件兼容
  const pluginInstallFn = d.installPlugin || null;
  const probeOnebot = d.probeOnebot || null;      // async (force) => { state, selfId, online, version, nickname }
  const napcatInfoFn = d.napcatInfo || null;     // (force) => 本机配置 vs NapCat 配置的对齐情况
  const napcatAdoptFn = d.napcatAdopt || null;    // async (mode) => 从 NapCat 自动填入 / 清空本机令牌
  const napcatRevealFn = d.napcatReveal || null;  // ()       => 显式要看 NapCat 控制台的登录令牌时才给明文
  const listGroups = d.listGroups || null;        // async () => [{ group_id, group_name, member_count }]
  const startedAt = Date.now();

  function currentConfig() { return cfg; }

  function statusPayload(url) {
    const gid = url.searchParams.get("gid") || null;
    const limit = Number(url.searchParams.get("limit")) || 40;
    const rt = runtime && runtime.status ? runtime.status() : null;
    const obs = store ? store.readJsonl(store.paths.observe) : [];
    const budget = runtime && runtime.budget ? runtime.budget.status() : { used: 0, limit: 0, ratio: 0, mode: "normal" };
    const live = runtime && runtime.groups ? runtime.groups() : [];
    return {
      ok: true,
      uptimeMs: Date.now() - startedAt,
      mode: rt ? rt.mode : null,
      stats: rt ? rt.stats : null,
      brakes: rt ? rt.brakes : null,
      budget: budget,
      cost: summarizeCost(obs, { gid: gid }),
      scope: gid,
      stage: (gid && runtime && runtime.stage) ? runtime.stage(gid) : null,
      group: (gid && runtime && runtime.groupStats) ? runtime.groupStats(gid) : null,
      allGroups: live,
      messages: (gid && runtime && runtime.recentMessages) ? runtime.recentMessages(gid, limit) : (runtime && runtime.allRecent ? runtime.allRecent(limit) : []),
      messagesInfo: {
        shown: 0,
        perGroup: (runtime && runtime.uiMessages && runtime.uiMessages.perGroup) || null,
        groups: (runtime && runtime.uiMessages) ? runtime.uiMessages.groups().length : 0
      },
      labels: labels ? labels.status() : null,
      memes: memes && memes.ready ? { rows: memes.rows.length, tags: memes.tags().length, pack: path.basename(memes.packDir || "") } : null
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;

    if (p === "/api/config" && req.method === "GET") {
      const vals = redactConfig(cfg, table);
      // 大脑 key 存在 secrets.json（不在 app.json），这里补一个遮蔽后的值给界面显示
      if (secretValues) {
        try {
          const sv = await secretValues();
          if (sv) for (const k of Object.keys(sv)) vals[k] = Object.assign({}, vals[k] || {}, sv[k]);
        } catch (e) { /* 显示不出来不影响 */ }
      }
      let keyInfo = null;
      if (keyStatusFn) { try { keyInfo = await keyStatusFn(); } catch (e) { keyInfo = null; } }
      return sendJson(res, 200, { ok: true, table: table, values: vals, runtime: runtimeConfig(cfg), defaults: defaultsFromTable(table), keyInfo: keyInfo });
    }
    if (p === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      let patch = null;
      try { patch = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败" }); }
      const incoming = (patch && patch.patch) || patch || {};
      // 大脑 key：真值走 secrets.json（工作区自持），app.json 里那格留空免得抄两份
      const kField = "llm.deepseekApiKey";
      const kIn = incoming && incoming.llm ? String(incoming.llm.deepseekApiKey || "").trim() : "";
      if (kIn && kIn !== REDACTED && onSecrets) {
        try { await onSecrets({ deepseekApiKey: kIn }); } catch (e) { /* 落盘失败下面会说 */ }
      }
      cfg = mergeConfigSafe(cfg, incoming, table);   // secret 的遮蔽值/空值 = 没改
      if (kIn) { try { setPath(cfg, kField, ""); } catch (e) { /* ignore */ } }
      if (configFile) { try { saveConfig(cfg, configFile); } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); } }
      let personaNote = null;
      if (onConfigSaved) { try { personaNote = await onConfigSaved(cfg); } catch (e) { personaNote = { ok: false, error: String(e && e.message) }; } }
      return sendJson(res, 200, { ok: true, values: redactConfig(cfg, table), runtime: runtimeConfig(cfg), persona: personaNote });
    }

    if (p === "/api/status") return sendJson(res, 200, statusPayload(url));

    if (p === "/api/onebot") {
      if (!probeOnebot) return sendJson(res, 200, { ok: true, state: "unknown", note: "没有接 OneBot" });
      const info = await probeOnebot(url.searchParams.get("force") === "1");
      return sendJson(res, 200, Object.assign({ ok: true }, info));
    }

    // NapCat 自动对接：读 NapCat 自己的 onebot11 配置，把地址/令牌对齐（令牌只回遮蔽值）
    if (p === "/api/napcat" && req.method === "GET") {
      if (!napcatInfoFn) return sendJson(res, 200, { ok: false, error: "没有接 NapCat 探测" });
      return sendJson(res, 200, await napcatInfoFn(url.searchParams.get("force") === "1"));
    }
    if (p === "/api/napcat/adopt" && req.method === "POST") {
      const body = await readBody(req);
      let b = null;
      try { b = JSON.parse(body); } catch (e) { b = null; }
      if (!napcatAdoptFn) return sendJson(res, 200, { ok: false, error: "没有接 NapCat 对齐服务" });
      return sendJson(res, 200, await napcatAdoptFn(String((b && b.mode) || "napcat")));
    }

    // 要登录 NapCat 的网页控制台时，得把它的令牌抄进去 —— 这一步没法代填，就把明文递给用户
    if (p === "/api/napcat/reveal" && req.method === "POST") {
      if (!napcatRevealFn) return sendJson(res, 200, { ok: false, error: "没有接 NapCat 令牌读取" });
      return sendJson(res, 200, napcatRevealFn());
    }

    if (p === "/api/groups") {
      const seen = new Map();
      if (store) {
        for (const r of store.readJsonl(store.paths.observe)) {
          if (r && r.gid && !seen.has(String(r.gid))) seen.set(String(r.gid), { group_id: String(r.gid), group_name: "", seenLocal: true });
        }
      }
      if (listGroups) {
        try {
          const list = await listGroups();
          for (const g of (list || [])) {
            const k = String(g.group_id);
            seen.set(k, Object.assign(seen.get(k) || {}, { group_id: k, group_name: g.group_name || "", member_count: g.member_count, max_member_count: g.max_member_count }));
          }
        } catch (e) {}
      }
      for (const s of (runtime && runtime.groups ? runtime.groups() : [])) {
        seen.set(s.gid, Object.assign(seen.get(s.gid) || { group_id: s.gid, group_name: "" }, { live: true, stats: s }));
      }
      return sendJson(res, 200, { ok: true, groups: Array.from(seen.values()) });
    }

    if (p === "/api/action" && req.method === "POST") {
      const body = await readBody(req);
      let b = null;
      try { b = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败" }); }
      const act = String((b && b.action) || "");
      if (act === "groupEnable" || act === "groupDisable") {
        if (!runtime || !runtime.setGroupEnabled) return sendJson(res, 500, { ok: false, error: "没有运行中的实例" });
        if (!b.gid) return sendJson(res, 400, { ok: false, error: "缺少 gid" });
        const r = runtime.setGroupEnabled(b.gid, act === "groupEnable");
        return sendJson(res, 200, { ok: true, action: act, gid: r.gid, enabled: r.enabled });
      }
      if (act === "globalStop" || act === "globalResume") {
        const v = act === "globalStop";
        if (runtime && runtime.setGlobalPaused) runtime.setGlobalPaused(v);
        cfg.paused = v;
        if (configFile) { try { saveConfig(cfg, configFile); } catch (e) {} }
        return sendJson(res, 200, { ok: true, action: act, paused: v });
      }
      if (act === "setStage") {
        if (!runtime || !runtime.setStage) return sendJson(res, 500, { ok: false, error: "没有运行中的实例" });
        if (!b.gid) return sendJson(res, 400, { ok: false, error: "缺少 gid" });
        const r = runtime.setStage(b.gid, b.stage);
        return sendJson(res, 200, Object.assign({ ok: !r.error, action: act }, r));
      }
      if (act === "shutdown") {
        // 托盘停止前先走这一步：让它有机会把攒着写的状态落盘，再被强杀（只允许本机回环调用）
        const ra = String((req.socket && req.socket.remoteAddress) || "");
        if (ra !== "127.0.0.1" && ra !== "::1" && ra !== "::ffff:127.0.0.1") {
          return sendJson(res, 403, { ok: false, error: "只允许本机调用" });
        }
        sendJson(res, 200, { ok: true, action: act });
        setTimeout(function () { if (shutdownFn) { try { shutdownFn(); } catch (e) {} } }, 80);
        return;
      }
      if (act === "reconnect") {
        if (!reconnectFn) return sendJson(res, 500, { ok: false, error: "没有接重连服务" });
        const r = await reconnectFn();
        return sendJson(res, 200, Object.assign({ ok: true, action: act }, r || {}));
      }
      if (act === "setBudget") {
        const v = Math.max(0, Math.round(Number(b.value) || 0));
        setPath(cfg, "runtime.budget.dailyTokens", v);
        if (runtime && runtime.budget && runtime.budget.limits) runtime.budget.limits.dailyTokens = v;
        if (configFile) { try { saveConfig(cfg, configFile); } catch (e) {} }
        return sendJson(res, 200, { ok: true, action: act, dailyTokens: v });
      }
      return sendJson(res, 400, { ok: false, error: "未知动作：" + act });
    }

    // 设置页：git 更新 + 依赖体检
    if (p === "/api/update") {
      if (req.method === "GET") return sendJson(res, 200, checkUpdateFn ? await checkUpdateFn() : { ok: false, error: "没有接更新服务" });
      if (req.method === "POST") return sendJson(res, 200, applyUpdateFn ? await applyUpdateFn() : { ok: false, error: "没有接更新服务" });
      return sendJson(res, 405, { ok: false, error: "不支持的方法" });
    }
    if (p === "/api/plugins" && req.method === "GET") {
      return sendJson(res, 200, pluginsProbeFn ? await pluginsProbeFn() : { ok: false, items: [] });
    }
    if (p === "/api/plugins/install" && req.method === "POST") {
      const body = await readBody(req);
      let b = null;
      try { b = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败" }); }
      if (!b || !b.id) return sendJson(res, 400, { ok: false, error: "缺少 id" });
      return sendJson(res, 200, pluginInstallFn ? await pluginInstallFn(String(b.id)) : { ok: false, error: "没有接插件安装服务" });
    }

    // 可下拉字段的候选清单（音色 / provider / 免费池模型 / 转写语言）
    if (p === "/api/select-options" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, options: selectOptionsFn ? await selectOptionsFn() : {} });
    }
    // 多模态接口自检：填了地址 + Key 就能列出可用模型，并把能确定的配置一次性写好
    if (p === "/api/vision/probe" && req.method === "POST") {
      const body = await readBody(req);
      let b = null;
      try { b = JSON.parse(body); } catch (e) { b = null; }
      const table = loadFieldTable();
      const cur = runtimeConfig(cfg).vision || {};
      const endpoint = String((b && b.endpoint) || cur.endpoint || "").trim();
      const apiKey = String((b && b.apiKey) || cur.apiKey || "").trim();
      if (!endpoint) return sendJson(res, 200, { ok: false, error: "先填「多模态接口地址」" });
      if (!apiKey) return sendJson(res, 200, { ok: false, error: "先填「多模态接口 Key」" });
      if (!visionProbeFn) return sendJson(res, 200, { ok: false, error: "没有接检测服务" });
      const r = await visionProbeFn({ endpoint: endpoint, apiKey: apiKey });
      if (r && r.ok && (!b || b.save !== false)) {
        setPath(cfg, "runtime.vision.enabled", true);
        setPath(cfg, "runtime.vision.mode", "http");
        setPath(cfg, "runtime.vision.endpoint", r.url);          // 归一化后的完整地址
        setPath(cfg, "runtime.vision.apiKey", apiKey);
        setPath(cfg, "runtime.vision.provider", "");             // http 模式用不到 provider
        if (r.picked) setPath(cfg, "runtime.vision.model", r.picked);
        if (configFile) { try { saveConfig(cfg, configFile); } catch (e) { /* 下面照样回结果 */ } }
        if (onConfigSaved) { try { await onConfigSaved(cfg); } catch (e) { /* ignore */ } }
      }
      return sendJson(res, 200, Object.assign({}, r, { values: redactConfig(cfg, table) }));
    }
    // 能力总览：模型能力 ↔ 人设声明 对不对得上（"模型接入"页顶部那张卡）
    if (p === "/api/caps" && req.method === "GET") {
      return sendJson(res, 200, capsFn ? await capsFn() : { ok: false, error: "没有接能力总览服务" });
    }
    // 免费模型（Our Free Model 插件）：清单 + 真机检测
    if (p === "/api/models" && req.method === "GET") {
      return sendJson(res, 200, modelListFn ? await modelListFn() : { ok: false, error: "没有接模型清单服务" });
    }
    if (p === "/api/models/probe" && req.method === "POST") {
      return sendJson(res, 200, modelProbeFn ? await modelProbeFn() : { ok: false, error: "没有接模型检测服务" });
    }
    if (p === "/api/deps" && req.method === "GET") {
      return sendJson(res, 200, depsProbeFn ? await depsProbeFn() : { ok: false, items: [] });
    }
    if (p === "/api/deps/install" && req.method === "POST") {
      const body = await readBody(req);
      let b = null;
      try { b = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败" }); }
      if (!b || !b.id) return sendJson(res, 400, { ok: false, error: "缺少 id" });
      return sendJson(res, 200, depFixFn ? await depFixFn(String(b.id)) : { ok: false, error: "没有接依赖服务" });
    }

    // 群档案：管理员可以直接改提炼结果，也可以写本群专属人设
    if (p === "/api/profile") {
      if (!store) return sendJson(res, 200, { ok: false, error: "没有可用的存储" });
      const gid = url.searchParams.get("gid") || (req.method === "POST" ? null : null);
      if (req.method === "GET") {
        if (!gid) return sendJson(res, 400, { ok: false, error: "缺少 gid" });
        const prof = store.loadProfile(gid);
        const st = (prof && prof.interestStats) || {};
        const watch = (prof && prof.interestWatch) || Object.keys(st).filter(function (k) { return !st[k].stable; }).slice(0, 12);
        return sendJson(res, 200, {
          ok: true, gid: String(gid), profile: prof || null,
          interests: (prof && prof.interests) || [], watch: watch, stats: st, log: (prof && prof.interestLog) || null,
          prompt: prof ? buildProfilePrompt(prof) : ""
        });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        let b = null;
        try { b = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败" }); }
        if (!b || !b.gid) return sendJson(res, 400, { ok: false, error: "缺少 gid" });
        const cur = store.loadProfile(b.gid) || {};
        const next = Object.assign({}, cur);
        for (const k of ["interests", "dislikes", "habits", "notes", "pace", "activeHours", "personaText"]) {
          if (b[k] !== undefined) next[k] = b[k];
        }
        // 管理员手写的常聊话题一律"钉住"：不进观察区、永不按时间淘汰（自动学到的才走生命周期）
        if (b.interests !== undefined) {
          const stats = Object.assign({}, next.interestStats || {});
          const nowMs = Date.now();
          const d0 = new Date(nowMs).toISOString().slice(0, 10);
          for (const term of (next.interests || [])) {
            if (!term) continue;
            const s = stats[term] || { hits: 0, days: [], firstAt: nowMs, lastAt: nowMs, stable: false };
            const days = Array.isArray(s.days) ? s.days.slice(-8) : [];
            if (days.indexOf(d0) < 0) days.push(d0);
            stats[term] = Object.assign({}, s, { pinned: true, stable: true, lastAt: nowMs, days: days });
          }
          next.interestStats = stats;
        }
        next.rounds = Number(cur.rounds) || 0;
        next.updatedAt = new Date().toISOString();
        next.updatedBy = "admin";
        store.saveProfile(b.gid, next);
        return sendJson(res, 200, { ok: true, gid: String(b.gid), profile: next, prompt: buildProfilePrompt(next) });
      }
      if (req.method === "DELETE") {
        if (!gid) return sendJson(res, 400, { ok: false, error: "缺少 gid" });
        try { fs.unlinkSync(path.join(store.paths.profiles, "g-" + String(gid) + ".json")); } catch (e) {}
        return sendJson(res, 200, { ok: true, gid: String(gid), cleared: true });
      }
      return sendJson(res, 405, { ok: false, error: "不支持的方法" });
    }

    if (p === "/api/labels" && req.method === "GET") {
      if (!labels) return sendJson(res, 200, { ok: true, pending: [], stats: agreementStats([]) });
      const limit = Number(url.searchParams.get("limit")) || 100;
      const all = labels.rows();
      return sendJson(res, 200, {
        ok: true, pending: pendingOf(all).slice(-limit).reverse(),
        labeled: labeledOf(all).slice(-limit).reverse(),
        stats: agreementStats(all)
      });
    }
    if (p === "/api/labels" && req.method === "POST") {
      const body = await readBody(req);
      let b = null;
      try { b = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败" }); }
      if (!labels || !b || !b.id) return sendJson(res, 400, { ok: false, error: "缺少 id" });
      labels.label(b.id, b.human, b.labeler);
      return sendJson(res, 200, { ok: true, stats: labels.status() });
    }

    // ---------- 回放语料（标注后当回归测试用） ----------
    if (p.startsWith("/api/corpus")) {
      if (!store) return sendJson(res, 200, { ok: false, error: "没有数据目录" });
      const file = corpusFile(path.dirname(store.paths.labels));
      if (p === "/api/corpus" && req.method === "GET") {
        const items = loadCorpus(file);
        return sendJson(res, 200, { ok: true, items: items.slice().reverse(), stats: corpusStats(items) });
      }
      if (p === "/api/corpus/label" && req.method === "POST") {
        const body = await readBody(req);
        let b = null;
        try { b = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败" }); }
        try {
          const items = loadCorpus(file);
          labelCorpus(items, b.id, b.expect);
          saveCorpus(file, items);
          return sendJson(res, 200, { ok: true, stats: corpusStats(items) });
        } catch (e) { return sendJson(res, 400, { ok: false, error: String((e && e.message) || e) }); }
      }
      if (p === "/api/corpus/rebuild" && req.method === "POST") {
        // 从观测日志里重新拉最近的判定记录（已标注的会按「原文+时间」保留）
        const decs = store.readJsonl(store.paths.observe).filter(function (r) { return r && r.kind === "decision"; });
        const prev = loadCorpus(file);
        const items = fromDecisions(decs, prev, 60);
        saveCorpus(file, items);
        return sendJson(res, 200, { ok: true, stats: corpusStats(items) });
      }
      return sendJson(res, 405, { ok: false, error: "不支持的方法" });
    }
    if (p === "/api/observe") {
      if (!store) return sendJson(res, 200, { ok: true, rows: [] });
      const limit = Number(url.searchParams.get("limit")) || 100;
      const gid = url.searchParams.get("gid");
      let rows = store.readJsonl(store.paths.observe);
      if (gid) rows = rows.filter(function (r) { return String(r.gid) === String(gid); });
      return sendJson(res, 200, { ok: true, rows: rows.slice(-limit).reverse() });
    }
    if (p === "/api/memes") {
      if (!memes || !memes.ready) return sendJson(res, 200, { ok: true, ready: false, items: [] });
      const tag = url.searchParams.get("tag");
      const rows = (tag ? memes.byTag(tag) : memes.rows).slice(0, 60);
      return sendJson(res, 200, {
        ok: true, ready: true, pack: memes.packDir, tags: memes.tags(),
        items: rows.map(function (r) { return { tag: r.tag, file: r.file_name, caption: r.caption, keywords: r.keywords, url: "/meme/" + encodeURIComponent(r.tag) + "/" + encodeURIComponent(r.file_name) }; })
      });
    }
    if (p.startsWith("/meme/")) {
      if (!memes || !memes.ready) return sendText(res, 404, "no meme library");
      const parts = decodeURIComponent(p.slice("/meme/".length)).split("/");
      if (parts.length !== 2) return sendText(res, 400, "bad path");
      const row = memes.rows.filter(function (r) { return r.tag === parts[0] && r.file_name === parts[1]; })[0];
      if (!row) return sendText(res, 404, "not found");
      const rootAbs = path.resolve(memes.packDir);
      const fileAbs = path.resolve(row.path);
      if (!fileAbs.startsWith(rootAbs)) return sendText(res, 403, "forbidden");
      try {
        const buf = fs.readFileSync(fileAbs);
        res.writeHead(200, { "Content-Type": MIME[path.extname(fileAbs).toLowerCase()] || "application/octet-stream", "Cache-Control": "max-age=60" });
        return res.end(buf);
      } catch (e) { return sendText(res, 404, "read failed"); }
    }
    if (p === "/api/health") return sendJson(res, 200, { ok: true });

    let rel = p === "/" ? "/index.html" : p;
    const abs = path.resolve(PUBLIC_DIR, "." + rel);
    if (!abs.startsWith(path.resolve(PUBLIC_DIR))) return sendText(res, 403, "forbidden");
    try {
      const buf = fs.readFileSync(abs);
      res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
      return res.end(buf);
    } catch (e) { return sendText(res, 404, "not found: " + rel); }
  }

  const server = http.createServer(function (req, res) {
    handle(req, res).catch(function (e) { try { sendJson(res, 500, { ok: false, error: String(e && e.message) }); } catch (err) {} });
  });

  return {
    server: server,
    listen: function (port, host) {
      return new Promise(function (resolve) {
        server.listen(port == null ? DEFAULT_PORT : port, host || "127.0.0.1", function () { resolve({ port: server.address().port, url: "http://127.0.0.1:" + server.address().port }); });
      });
    },
    close: function () { return new Promise(function (r) { server.close(function () { r(true); }); }); },
    getConfig: currentConfig,
    setConfig: function (c) { cfg = c; return cfg; },
    status: function () { return statusPayload(new URL("http://127.0.0.1/api/status")); }
  };
}
