import { createStore } from "./store.js";
import { createGates } from "./gates.js";
import { createBandit } from "./bandit.js";
import { reward, costScaleOf, defaultScoreConfig } from "./score.js";
import { refitProfile, buildProfilePrompt, clampParams } from "./profile.js";
import { findMeme, shouldAttachMeme, parseMeme } from "./audit.js";
import { adaptBounds } from "./gatescore.js";
import { createProactive } from "./proactive.js";

export function createBot(opts) {
  const o = opts || {};
  const store = o.store || createStore(o.dataRoot);
  const score = Object.assign({}, defaultScoreConfig(), o.score || {});
  const bandit = createBandit({ rng: o.rng, priorVar: 4 });
  const gates = createGates({
    bandit: bandit, bounds: o.bounds, tiers: o.tiers, utilityWeights: o.utilityWeights,
    rescueAsk: o.rescueAsk, blockInjected: o.blockInjected, audit: o.audit
  });
  const proactive = createProactive({ config: o.proactive, rng: o.rng });

  if (o.restore !== false) {
    const saved = store.loadBandit();
    if (saved && saved.state) bandit.hydrate(saved.state);
  }

  const feedback = [];
  const auditOutcomes = [];
  let replies = 0;
  const refN = score.refN || 20;

  async function handleEvent(evt, opts) {
    const o = opts || {};
    const decision = await gates.decide(evt, { costScale: costScaleOf(feedback, 900), learn: o.learn });
    decision.memeHint = decision.tier === "high" ? null : (decision.tier === "mid" ? "（可配图，情绪明确时）" : "（可配图）");
    return decision;
  }

  async function say(evt, text) {
    const parsed = parseMeme(text);
    const entry = findMeme(parsed.mood);
    const attach = shouldAttachMeme("mid", parsed.mood) && !!entry;
    return {
      body: parsed.text,
      meme: attach ? entry.name : null,
      mood: parsed.mood
    };
  }

  function observe(fb) {
    const rec = Object.assign({ at: new Date().toISOString() }, fb);
    feedback.push(rec);
    if (rec.arm && rec.bucket) {
      const r = reward(rec, score, costScaleOf(feedback, 900));
      bandit.update(rec.bucket, rec.arm, r, rec.gid);
      rec.reward = Math.round(r * 1000) / 1000;
      scheduleSave();                       // 学到的 arm 权重也要活过重启（托盘是强杀，SIGINT 那条路不会走）
    }
    store.appendJsonl(store.paths.feedback, rec);
    replies += 1;

    if (fb.auditCalled) auditOutcomes.push(fb.auditAgreed ? 1 : 0);
    if (replies % refN === 0) {
      const gid = fb.gid || "unknown";
      const prev = store.loadProfile(gid);
      const prof = refitProfile(feedback.filter(function (x) { return String(x.gid) === String(gid); }), prev, { exclude: (o.botNames || []).concat(o.nicknames || []) });
      store.saveProfile(gid, prof);
      const flipRate = auditOutcomes.length ? auditOutcomes.filter(function (x) { return x === 0; }).length / auditOutcomes.length : 0;
      const missedRate = feedback.slice(-refN).filter(function (x) { return x.outcome === "no_one_replied"; }).length / Math.min(refN, Math.max(1, feedback.length));
      const nb = adaptBounds(gates.getBounds(), { auditFlipRate: flipRate, missedRate: missedRate });
      gates.setBounds(nb);
      return { refit: true, profile: prof, prompt: buildProfilePrompt(prof), bounds: nb, flipRate: flipRate, missedRate: missedRate };
    }
    return { refit: false, replies: replies, nextRefitIn: refN - (replies % refN) };
  }

  function saveState() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    store.saveBandit({ state: bandit.state(), at: new Date().toISOString() });
  }

  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = null; saveState(); }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function considerProactive(evt, decision, ctx) {
    const r = proactive.consider(evt, decision, ctx || {});
    if (r.speak) proactive.markSpoken(evt.now || Date.now(), evt.gid);
    return r;
  }

  return {
    store: store, gates: gates, bandit: bandit, score: score, proactive: proactive, considerProactive: considerProactive,
    handleEvent: handleEvent, say: say, observe: observe, saveState: saveState,
    setBounds: function (b) { return gates.setBounds(b); }, getBounds: function () { return gates.getBounds(); },
    feedbackCount: function () { return feedback.length; },
    profilePrompt: function (gid) { return buildProfilePrompt(store.loadProfile(gid) || {}); },
    stats: function () { return { replies: replies, feedback: feedback.length, bounds: gates.getBounds(), bandit: bandit.state() }; }
  };
}
