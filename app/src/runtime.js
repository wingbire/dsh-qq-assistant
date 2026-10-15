import { createCoalescer, pickAnchor } from "./coalesce.js";
import { splitReply } from "./split.js";
import { createBudget } from "./budget.js";
import { createBrakes } from "./brakes.js";
import { createDefaultCommands } from "./commands.js";
import { createMemeLibrary, shouldAttachMeme } from "./meme.js";
import { resolveLocalImage, downloadImage, injectVision } from "./vision.js";
import { parseVoiceTag } from "./tts.js";
import { parseIllustration, illustrationFor, parseChart } from "./dshprofile.js";
import { resolveChartFile, cleanupChart } from "./chart.js";
import { WORKSPACE_ROOT } from "./paths.js";
import fs from "node:fs";
import path from "node:path";
import { localReply, createLocalReplies } from "./localreply.js";
import { createUiMessages } from "./uimessages.js";
import { createStt, resolveLocalAudio, downloadAudio } from "./stt.js";
import { depthPolicy, buildTaskText } from "./brain.js";
import { parseMeme } from "./audit.js";
import { injectSummary } from "./search.js";
import { createTracker } from "./feedback.js";
import { createLabelQueue } from "./label.js";

// P1 接入层装配。所有外部副作用（send / askBrain / now / rng / store）都可注入，
// 所以整套流程能在没有 QQ、没有模型的情况下被测试。
// 大脑在正文里写 [引用] → 这条回复做成"引用回复"（引用它正在回应的那条消息）
export function parseQuoteMarker(text) {
  const s = String(text == null ? "" : text);
  const m = s.match(/\[引用(?:\s*[:：]\s*([^\]]*))?\]/);
  if (!m) return { text: s, wanted: false };
  return { text: s.replace(m[0], "").trim(), wanted: true };
}

export function createRuntime(deps) {
  const d = deps || {};
  const cfg = d.config || {};
  const rc = d.runtime || {};
  const store = d.store || null;
  const bot = d.bot;
  const send = d.send || function () { return false; };
  const askBrain = d.askBrain || null;
  const searchSvc = d.search || null;
  const memes = d.memes || createMemeLibrary({});
  const vision = d.vision || null;              // N18：识图（独立一次多模态调用）
  const tts = d.tts || null;                    // N18：TTS → NapCat 发语音
  const sendRecord = d.sendRecord || null;
  const imageDir = d.imageDir || null;          // 下载下来的图片落哪儿
  const sendImage = d.sendImage || null;
  const repliesSinceMeme = new Map();      // gid -> 距上次配图过了几次回复（「少」档要拉开间隔）
  const now = d.now || function () { return Date.now(); };
  const rng = d.rng || Math.random;
  const log = d.log || function () {};
  const sleep = d.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const sendGapMs = d.sendGapMs != null ? d.sendGapMs : 400;

  const evtDefaults = d.evtDefaults || {};      // botNames / nicknames / interests 等，来自人设配置
  const lastBot = new Map();                    // gid -> { lastBotText, lastBotAt }，供「连续性」特征用
  // N8（修订）：成员表初始为空，首次收到该成员消息时再加 —— 不再启动时全量拉群成员
  const members = new Map();                    // gid -> Map(uid -> { speaker, role, firstSeen, lastSeen, count })
  // N8（修订）：上下文窗口放在 prompt 最后，前面只放本轮任务与资料，避免前置变量打散缓存
  const history = new Map();                    // gid -> [{ speaker, text, at }]  最多 contextWindow 条
  // N9（修订）：观察只在新群初期，攒满 observeUntilMessages 条后进半自动，semiAutoDays 天后全自动
  const stages = new Map();                     // gid -> { stage, observed, semiUntil, since }
  // N9 补丁：分群阶段（尤其是"手动跳过观察期"）必须**活过重启**。
  // 之前这份状态只活在内存 Map 里：用户点了「跳过观察期」，程序一重启就回到观察期，
  // 看起来像"按钮没用"—— 其实是被重启复位了。观察计数同理（否则永远攒不够 80 条）。
  const stageFile = d.stageFile || (store && store.paths ? store.paths.stages : null);
  function loadStages() {
    if (!stageFile) return;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(stageFile, "utf8")); } catch (e) { return; }
    for (const k of Object.keys(raw || {})) {
      const v = raw[k];
      if (v && typeof v === "object") stages.set(String(k), v);
    }
  }
  let stageSaveTimer = null;
  function saveStages(immediate) {
    if (!stageFile) return;
    if (!immediate) {                                  // 普通路径攒一下再写，别每条消息都落盘
      if (stageSaveTimer) return;
      stageSaveTimer = setTimeout(function () { stageSaveTimer = null; saveStages(true); }, 1000);
      if (stageSaveTimer.unref) stageSaveTimer.unref();
      return;
    }
    try {
      const out = {};
      for (const [k, v] of stages.entries()) out[k] = v;
      fs.mkdirSync(path.dirname(stageFile), { recursive: true });
      fs.writeFileSync(stageFile, JSON.stringify(out, null, 1), "utf8");
    } catch (e) {}
  }
  loadStages();
  // 配置端「状态」页要用的：分群计数 + 最近收到的消息（内存环形缓冲，重启即空；
  // 需要跨重启看判定过程时配置端会回落到 observation.jsonl）
  const perGroup = new Map();                   // gid -> { messages, replies, tokens, brainCalls, searches, memes, voice, lastAt }
  // 配置端"收到的消息"缓冲区：落盘 + 每群上限（默认 200）+ 满了按时间丢最旧
  // （以前是内存里 80 条、重启即清 —— 消息一密就没人管得住）
  // P3：反馈归因（按被回复人是否继续跟我聊）+ 人工标注队列
  const tracker = d.tracker || createTracker({ windowMs: rc.feedbackWindowMs != null ? rc.feedbackWindowMs : 90000 });
  const labels = d.labels || (store ? createLabelQueue({ store: store, minSamples: rc.labelMinSamples || 30 }) : null);
  const coalescer = createCoalescer({ windowMs: rc.coalesceWindowMs, maxBatch: rc.coalesceMaxBatch });
  const budget = d.budget || createBudget({ limits: rc.budget, now: now, file: d.budgetFile || (store && store.paths ? store.paths.budget : null) });
  // 本地短答"记住自己说过什么"：同一群最近 6 条不重复，且活过重启
  const localReplies = d.localReplies || createLocalReplies({ rng: rng, file: d.localFile || (store && store.paths ? store.paths.localreplies : null) });
  const getQuote = d.getQuote || null;        // (messageId) => {ok, text, uid, speaker} ：取被引用原文
  const sendPoke = d.sendPoke || null;        // (gid, uid) => {ok} ：回戳
  const pokeSeen = new Map();                 // "gid:uid" -> 上次反应时间（限流，内存态够用）
  const visionCache = new Map();              // 图片 file/url -> {at,text}：同一张图十分钟内只识别一次
  const voiceCache = new Map();               // 音频 file/url -> {at,text}：同一段语音十分钟内只转写一次
  const stt = d.stt || createStt({ config: rc.stt, fetch: d.fetch });
  const brakes = d.brakes || createBrakes({ config: cfg, now: now, file: d.brakesFile || (store && store.paths ? store.paths.brakes : null) });
  // 指令注册表要拿到真的 brakes / budget，所以必须在这两行之后建
  const commands = d.commands || createDefaultCommands({ brakes: brakes, budget: budget, now: now, stopMinutes: rc.stopMinutes || 60 });
  // N18：/说 用来试 TTS（指令清单整体留空，所以这条也走注册表加）
  if (!commands.find("说") && !commands.find("say")) {
    commands.register({
      name: "说", aliases: ["say"], perm: "admin", action: "tts", help: "让小助手用语音说一句话（测试 TTS）",
      handler: async function (a) {
        if (!tts || !tts.enabled()) return { reply: "语音没开（配置端 → 调整 → 语音）" };
        const text = String(a.args || "").trim();
        if (!text) return { reply: "用法：/说 要念的内容" };
        const r = await speak(a.evt.gid, text);
        if (!r.ok) return { reply: "TTS 失败：" + r.error };
        return { reply: null, bytes: r.bytes };
      }
    });
  }

  const stats = { events: 0, ignored: 0, observed: 0, replies: 0, segments: 0, brainCalls: 0, tokens: 0, searchTokens: 0, searches: 0, searchCacheHits: 0, stopped: 0, adminCmds: 0, feedbackResolved: 0, refits: 0, labelCandidates: 0, memesSent: 0, memesMissed: 0, memesSuppressed: 0, proactiveTried: 0, proactiveSpoken: 0, proactiveBlocked: 0, visionCalls: 0, visionOk: 0, visionFail: 0, voiceSent: 0, voiceFailed: 0, illustrationsSent: 0, illustrationsFailed: 0, chartsSent: 0, chartsFailed: 0, pokes: 0, pokesReplied: 0, pokesSkipped: 0, visionCached: 0, voices: 0, voicesTranscribed: 0, sttCalls: 0, sttOk: 0, sttFail: 0, sttCached: 0, brainErrors: 0, brainFallbacks: 0 };
  let busy = false;

  function observe(rec) {
    stats.observed += 1;
    if (store && store.addObservation) { try { store.addObservation(rec); } catch (e) {} }
  }

  function adminConfig() { return cfg.admin || {}; }

  function gstat(gid) {
    const k = String(gid);
    let s = perGroup.get(k);
    if (!s) { s = { gid: k, messages: 0, replies: 0, tokens: 0, brainCalls: 0, searches: 0, memes: 0, voice: 0, lastAt: 0 }; perGroup.set(k, s); }
    return s;
  }
  const uiMessages = d.uiMessages || createUiMessages({
    perGroup: rc.uiMessageLimit,
    file: d.uiMsgFile || (store && store.paths ? store.paths.uimessages : null)
  });
  function pushRecent(gid, rec) { return uiMessages.add(gid, rec); }
  // 控制接口（配置端的快捷按钮）
  function setGroupEnabled(gid, on) {
    if (on) brakes.resumeGroup(gid); else brakes.stopGroup(gid, 999999, now());   // 999999 分钟 = 一直停
    return { gid: String(gid), enabled: !!on };
  }
  function groupEnabled(gid) { return !brakes.state(gid, now()).stopped; }
  function setGlobalPaused(v) {
    brakes.setConfigPaused(v);
    if (cfg) cfg.paused = !!v;
    return !!v;
  }

  function settle(records, atMs) {
    const list = records || [];
    for (const rec of list) {
      stats.feedbackResolved += 1;
      let r = null;
      try { r = bot.observe(rec); } catch (e) { r = null; }
      if (r && r.refit) {
        stats.refits += 1;
        let reflow = null;
        if (labels) {
          const cur = bot.getBounds ? bot.getBounds() : null;
          reflow = labels.reflowIfReady(cur, atMs);
          if (reflow.ready && reflow.changed && bot.setBounds) bot.setBounds(reflow.bounds);
        }
        observe({
          kind: "refit", gid: rec.gid,
          bounds: bot.getBounds ? bot.getBounds() : null,
          rounds: r.profile && r.profile.rounds, flipRate: r.flipRate, missedRate: r.missedRate,
          reflow: reflow ? { ready: !!reflow.ready, n: reflow.n, changed: !!reflow.changed } : null
        });
      }
    }
    return list.length;
  }

  // N15：情绪标记 → 去 dsh-meme 图库取图，按「关/少/中」与档位节制
  async function attachMeme(gid, mood, tier) {
    const key = String(gid);
    const since = repliesSinceMeme.get(key);
    const gate = shouldAttachMeme(tier, mood, {
      freq: rc.memeFreq || "少",
      sinceLastMeme: since == null ? 999 : since,
      replyGapReplies: rc.memeGapReplies != null ? rc.memeGapReplies : 3
    });
    function bump() { const n = repliesSinceMeme.get(key); repliesSinceMeme.set(key, n == null ? 1 : n + 1); }
    bump();
    if (!mood) return null;
    if (!gate.attach) { stats.memesSuppressed += 1; observe({ kind: "meme_suppressed", gid: key, mood: mood, reason: gate.reason }); return null; }
    if (!memes || !memes.ready || !sendImage) { stats.memesMissed += 1; return null; }
    const hit = memes.find(mood);
    if (!hit) { stats.memesMissed += 1; observe({ kind: "meme_miss", gid: key, mood: mood }); return null; }
    sendImage(key, hit.path);
    stats.memesSent += 1;
    repliesSinceMeme.set(key, 0);
    return { tag: hit.tag, file: hit.file, score: hit.score, mood: mood, reason: gate.reason };
  }

  // N18 识图：把这一批里的图片描述出来（最多 2 张），拼进本轮上下文
  async function describeImages(batch) {
    if (!vision || !vision.enabled()) return [];
    const imgs = [];
    for (const e of batch.evts) for (const im of (e.images || [])) imgs.push(im);
    if (!imgs.length) return [];
    const out = [];
    for (const im of imgs.slice(0, 2)) {
      // 同一张图（同 file/url）十分钟内只识别一次 —— 群里常有人反复发同一张图
      const vkey = String(im.file || im.url || "");
      if (vkey) {
        const hit = visionCache.get(vkey);
        if (hit && Date.now() - hit.at < 10 * 60 * 1000) { stats.visionCached += 1; out.push(hit.text); continue; }
      }
      let local = resolveLocalImage(im, { maxBytes: (rc.vision && rc.vision.maxBytes) || undefined });
      if (!local.ok && local.needDownload && im.url && imageDir) local = await downloadImage(im.url, imageDir, {});
      if (!local.ok && im.url && imageDir) local = await downloadImage(im.url, imageDir, {});
      stats.visionCalls += 1;
      const r = await vision.describe(local, {});
      if (r.ok) { stats.visionOk += 1; if (vkey) { visionCache.set(vkey, { at: Date.now(), text: r.text }); if (visionCache.size > 100) { const k = visionCache.keys().next().value; visionCache.delete(k); } } out.push(r.text); }
      else { stats.visionFail += 1; observe({ kind: "vision_fail", gid: batch.gid, error: r.error, file: (im.file || im.url || "").slice(0, 80) }); }
    }
    return out;
  }

  // N18：TTS 统一入口 —— 指令与 [语音:] 标记都走这里，计数与失败上报只有一处。
  // 用异步版合成：spawnSync 会把整个事件循环卡住 1~2 秒（心跳和别的消息全停），不能用在运行时。
  async function speak(gid, text) {
    if (!tts || !tts.enabled()) return { ok: false, error: "语音未启用" };
    const v = tts.synthesizeAsync ? await tts.synthesizeAsync(text) : tts.synthesize(text);
    if (!v.ok) {
      stats.voiceFailed += 1;
      observe({ kind: "voice_fail", gid: gid, error: v.error });
      return { ok: false, error: v.error };
    }
    if (sendRecord) sendRecord(gid, v.file);
    stats.voiceSent += 1;
    observe({ kind: "voice_sent", gid: gid, chars: v.chars, bytes: v.bytes });
    return { ok: true, chars: v.chars, bytes: v.bytes, file: v.file };
  }

  // 引用：把被引用的原文拼进正文（前缀形式），这样它同时参与**本地判定**、进大脑、也进配置端的消息表。
  // 注意：这是"每轮都可能不同"的内容，只会跟着消息体走，不进 system prompt，缓存前缀不受影响。
  function injectQuote(text, quote, from) {
    const q = String(quote || "").trim();
    if (!q) return text;
    const who = String(from || "").trim();
    return "[引用" + (who ? " " + who : "") + "：" + q.slice(0, 200) + "]" + (text ? " " + text : "");
  }
  // 语音：官方转写拿不到（实测 NapCat 不上报）→ 自己送本机 STT；转写结果拼进正文，
  // 于是它跟识图描述一样参与**本地一判**、进大脑、也进配置端消息表。
  async function transcribeVoice(evt) {
    if (!stt || !stt.enabled()) return { ok: false, error: "语音转写未启用" };
    const ref = evt.voiceRef || {};
    const key = String(ref.path || ref.file || ref.url || "");
    if (key) {
      const hit = voiceCache.get(key);
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) { stats.sttCached += 1; return { ok: true, text: hit.text, cached: true }; }
    }
    let local = await resolveLocalAudio(ref, { maxBytes: (rc.stt && rc.stt.maxBytes) || undefined });
    if (!local.ok && local.needDownload && local.url) local = await downloadAudio(local.url, imageDir || null, { fetch: d.fetch, maxBytes: (rc.stt && rc.stt.maxBytes) || undefined });
    if (!local.ok) { stats.sttFail += 1; observe({ kind: "stt_fail", gid: evt.gid, uid: evt.uid, error: local.error || "音频拿不到" }); return { ok: false, error: local.error }; }
    stats.sttCalls += 1;
    const r = await stt.transcribe(local.path);
    if (r.ok) {
      stats.sttOk += 1;
      if (key) { voiceCache.set(key, { at: Date.now(), text: r.text }); if (voiceCache.size > 100) { const k = voiceCache.keys().next().value; voiceCache.delete(k); } }
      observe({ kind: "stt_ok", gid: evt.gid, uid: evt.uid, ms: r.ms, chars: r.text.length, bytes: r.bytes });
      return r;
    }
    stats.sttFail += 1;
    observe({ kind: "stt_fail", gid: evt.gid, uid: evt.uid, error: r.error });
    return r;
  }

  function groupInterests(gid) {
    if (!store || typeof store.loadProfile !== "function") return [];
    const p = store.loadProfile(gid);
    return (p && p.interests) || [];
  }

  // N16：没被点名、但话题撞上兴趣时，在全自动阶段插一句短的。
  // 注意：本地 low 档是「不进大脑」的短句池，但主动搭话没有可回应的对象，短句池说不出内容，
  // 所以这里仍然走一次大脑，只是把档位策略设成 low（≤20 字）。这条偏差记在 设计节点.md §17。
  async function tryProactive(evtLike, batch, atMs) {
    if (rc.proactive && rc.proactive.enabled === false) return null;
    if (stageOf(batch.gid, atMs).stage !== STAGE_FULL) return null;
    if (!budget.allowProactive()) { stats.proactiveBlocked += 1; return null; }
    if (!askBrain || !bot.considerProactive) return null;
    const interests = groupInterests(batch.gid).concat(evtDefaults.interests || []);
    const p = bot.considerProactive(evtLike, { action: "ignore" }, { interests: interests });
    if (!p || !p.speak) return null;
    stats.proactiveTried += 1;
    const NL = String.fromCharCode(10);
    const policy = depthPolicy("low", { contextWindow: rc.contextWindow });
    const ctx = contextBlock(batch.gid);
    const task = "【本轮任务】" + NL
      + "场景：没人在叫你，但话题撞上了你感兴趣的东西（" + (p.reason || "") + "）。" + NL
      + "字数上限：" + (p.maxChars || 20) + NL
      + "直接输出你要插进群里的那一句短话，不要解释，不要问号收尾。";
    // 同样的缓存优先级：概况 → 兴趣词条 → 本轮任务 → 上下文
    const prompt = [profileFactsBlock(batch.gid), profileInterestsBlock(batch.gid), task, ctx].filter(Boolean).join(NL + NL);
    const r = await askBrain({ promptText: prompt, tier: "low", proactive: true, evt: evtLike });
    if (!r || !r.ok || !r.text) { observe({ kind: "proactive_error", gid: batch.gid, error: r ? r.error : null }); return null; }
    const clean = parseMeme(r.text).text;
    const segs = splitReply(clean, p.maxChars || 20, { maxSegments: 1 }).filter(Boolean);
    if (!segs.length) return null;
    for (const s of segs) send(batch.gid, s);
    budget.countGroup(batch.gid, atMs);                         // 主动搭话也算这个群的一次发言
    stats.proactiveSpoken += 1;
    stats.replies += 1;
    observe({ kind: "proactive_sent", gid: batch.gid, reason: p.reason, keywords: p.keywords, text: segs.join("") });
    return { segments: segs, reason: p.reason };
  }

  // N8 + 缓存优先级：群档案拆成两块 —— 少变的（概况 / 本群专属人设）在前，多变的（兴趣词条）在后。
  // 一块里混着放的话，兴趣词条一翻就把后面的"本轮任务"也一起打散。
  function profileFactsBlock(gid) {
    if (!store || typeof store.loadProfile !== "function") return "";
    const prof = store.loadProfile(gid);
    if (!prof) return "";
    const lines = [];
    // 本群专属人设（管理员手写）—— 只能进消息体：进系统提示词的话每个群都要一份 profile，
    // 而且一改就打散前缀缓存。放这里既好改又不影响缓存。
    if (prof.personaText && String(prof.personaText).trim()) {
      lines.push("【本群专属人设（在这个群里额外要遵守的）】" + String.fromCharCode(10) + String(prof.personaText).trim());
    }
    if (prof.rounds > 0) {
      if (bot.profileFacts) { const t = bot.profileFacts(gid); if (t) lines.push(t); }
      else if (bot.profilePrompt) { const t = bot.profilePrompt(gid); if (t) lines.push(t); }   // 旧接口兜底（兴趣词条会并在里面）
    }
    return lines.join(String.fromCharCode(10, 10));
  }
  function profileInterestsBlock(gid) {
    if (!bot.profileInterests || !store || typeof store.loadProfile !== "function") return "";
    const prof = store.loadProfile(gid);
    if (!prof || !prof.rounds) return "";
    return bot.profileInterests(gid) || "";
  }

  const STAGE_OBSERVE = "observe", STAGE_SEMI = "semi", STAGE_FULL = "full";
  const OBSERVE_UNTIL_MESSAGES = rc.observeUntilMessages != null ? rc.observeUntilMessages : 80;   // N9
  const SEMI_AUTO_DAYS = rc.semiAutoDays != null ? rc.semiAutoDays : 3;                            // N9

  function stageOf(gid, nowMs) {
    if (rc.observe === true) return { stage: STAGE_OBSERVE, observed: 0, forced: true };   // 强制观察
    if (rc.observe === false) return { stage: STAGE_FULL, observed: 0, forced: true };     // 强制实际发送
    const key = String(gid);
    let s = stages.get(key);
    // 管理员在配置端手动点过「跳过观察期 / 回到观察」→ 以它为准。
    // 优先级放在强制观察(observe:true)之下、stageMode 之上：手动跳一次不该被全局 stageMode 抵消。
    if (s && s.skippedStage) return s;
    if (rc.stageMode === "live") return { stage: STAGE_FULL, observed: 0, forced: true };
    if (rc.stageMode === "observe") return { stage: STAGE_OBSERVE, observed: 0, forced: true };
    if (!s) { s = { stage: STAGE_OBSERVE, observed: 0, semiUntil: null, since: nowMs }; stages.set(key, s); }
    if (s.stage === STAGE_OBSERVE && s.observed >= OBSERVE_UNTIL_MESSAGES) { s.stage = STAGE_SEMI; s.semiUntil = nowMs + SEMI_AUTO_DAYS * 86400000; s.advancedAt = nowMs; saveStages(); }
    if (s.stage === STAGE_SEMI && s.semiUntil && nowMs >= s.semiUntil) { s.stage = STAGE_FULL; s.advancedAt = nowMs; saveStages(); }
    return s;
  }

  // 手动设定某个群的阶段（配置端那个小按钮走这里）
  //   "full" = 跳过观察期直接全自动；"semi" = 跳到半自动；"auto" = 取消手动、交回阶段机
  function setStage(gid, target) {
    const key = String(gid);
    const t = String(target || "").toLowerCase();
    if (t === "auto") {
      // 交回阶段机：清掉手动标记，并让 stage 回到"按已观察条数重新判定"的状态
      const cur = stages.get(key);
      if (cur) {
        delete cur.skippedStage;
        delete cur.skippedAt;
        cur.stage = cur.observed >= OBSERVE_UNTIL_MESSAGES ? STAGE_SEMI : STAGE_OBSERVE;
        if (cur.stage === STAGE_SEMI) cur.semiUntil = now() + SEMI_AUTO_DAYS * 86400000;
      }
      saveStages(true);
      const s2 = stageOf(key, now());
      return { gid: key, stage: s2.stage, manual: false };
    }
    if (t !== STAGE_OBSERVE && t !== STAGE_SEMI && t !== STAGE_FULL) return { gid: key, error: "阶段只能是 observe / semi / full / auto" };
    let s = stages.get(key);
    if (!s) { s = { stage: STAGE_OBSERVE, observed: 0, semiUntil: null, since: now() }; stages.set(key, s); }
    s.stage = t;
    s.skippedStage = t;                       // 记住"这是手动跳的"
    s.skippedAt = now();
    if (t === STAGE_SEMI) s.semiUntil = now() + SEMI_AUTO_DAYS * 86400000;
    if (t === STAGE_FULL) s.semiUntil = null;
    observe({ kind: "stage_manual", gid: key, stage: t });
    saveStages(true);                                        // 手动改的立刻落盘：下一秒重启也不能丢
    return { gid: key, stage: t, manual: true };
  }

  function rememberMembers(batch) {
    const key = String(batch.gid);
    let m = members.get(key);
    if (!m) { m = new Map(); members.set(key, m); }
    for (const e of batch.evts) {
      const cur = m.get(String(e.uid));
      if (!cur) m.set(String(e.uid), { speaker: e.speaker, role: e.role || "", firstSeen: e.now, lastSeen: e.now, count: 1 });
      else { cur.speaker = e.speaker || cur.speaker; cur.role = e.role || cur.role; cur.lastSeen = e.now; cur.count += 1; }
    }
    return m;
  }

  function pushHistory(batch) {
    const key = String(batch.gid);
    const arr = history.get(key) || [];
    for (const e of batch.evts) arr.push({ speaker: e.speaker, text: e.text, at: e.now });
    const cap = Math.max(0, rc.contextWindow != null ? rc.contextWindow : 10);
    while (cap && arr.length > cap) arr.shift();
    history.set(key, arr);
    return arr;
  }

  // 上下文块 —— 按 N8 修订，它永远排在 prompt 的最后
  function contextBlock(gid) {
    const arr = history.get(String(gid)) || [];
    if (!arr.length) return "";
    return "【群里的上下文（越靠下越新）】" + String.fromCharCode(10)
      + arr.map(function (e) { return (e.speaker ? e.speaker + "：" : "") + e.text; }).join(String.fromCharCode(10));
  }

  // 被戳一戳：不进判定中枢（它不是消息，也不该吃观察期/预算那套），直接走零成本表达层
  async function onPoke(evt) {
    stats.pokes += 1;
    observe({ kind: "poke", gid: evt.gid, uid: evt.uid, targetId: evt.targetId, pokeMe: !!evt.pokeMe });
    if (!evt.pokeMe) return { gid: evt.gid, action: "poke_ignored" };              // 群里互相戳不插手
    if (rc.poke === "关") { stats.pokesSkipped += 1; return { gid: evt.gid, action: "poke_off" }; }
    const nowMs = evt.now || now();
    if (brakes.state(evt.gid, nowMs).stopped) { stats.pokesSkipped += 1; return { gid: evt.gid, action: "poke_blocked" }; }
    const key = String(evt.gid) + ":" + String(evt.uid);
    const last = pokeSeen.get(key);
    const gapMs = rc.pokeGapSec != null ? rc.pokeGapSec * 1000 : 60000;
    if (last != null && nowMs - last < gapMs) { stats.pokesSkipped += 1; observe({ kind: "poke_skipped", gid: evt.gid, uid: evt.uid, reason: "同人限流" }); return { gid: evt.gid, action: "poke_limited" }; }
    pokeSeen.set(key, nowMs);
    const rate = rc.pokeBackRate != null ? Number(rc.pokeBackRate) : 0.35;
    let back = null;
    if (sendPoke && rng() < rate) { try { back = await sendPoke(evt.gid, evt.uid); } catch (e) { back = { ok: false, error: String(e && e.message) }; } }
    const line = back && back.ok ? (rng() < 0.5 ? "别戳我，我也戳你" : "戳回去了") : localReplies.reply({ reason: ["被戳"] }, { gid: evt.gid, text: "__poke__", poke: true, rng: rng });
    if (line) send(evt.gid, line);
    stats.pokesReplied += 1;
    observe({ kind: "poke_replied", gid: evt.gid, uid: evt.uid, back: !!(back && back.ok), text: line });
    return { gid: evt.gid, action: "poke_replied", text: line };
  }

  async function onEvent(evt) {
    if (evt && evt.kind === "poke") return onPoke(evt);
    stats.events += 1;
    // 语音消息：只记"有没有转写 + record 段带了哪些字段名"（不落内容），方便确认 NapCat 给不给官方转写
    if (evt.hasVoice) {
      stats.voices += 1;
      if (evt.voiceText) stats.voicesTranscribed += 1;
      observe({
        kind: "voice_seen", gid: evt.gid, uid: evt.uid, hasText: !!evt.voiceText,
        keys: evt.voiceKeys || [], shape: evt.voiceShape || null,
        topKeys: evt.voiceTopKeys || null, segShape: evt.voiceSegShape || null
      });
    }
    const gs = gstat(evt.gid);
    gs.messages += 1;
    gs.lastAt = evt.now || now();
    pushRecent(evt.gid, {
      at: evt.now || now(), speaker: evt.speaker || "", uid: String(evt.uid || ""),
      text: evt.text || (evt.hasImage ? "[图片]" : ""), hasImage: !!evt.hasImage, images: (evt.images || []).length
    });
    // P3：这条消息同时是「上一条回复」的判决书 —— 先结算
    settle(tracker.resolve(evt), evt.now);
    const st = brakes.state(evt.gid, evt.now);
    if (st.stopped) {
      // 「群内指令暂停」必须能被指令解开，否则一停就再也开不回来。
      // STOP 文件与配置暂停仍然是最高优先，什么指令都进不来。
      const parsed = commands.parse(evt.text);
      const spec = parsed ? commands.find(parsed.name) : null;
      const canUnstick = st.reason === "群内指令暂停" && !!spec;
      if (!canUnstick) {
        stats.stopped += 1;
        observe({ kind: "stopped", gid: evt.gid, reason: st.reason });
        return { action: "stopped", reason: st.reason };
      }
    }

    // N17：指令走注册表 —— 权限判定与二次确认都在 commands.js 里
    const cRes = await commands.dispatch(evt, { config: adminConfig(), budget: budget, brakes: brakes, store: store });
    if (cRes.handled) {
      stats.adminCmds += 1;
      if (cRes.reply) send(evt.gid, cRes.reply);
      observe({ kind: "command", gid: evt.gid, uid: evt.uid, name: cRes.name, ok: !!cRes.ok, action: cRes.action });
      return { action: cRes.action, ok: !!cRes.ok, name: cRes.name, minutes: cRes.minutes, budget: cRes.budget, needsConfirm: !!cRes.needsConfirm };
    }

    coalescer.push(evt);
    return { action: "pending", pending: coalescer.size() };
  }

  async function tick(t) {
    const at = t == null ? now() : t;
    if (busy) return { skipped: "busy" };
    settle(tracker.sweep(at), at);          // 窗口内没人接 → no_one_replied
    const batches = coalescer.flushDue(at);
    if (!batches.length) return { batches: 0, results: [] };
    busy = true;
    const results = [];
    try { for (const b of batches) results.push(await handleBatch(b, at)); }
    finally { busy = false; }
    return { batches: batches.length, results: results };
  }

  async function handleBatch(batch, at) {
    const decisions = [];
    for (const rawEvt of batch.evts) {
      const evt = Object.assign({}, evtDefaults, lastBot.get(String(rawEvt.gid)) || {}, rawEvt);
      // 引用：事件里没带原文就用 get_msg 补一次，然后拼进正文 ——
      // 这样"引用我那条问题回个'对'"这类消息，本地一判也能看懂（不是无意义文本），配置端也看得到。
      if (evt.replyId && !evt.replyQuote && getQuote) {
        try {
          const q = await getQuote(evt.replyId);
          if (q && q.ok && q.text) {
            evt.replyQuote = q.text;
            evt.replyQuoteFrom = q.speaker || q.uid || "";
            evt.text = injectQuote(evt.text, q.text, evt.replyQuoteFrom);
          }
        } catch (e) { /* 取不到就按没有引用处理，绝不编 */ }
      } else if (evt.replyQuote) {
        evt.text = injectQuote(evt.text, evt.replyQuote, evt.replyFrom || "");
      }
      // 图片：识别在这里做（判定之前），描述拼进正文 ——
      // 以前识图在合并之后才注入，纯图片消息在本地就被当"无意义文本"判否，描述白花钱、配置端也看不到。
      if (evt.hasImage && evt.images && evt.images.length) {
        const desc = await describeImages({ gid: batch.gid, evts: [evt] });
        if (desc.length) { evt.visionText = desc.join(" / "); evt.text = injectVision(evt.text, desc); }
        else evt.visionText = null;
      }
      // 语音：官方没转写就用本机 STT 转一次，拼进正文（跟识图同一条路子）
      if (evt.hasVoice && !evt.voiceText && stt && stt.enabled()) {
        const tr = await transcribeVoice(evt);
        if (tr && tr.ok) {
          evt.voiceText = tr.text;
          const base = String(evt.text || "").trim();
          evt.text = (base === "" || base === "[语音]")
            ? "[语音] 转写：" + tr.text
            : base + " [语音转写：" + tr.text + "]";
        }
      }
      const dec = await bot.handleEvent(evt);
      decisions.push(Object.assign({}, dec, { evt: evt }));
      const wantText = rawEvt.text || (rawEvt.hasImage ? "[图片]" : "");
      const patch = {
        verdict: dec.verdict, action: dec.action, pSay: dec.pSay,
        tier: dec.tier, reason: (dec.reason || []).slice(0, 3)
      };
      // 正文被富化过（拼了引用原文 / 识图描述）就把配置端那条也更新掉 —— 否则你在状态页只看到 [图片]
      if (evt.text && evt.text !== wantText) patch.text = evt.text;
      uiMessages.update(batch.gid, function (r) { return !r.verdict && r.text === wantText; }, patch);
      // 历史也用它，进大脑的上下文里才带引用原文 / 识图描述
      if (evt.text) rawEvt.text = evt.text;
      observe({
        kind: "decision", gid: batch.gid, uid: batch.uid, speaker: evt.speaker,
        text: evt.text, atBot: !!evt.atBot, replyToBot: !!evt.replyToBot,
        action: dec.action, verdict: dec.verdict, pSay: dec.pSay, U: dec.U,
        tier: dec.tier, maxChars: dec.maxChars, search: dec.search, keywords: dec.keywords,
        bucket: dec.bucket, arm: dec.arm, reason: dec.reason, injected: dec.injected
      });
    }
    // N23：整批当成一轮来判定 —— 这样这一串里任何一条带 @/回复的硬触发都能生效；
    // 锚点仍取「最近一条单独判定过得去的」，用于把这次回复归属到具体那个人/那条消息。
    const visionTexts = await describeImages(batch);
    // 判定时那份正文（含引用原文、逐条识图描述）优先 —— plainText 是合并前拼的，看不到这些补充
    const judgedText = decisions.map(function (x) { return x.evt && x.evt.text; }).filter(Boolean).join(" ").trim();
    let baseText = judgedText || batch.plainText || batch.text;
    // 有图但一条描述都没拿到（识图没开 / 模型没视觉 / 调用失败）→ 在正文里说清楚，
    // 否则人设写着"你看得到图"、正文只有一个 [图片]，模型会顺着编。
    if (!visionTexts.length && (batch.evts || []).some(function (e) { return e && e.hasImage; })) {
      baseText = (baseText ? baseText + " " : "") + "（这条里的图片没拿到内容：识图没开或识别失败，不要假装看到了，直接说看不到、让对方描述）";
    }
    const mergedEvt = Object.assign({}, evtDefaults, lastBot.get(String(batch.gid)) || {}, {
      gid: batch.gid, uid: batch.uid,
      speaker: (batch.evts[batch.evts.length - 1] || {}).speaker || "",
      text: (visionTexts.length && !visionTexts.every(function (t) { return baseText.indexOf(t) >= 0; })) ? injectVision(baseText, visionTexts) : baseText,
      atBot: !!batch.atBot, replyToBot: !!batch.replyToBot,
      now: batch.lastAt, mergedCount: batch.count
    });
    // learn:false —— 逐条判定时已经学过一遍，合并判定不能再学（修 IDF 学两次）
    const mergedDec = Object.assign({}, await bot.handleEvent(mergedEvt, { learn: false }), { evt: mergedEvt });
    const anchor = pickAnchor(decisions);
    const dec = mergedDec;
    const evt = (anchor && anchor.evt) || mergedEvt;
    const hard = !!(mergedEvt.atBot || mergedEvt.replyToBot);
    // N8 修订：成员表与上下文窗口在这里更新（成员表初始为空，首见即加）
    rememberMembers(batch);
    pushHistory(batch);                     // N8：无论观察还是发送，窗口都要推进
    const stageState = stageOf(batch.gid, at);
    stageState.observed += batch.count;
    saveStages();                                             // 观察计数也要活过重启，否则永远攒不满 80 条
    // N21：观察期把所有判定（**含判否的**）都记成待标注样本。
    // 只记判「要回」的样本是拿不到漏接率的 —— 漏接恰恰藏在判否那些里。
    if (stageState.stage === STAGE_OBSERVE && labels) {
      labels.recordCandidate({
        kind: "review", gid: batch.gid, uid: batch.uid, speaker: evt.speaker, text: evt.text,
        messageId: evt.messageId, localVerdict: dec.verdict, localAction: dec.action,
        priority: dec.action === "ignore" ? "low" : "high",
        pSay: dec.pSay, U: dec.U, tier: dec.tier, bucket: dec.bucket, reason: dec.reason
      });
      stats.labelCandidates += 1;
    }
    if (dec.action === "ignore") {
      stats.ignored += 1;
      observe({ kind: "merged_ignore", gid: batch.gid, uid: batch.uid, mergedCount: batch.count, verdict: dec.verdict, pSay: dec.pSay });
      const pro = await tryProactive(mergedEvt, batch, at);
      return { gid: batch.gid, action: "ignore", merged: batch.count, verdict: dec.verdict, proactive: pro };
    }

    if (!budget.allowReply(hard)) {
      observe({ kind: "budget_block", gid: batch.gid, uid: batch.uid, hard: hard, budget: budget.status() });
      return { gid: batch.gid, action: "budget_block", budget: budget.status() };
    }

    // N9 修订：观察只在新群初期（攒满 OBSERVE_UNTIL_MESSAGES 条），之后半自动、再全自动
    if (stageState.stage === STAGE_OBSERVE) {
      observe({ kind: "observe_only", gid: batch.gid, uid: batch.uid, tier: dec.tier, action: dec.action, mergedCount: batch.count, observed: stageState.observed, until: OBSERVE_UNTIL_MESSAGES });
      return { gid: batch.gid, action: "observe_only", stage: STAGE_OBSERVE, observed: stageState.observed, until: OBSERVE_UNTIL_MESSAGES, tier: dec.tier, merged: batch.count };
    }
    if (stageState.stage === STAGE_SEMI && !hard) {
      observe({ kind: "semi_skip", gid: batch.gid, uid: batch.uid, tier: dec.tier, action: dec.action, mergedCount: batch.count, stage: STAGE_SEMI });
      return { gid: batch.gid, action: "semi_skip", stage: STAGE_SEMI, merged: batch.count };
    }

    // 每群每小时条数上限（N23 的 groupHourlyLimit）：默认 0 = 关闭，配了才生效。
    // 注意这两个函数以前只在 budget.js 里定义、没人调用 —— 配了也不管用。
    if (!budget.groupAllow(batch.gid, at)) {
      observe({ kind: "group_limit", gid: batch.gid, uid: batch.uid, limit: rc.budget.groupHourlyLimit });
      return { gid: batch.gid, action: "group_limit", limit: rc.budget.groupHourlyLimit };
    }

    let text = "";
    let usage = null;
    let searchInfo = null;
    if (dec.action === "local_short") {
      text = localReplies.reply(dec, { rng: rng, text: evt.text, gid: evt.gid, quoted: !!evt.replyId });
    } else if (dec.action === "brain") {
      if (!askBrain) return { gid: batch.gid, action: "brain_unavailable" };
      const dc = (Array.isArray(rc.depthChars) && rc.depthChars.length >= 3) ? rc.depthChars : [20, 60, 200];
      const policy = depthPolicy(dec.tier, {
        contextWindow: rc.contextWindow,
        depthPolicy: { low: { maxChars: dc[0] }, mid: { maxChars: dc[1] }, high: { maxChars: dc[2] } }   // 配置里的"三档字数"真的生效
      });
      let taskText = buildTaskText(dec.tier, Object.assign({}, policy, { search: dec.search }), dec.keywords);
      // N12：需要搜索时先搜一次，把摘要作为消息体注入（不进系统提示词，前缀缓存不受影响）
      if (dec.search > 0 && searchSvc) {
        const sr = await searchSvc.run({ gid: evt.gid, keywords: dec.keywords || [], mode: rc.searchMode, ctx: { evt: evt, decision: dec } });
        searchInfo = { ok: !!sr.ok, backend: sr.backend || null, cached: !!sr.cached, ms: sr.ms || 0, error: sr.error || null, chars: (sr.summary || "").length };
        if (sr.ok && sr.summary) taskText = injectSummary(taskText, sr.summary);
        if (sr.usage) { const st2 = Number(sr.usage.totalTokens) || 0; budget.record(st2, at); stats.tokens += st2; stats.searchTokens += st2; }
        stats.searches += 1;
        if (sr.cached) stats.searchCacheHits += 1;
      }
      // 缓存优先级（默认生效，无需配置）：**少变的在前，易变的在后** ——
      //   ① 群档案概况（本群专属人设 +【本群画像】）      每 refN 次提炼才变
      //   ② 群档案兴趣词条【本群兴趣词条】                提炼时容易翻，还影响主动搭话
      //   ③ 本轮任务（档位 / 字数 / 搜索摘要）            每轮都变
      //   ④ 群里的上下文                                  每轮必变
      //   ⑤ 本轮图片描述                                  最易变
      // 全局人设（稳定段 + 可变段）在 system prompt（personaPrefix）里，永远排最前，不受这里影响。
      const blocks = [];
      const pFacts = profileFactsBlock(evt.gid);
      if (pFacts) blocks.push(pFacts);
      const pInterests = profileInterestsBlock(evt.gid);
      if (pInterests) blocks.push(pInterests);
      blocks.push(taskText);
      const ctxBlock = contextBlock(evt.gid);
      if (ctxBlock) blocks.push(ctxBlock);
      if (visionTexts.length) blocks.push(injectVision("", visionTexts).trim());
      const prompt = blocks.filter(Boolean).join(String.fromCharCode(10, 10));
      stats.brainCalls += 1;
      const r = await askBrain({ promptText: prompt, tier: dec.tier, decision: dec, evt: evt });
      usage = r && r.usage ? r.usage : null;
      if (usage) { const tok = Number(usage.totalTokens) || (Number(usage.inputTokens) + Number(usage.outputTokens) + Number(usage.cacheReadTokens) + Number(usage.cacheWriteTokens)); budget.record(tok, at); stats.tokens += tok; }
      if (!r || !r.ok) {
        const err = String((r && r.error) || "no result");
        stats.brainErrors += 1;
        observe({ kind: "brain_error", gid: batch.gid, uid: batch.uid, error: err, tier: dec.tier });
        // 大脑没用上（没装 DSH / 超时 / key 不对）时**被点名的不能一声不吭** ——
        // 以前这里直接 return，用户在群里 @ 她一句，后台只看得到判定、群里一个字都没有。
        const aimed = !!(evt.atBot || evt.atAll || dec.verdict === "yes");
        let fallback = null;
        if (aimed && !brakes.state(batch.gid, at).stopped) {
          fallback = localReplies.reply({ reason: ["大脑挂了"] }, { gid: batch.gid, text: evt.text || "", rng: rng, brainDown: true, bucket: dec.bucket });
          if (fallback) {
            send(batch.gid, fallback);
            stats.brainFallbacks += 1;
            stats.replies += 1;
            observe({ kind: "sent", gid: batch.gid, uid: batch.uid, speaker: evt.speaker, tier: dec.tier, mergedCount: batch.count, segments: [fallback], fallback: "brain_error", error: err });
          }
        }
        // 后台那行也要说清楚为什么没回复（不然只有一个"判定"看不明白）
        uiMessages.update(batch.gid, function (x) { return String(x.text || "") === String(evt.text || ""); },
          { note: "大脑没用上（" + err.slice(0, 46) + "）" + (fallback ? " → 已发本地兜底" : " → 没回复") });
        return { gid: batch.gid, action: "brain_error", error: err, fallback: fallback };
      }
      text = r.text || "";
    } else {
      return { gid: batch.gid, action: "noop" };
    }

    const quoted2 = parseQuoteMarker(text || "");    // [引用] → 这条做成引用回复
    text = quoted2.text;
    // 什么时候引用（不定死）：模型主动写 [引用]，或对方这条本来就是用引用发来的（在接某条线）。
    // "自动"= 这两种情况；"仅标记"= 只听模型的；"关"= 从不引用。高档长回答不引用（像客服）。
    const useQuoteReply = !!evt.messageId && dec.tier !== "high" &&
      (quoted2.wanted || (rc.quoteReply === "自动" && !!evt.replyId));
    const voiced = parseVoiceTag(text || "");        // N18：先摘 [语音: 文本]
    const drawn = parseIllustration(voiced.text);    // 再摘 [立绘] / [立绘: 幼年]
    const chart = parseChart(drawn.text);            // 再摘 [图表: 路径]（archify 画的图）
    const parsed = parseMeme(chart.text);
    const segments = splitReply(parsed.text, dec.maxChars || 60, { maxSegments: rc.maxSegments });
    const sent = [];
    for (let i = 0; i < segments.length; i++) {
      if (!segments[i]) continue;
      send(evt.gid, segments[i], (i === 0 && useQuoteReply) ? { replyTo: evt.messageId } : undefined);
      sent.push(segments[i]);
      stats.segments += 1;
      if (i < segments.length - 1 && sendGapMs > 0) await sleep(sendGapMs);
    }
    if (sent.length) budget.countGroup(evt.gid, at);            // 记一次"这个群这一小时发过了"
    // N18：语音（默认关闭）—— 有标记才念，念不出来不影响正文
    let voiceInfo = null;
    if (voiced.voice) {
      const v = await speak(evt.gid, voiced.voice);
      voiceInfo = v.ok ? { chars: v.chars, bytes: v.bytes } : { error: v.error };
    }
    // 立绘：[立绘] 发当前形态的图，[立绘: 幼年] 临时换形态
    let artInfo = null;
    if (drawn.wanted && (!rc.plugins || rc.plugins.illustration !== false)) {
      const pick = illustrationFor(drawn.stage,
        rc && rc.illustrations ? rc.illustrations.young : null,
        rc && rc.illustrations ? rc.illustrations.adult : null);
      const abs = path.isAbsolute(pick.rel) ? pick.rel : path.resolve(WORKSPACE_ROOT, pick.rel);
      if (fs.existsSync(abs)) {
        if (sendImage) sendImage(evt.gid, abs);
        stats.illustrationsSent += 1;
        artInfo = { stage: pick.stage, file: path.basename(abs) };
      } else {
        stats.illustrationsFailed += 1;
        artInfo = { error: "找不到立绘：" + pick.rel };
      }
    }
    // 图表：archify 画完把 PNG 路径写在 [图表: …] 里，程序发出去；按配置发完就删（群聊里不留图）
    let chartInfo = null;
    if (chart.wanted && (!rc.plugins || rc.plugins.archify !== false)) {
      // archify 产出的是 HTML，先转成 PNG 再发（找不到浏览器就如实失败）
      const conv = resolveChartFile(chart.file, {
        root: WORKSPACE_ROOT,
        outDir: path.join(WORKSPACE_ROOT, "app", "dsh-data", "charts")
      });
      if (conv.ok) {
        if (sendImage) sendImage(evt.gid, conv.file);
        stats.chartsSent += 1;
        const keep = rc.plugins && rc.plugins.archifyCleanup === false;
        const cleaned = keep ? { removed: [], kept: [conv.file] } : cleanupChart(conv.file, { source: conv.source });
        chartInfo = { file: path.basename(conv.file), converted: !!conv.converted, removed: cleaned.removed.length, kept: keep };
      } else {
        stats.chartsFailed += 1;
        chartInfo = { error: conv.error };
      }
    }
    const memeInfo = await attachMeme(evt.gid, parsed.mood, dec.tier);
    stats.replies += 1;
    {
      const gs = gstat(evt.gid);
      gs.replies += 1;
      gs.brainCalls += (dec.action === "brain" ? 1 : 0);
      gs.searches += (searchInfo ? 1 : 0);
      gs.memes += (memeInfo ? 1 : 0);
      gs.voice += (voiceInfo && voiceInfo.bytes ? 1 : 0);
      if (usage) {
        const tk = Number(usage.totalTokens) || (Number(usage.inputTokens) + Number(usage.outputTokens) + Number(usage.cacheReadTokens) + Number(usage.cacheWriteTokens));
        gs.tokens += tk;
      }
    }
    if (bot.proactive && bot.proactive.markBotReply) bot.proactive.markBotReply(at, evt.gid);
    lastBot.set(String(evt.gid), { lastBotText: sent.join(""), lastBotAt: at });
    // P3：登记一条待定反馈，等这个群的下一条消息来判它是正还是负
    tracker.noteReply({
      gid: evt.gid, uid: evt.uid, arm: dec.arm, bucket: dec.bucket, tokens: dec.keywords || [],
      at: at, tier: dec.tier, segments: sent.length, botNames: (evtDefaults.botNames || []).slice(),
      inTokens: usage ? Number(usage.inputTokens) || 0 : 0, outTokens: usage ? Number(usage.outputTokens) || 0 : 0
    });
    observe({
      kind: "sent", gid: batch.gid, uid: batch.uid, speaker: evt.speaker, tier: dec.tier,
      mergedCount: batch.count, mood: parsed.mood || null, memePending: parsed.mood || null,
      reply: { used: !!useQuoteReply, wanted: !!(typeof quoted2 !== "undefined" && quoted2 && quoted2.wanted), mode: rc.quoteReply, auto: !!(typeof quoted2 !== "undefined" && quoted2 && !quoted2.wanted && useQuoteReply) },
      segments: sent, usage: usage, cacheHitRate: r0(usage), search: searchInfo, meme: memeInfo, voice: voiceInfo, art: artInfo, chart: chartInfo, vision: visionTexts.length ? visionTexts : null
    });
    return { gid: batch.gid, action: "sent", tier: dec.tier, merged: batch.count, segments: sent, usage: usage, mood: parsed.mood || null, search: searchInfo, meme: memeInfo, voice: voiceInfo, art: artInfo, vision: visionTexts.length ? visionTexts : null };
  }

  function r0(usage) {
    if (!usage) return null;
    const denom = (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0);
    return denom > 0 ? Math.round(((Number(usage.cacheReadTokens) || 0) / denom) * 1000) / 1000 : 0;
  }

  function status() {
    return {
      mode: rc.observe === true ? "observe" : rc.observe === false ? "live" : (rc.stageMode || "auto"),
      stats: Object.assign({}, stats),
      pending: coalescer.size(),
      budget: budget.status(),
      brakes: brakes.info()
    };
  }

  return {
    onEvent: onEvent, tick: tick, status: status,
    coalescer: coalescer, budget: budget, brakes: brakes, localReplies: localReplies,
    members: function (gid) { const m = members.get(String(gid)); return m ? Object.fromEntries(m) : {}; },
    history: function (gid) { return (history.get(String(gid)) || []).slice(); },
    stage: function (gid) { return Object.assign({}, stageOf(gid, now())); },
    setStage: setStage,
    tracker: tracker, labels: labels,
    groups: function () { return Array.from(perGroup.values()).sort(function (a, b) { return b.lastAt - a.lastAt; }); },
    groupStats: function (gid) { return Object.assign({}, gstat(gid)); },
    // 注意：这两个都给"最新在上"（配置端盯着看，最新的那行该在最上面）
    recentMessages: function (gid, limit) { return uiMessages.list(gid, limit).reverse(); },
    allRecent: function (limit) { return uiMessages.all(limit).reverse(); },
    uiMessages: uiMessages,
    setGroupEnabled: setGroupEnabled, groupEnabled: groupEnabled,
    setGlobalPaused: setGlobalPaused, globalPaused: function () { return !!brakes.info().configPaused; },
    pendingFeedback: function () { return tracker.pendingCount(); },
    labelStatus: function () { return labels ? labels.status() : null; },
    observe: observe, stats: function () { return Object.assign({}, stats); }
  };
}
