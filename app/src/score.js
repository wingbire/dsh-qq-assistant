export const TOKEN_WEIGHT = { input: 1, output: 2 };

export function costOf(ev) {
  return (ev.inTokens || 0) * TOKEN_WEIGHT.input + (ev.outTokens || 0) * TOKEN_WEIGHT.output;
}

export function costScaleOf(events, fallback) {
  const list = events || [];
  if (list.length === 0) return fallback || 60;
  let sum = 0;
  for (const e of list) sum += costOf(e);
  return Math.max(1, sum / list.length);
}

export function engagementOf(ev) {
  if (ev.outcome === "continued_with_bot") return ev.nickCall ? 4 : 2;
  if (ev.outcome === "went_to_others") return -1;
  if (ev.outcome === "annoyed") return -2;
  return 0;
}

export function reward(ev, cfg, scale) {
  const lambda = (cfg && cfg.lambda != null) ? cfg.lambda : 1.0;
  const s = Math.max(1, scale || 1);
  return engagementOf(ev) - lambda * (costOf(ev) / s);
}

export function rewardStats(events, cfg, scale) {
  const list = events || [];
  if (list.length === 0) return { n: 0, mean: 0 };
  let sum = 0;
  for (const e of list) sum += reward(e, cfg, scale);
  return { n: list.length, mean: sum / list.length };
}

export function defaultScoreConfig() {
  return { lambda: 1.0, alpha: 0.25, beta: 0.8, refN: 20 };
}
