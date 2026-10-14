import { maskUntrusted, normalizeName, isInstructionLike } from "./untrusted.js";
import { classify } from "./classify.js";
import { createAddressee } from "./addressee.js";
import { utilityScore, UTILITY_WEIGHTS, TIERS, gateFactor, clamp01 } from "./utility.js";
import { valve, depthTier, searchPlan, clampBounds, DEFAULT_BOUNDS } from "./gatescore.js";
import { bucketOf } from "./bandit.js";
import { audit } from "./audit.js";

export const DEFAULT_COST_SCALE = 900;

const DETAIL_WORDS = ["详细", "解释", "原因", "原理", "文档", "步骤", "教程", "为什么", "写"];
const QUESTION_WORDS = ["怎么", "如何", "为什么", "是什么", "在哪", "有没有", "吗", "咋"];

export function hardTrigger(evt, names) {
  const t = evt.text || "";
  const hits = [];
  if (evt.atBot) hits.push("at");
  if (evt.replyToBot) hits.push("reply");
  for (const n of (names || [])) if (n && t.includes(n)) { hits.push("nick"); break; }
  let strength = 0;
  if (hits.includes("at")) strength = 1;
  else if (hits.includes("reply")) strength = 0.9;
  else if (hits.includes("nick")) strength = 0.7;
  return { hits: hits, strength: strength };
}

function hasAny(text, words) {
  for (const w of words) if (text.includes(w)) return true;
  return false;
}

function signalOf(signals, key) {
  for (const s of signals) if (s.k === key) return s;
  return { v: 0, w: 0 };
}

export function createGates(opts) {
  const o = opts || {};
  const addressee = createAddressee({ weights: o.weights });
  const banditRef = o.bandit || null;
  let bounds = clampBounds(o.bounds || DEFAULT_BOUNDS);
  const tiers = Object.assign({}, TIERS, o.tiers || {});
  const W = Object.assign({}, UTILITY_WEIGHTS, o.utilityWeights || {});

  async function decide(evt, ctx) {
    const context = ctx || {};
    const raw = evt.text || "";
    const text = maskUntrusted(raw);
    const nicknames = (evt.nicknames || []).map(normalizeName);
    const botNames = (evt.botNames || []).concat(nicknames).map(normalizeName).filter(Boolean);
    const reason = [];
    const injected = isInstructionLike(raw);
    if (injected) reason.push("外部文本疑似注入 → 已标记，不执行");

    // 合并判定时不能重复学（否则 IDF 语料把同一句话算两遍）
    if (context.learn !== false) addressee.learn(evt.gid, text);
    const hard = hardTrigger(Object.assign({}, evt, { text: text }), botNames);
    if (hard.strength > 0) reason.push("硬触发:" + hard.hits.join("+"));

    const j = addressee.judge(evt.gid, {
      text: text, userId: evt.uid, atBot: evt.atBot, replyToBot: evt.replyToBot,
      replyToOther: evt.replyToOther, botNames: evt.botNames || [], nicknames: nicknames,
      groupNames: evt.groupNames || [], lastBotText: evt.lastBotText, lastBotAt: evt.lastBotAt, now: evt.now
    });

    const cls = classify(text, { interests: evt.interests || [] });
    const detailAsk = cls.flags.isDetailAsk;
    const questionWord = cls.flags.isQuestion || cls.flags.isRequest;
    if (detailAsk) cls.topicDepth = Math.max(cls.topicDepth, 2);
    const bucket = bucketOf(cls.buckets);

    let pSay = j.conf;
    if (injected) pSay = pSay * 0.5;

    const v0 = valve(pSay, bounds);
    let verdict = v0.verdict;
    if (verdict === "no" && hard.strength > 0) { verdict = "grey"; reason.push("硬触发地板：至少一句短的"); }

    const sem = signalOf(j.signals, "idfOverlapToMyWords").v;
    const cont = signalOf(j.signals, "continuation").v;
    const demand = Math.max(signalOf(j.signals, "questionNoAt").v, questionWord ? 1 : 0, detailAsk ? 1 : 0);

    const diff = clamp01(0.15 + 0.25 * cls.topicDepth + (detailAsk ? 0.25 : 0) + (text.length > 60 ? 0.1 : 0));
    const estOut = 20 + 30 * cls.topicDepth + (detailAsk ? 120 : 0);
    const estIn = 120 + text.length;
    const cost = estIn + 2 * estOut;
    const costScale = Math.max(1, context.costScale || DEFAULT_COST_SCALE);
    const gate = gateFactor(hard.strength, W);

    const u = utilityScore({
      pSay: pSay, sem: sem, cont: cont, demand: demand, diff: diff,
      cost: cost, costScale: costScale, gate: verdict === "grey" ? Math.max(0.5, gate) : gate,
      eng: 1, topicDepth: cls.topicDepth, weights: W
    });

    let tierInfo = { tier: "low", maxChars: 20, reason: "判否" };
    let plan = { search: 0, keywords: [] };
    let auditRes = null;

    if (verdict === "no") {
      reason.push("本地判否 → 不回复、不进大脑");
    } else {
      tierInfo = depthTier(u.U, tiers);
      if (detailAsk && hard.strength >= 0.9) tierInfo = { tier: "high", maxChars: 200, reason: "被点名且要求详细 → 强制高深度" };
      plan = searchPlan(tierInfo.tier, cls.keywords);
      reason.push("深度分档：" + tierInfo.reason);
      if (tierInfo.tier === "high") {
        auditRes = await audit(text, { botNames: botNames, nicknames: nicknames });
        reason.push("高深度 → 外审一次：" + auditRes.verdict);
        if (auditRes.verdict === "no") {
          tierInfo = { tier: "low", maxChars: 20, reason: "外审判否 → 压到短句" };
          plan = { search: 0, keywords: [] };
        } else if (auditRes.verdict === "unsure" && verdict === "grey") {
          tierInfo = { tier: "mid", maxChars: 60, reason: "本地灰 + 外审不确定 → 收到中档" };
          plan = searchPlan("mid", cls.keywords);
        }
      }
    }

    let action = "ignore";
    if (verdict !== "no") action = tierInfo.tier === "low" ? "local_short" : "brain";
    if (action === "local_short") reason.push("低深度 → 不进大脑，本地短句");

    let arm = "standard";
    if (action !== "ignore" && banditRef) {
      const pick = banditRef.choose(bucket, evt.gid);
      arm = pick.arm;
      reason.push("话风臂：" + arm);
    }

    return {
      gid: evt.gid, uid: evt.uid, at: evt.now || Date.now(),
      action: action, verdict: verdict, pSay: Math.round(pSay * 1000) / 1000,
      U: Math.round(u.U * 1000) / 1000,
      tier: tierInfo.tier, maxChars: tierInfo.maxChars,
      search: plan.search, keywords: plan.keywords,
      bucket: bucket, arm: arm, topicDepth: cls.topicDepth, detailAsk: detailAsk,
      audit: auditRes ? auditRes.verdict : "none",
      score: u.parts, signals: j.signals, reason: reason, bounds: v0.bounds, injected: injected
    };
  }

  function setBounds(b) { bounds = clampBounds(b); return bounds; }
  function getBounds() { return bounds; }
  return { decide: decide, addressee: addressee, setBounds: setBounds, getBounds: getBounds, tiers: tiers };
}
