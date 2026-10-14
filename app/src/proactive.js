import { classify } from "./classify.js";

export const PROACTIVE_DEFAULTS = {
  enabled: true,
  rate: 0.25,
  minGapSec: 120,
  maxPerHour: 6,
  requireInterest: true,
  tier: "low",
  maxChars: 20,
  cooldownAfterBotReplySec: 60
};

export function createProactive(opts) {
  const o = opts || {};
  const cfg = Object.assign({}, PROACTIVE_DEFAULTS, o.config || {});
  const rng = o.rng || Math.random;
  const perGroup = new Map();
  const log = [];

  function st(gid) {
    const k = String(gid == null || gid === "" ? "default" : gid);
    let s = perGroup.get(k);
    if (!s) { s = { gid: k, lastSpokeAt: 0, lastBotReplyAt: 0, recent: [] }; perGroup.set(k, s); }
    return s;
  }

  function consider(evt, decision, ctx) {
    const now = Number(evt.now) || Date.now();
    const s = st(evt.gid);
    s.recent = s.recent.filter(function (t) { return now - t < 3600000; });

    if (!cfg.enabled) return { speak: false, reason: "主动模式关闭", gid: s.gid };
    if (decision && decision.action && decision.action !== "ignore") return { speak: false, reason: "本轮已有回复动作，不抢话", gid: s.gid };
    if (evt.atBot || evt.replyToBot) return { speak: false, reason: "被点名，由判定中枢处理", gid: s.gid };
    if (evt.uid && ctx && ctx.botUid && String(evt.uid) === String(ctx.botUid)) return { speak: false, reason: "自己发的", gid: s.gid };
    if (s.lastBotReplyAt && now - s.lastBotReplyAt < cfg.cooldownAfterBotReplySec * 1000) return { speak: false, reason: "刚回过话", gid: s.gid };
    if (s.recent.length >= cfg.maxPerHour) return { speak: false, reason: "本群本小时配额用尽(" + s.recent.length + "/" + cfg.maxPerHour + ")", gid: s.gid };
    if (s.lastSpokeAt && now - s.lastSpokeAt < cfg.minGapSec * 1000) return { speak: false, reason: "本群主动冷却中", gid: s.gid };

    const cls = classify(evt.text || "", { interests: (ctx && ctx.interests) || [] });
    const hit = cls.interestHit;
    if (cfg.requireInterest && hit.length === 0) return { speak: false, reason: "未命中兴趣", keywords: cls.keywords, gid: s.gid };
    if (rng() > cfg.rate) return { speak: false, reason: "概率未过(" + cfg.rate + ")", keywords: cls.keywords, gid: s.gid };

    return {
      speak: true, tier: cfg.tier, maxChars: cfg.maxChars, gid: s.gid,
      reason: "兴趣命中：" + hit.join("、"),
      keywords: hit.concat(cls.keywords).slice(0, 5),
      bucket: cls.buckets[0] || "general"
    };
  }

  function markSpoken(now, gid) { const s = st(gid); s.lastSpokeAt = Number(now) || Date.now(); s.recent.push(s.lastSpokeAt); }
  function markBotReply(now, gid) { st(gid).lastBotReplyAt = Number(now) || Date.now(); }
  function state(gid) {
    if (gid != null && gid !== "") { const s = st(gid); return { gid: s.gid, lastSpokeAt: s.lastSpokeAt, lastBotReplyAt: s.lastBotReplyAt, hourCount: s.recent.length }; }
    const out = {};
    for (const [k, s] of perGroup) out[k] = { lastSpokeAt: s.lastSpokeAt, lastBotReplyAt: s.lastBotReplyAt, hourCount: s.recent.length };
    return out;
  }
  function config() { return cfg; }

  return { consider: consider, markSpoken: markSpoken, markBotReply: markBotReply, state: state, config: config };
}
