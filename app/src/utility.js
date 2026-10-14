export const UTILITY_WEIGHTS = {
  w1: 0.40, w2: 0.20, w3: 0.25, w4: 0.15,
  lambda: 0.5, gateLow: 0.15, gateHigh: 0.5
};

export const TOPIC_DEPTH_K = 0.10;

export const TIERS = { speakAt: 0.20, terseAt: 0.35, detailedAt: 0.65 };

export function clamp01(x) {
  if (!isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function gateFactor(strength, W) {
  const w = W || UTILITY_WEIGHTS;
  const s = clamp01(strength);
  return w.gateLow + (w.gateHigh - w.gateLow) * s;
}

export function utilityScore(inp) {
  const W = Object.assign({}, UTILITY_WEIGHTS, inp.weights || {});
  const pSay = clamp01(inp.pSay);
  const sem = clamp01(inp.sem);
  const cont = clamp01(inp.cont);
  const demand = clamp01(inp.demand);
  const diff = clamp01(inp.diff);
  const cost = Math.max(0, inp.cost || 0);
  const costScale = Math.max(1, inp.costScale || 1);
  const gate = inp.gate == null ? 1 : inp.gate;
  const eng = inp.eng == null ? 1 : inp.eng;

  const topicBonus = TOPIC_DEPTH_K * (inp.topicDepth || 0);
  const benefit = (W.w1 * pSay + gate * (W.w2 * sem + W.w3 * cont + W.w4 * demand)) * eng + topicBonus;
  const costTerm = W.lambda * diff * (cost / costScale);
  const U = benefit - costTerm;
  return {
    U: U, benefit: benefit, costTerm: costTerm, gate: gate,
    parts: { pSay: pSay, sem: sem, cont: cont, demand: demand, diff: diff, cost: cost, topicBonus: topicBonus }
  };
}
