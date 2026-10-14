// N14 定型：灰区上下界在 0.30~0.85 之间按步长 0.02 自适应，每 refN(20) 次调一次。
export const DEFAULT_BOUNDS = { lo: 0.40, hi: 0.75, loMin: 0.30, loMax: 0.60, hiMin: 0.60, hiMax: 0.85, step: 0.02 };

export function clampBounds(b) {
  const d = Object.assign({}, DEFAULT_BOUNDS, b || {});
  d.lo = Math.min(d.loMax, Math.max(d.loMin, d.lo));
  d.hi = Math.min(d.hiMax, Math.max(d.hiMin, d.hi));
  if (d.hi <= d.lo) d.hi = Math.min(d.hiMax, d.lo + 0.05);
  return d;
}

export function valve(pSay, bounds) {
  const b = clampBounds(bounds);
  if (pSay < b.lo) return { verdict: "no", bounds: b };
  if (pSay > b.hi) return { verdict: "yes", bounds: b };
  return { verdict: "grey", bounds: b };
}

// 三条线各管一段：< speakAt 只配短句；[speakAt, terseAt) 也是低档（同一档，只是解释不同）；
// >= terseAt 才进中档 = 走大脑；>= detailedAt 高深度。
// 注意顺序：terseAt 一旦小于 speakAt，第二条分支永远走不到 —— UI 上就会写着一个假的"进中档线"。
// 所以这里先把两个数顺序纠正过来，保证"常规线"就是真正的进中档线。
export function depthTier(U, tiers) {
  const t = Object.assign({}, { speakAt: 0.15, terseAt: 0.20, detailedAt: 0.65 }, tiers || {});
  if (t.terseAt < t.speakAt) t.terseAt = t.speakAt;
  // 三档字数：配置给了就用配置的（和 brain.depthPolicy 用同一份，免得流水里记的和实际约束不一致）
  const mc = (Array.isArray(t.maxChars) && t.maxChars.length >= 3) ? t.maxChars : [20, 60, 200];
  if (U < t.speakAt) return { tier: "low", maxChars: mc[0], reason: "U < 开口线" };
  if (U < t.terseAt) return { tier: "low", maxChars: mc[0], reason: "U < 常规线" };
  if (U < t.detailedAt) return { tier: "mid", maxChars: mc[1], reason: "U < 多讲线" };
  return { tier: "high", maxChars: mc[2], reason: "U >= 多讲线" };
}

export function searchPlan(tier, keywords) {
  const kws = (keywords || []).slice(0, 3);
  if (tier === "low") return { search: 0, keywords: [] };
  if (tier === "mid") return { search: kws.length > 0 ? 1 : 0, keywords: kws };
  return { search: 1, keywords: kws };
}

export function adaptBounds(bounds, stat) {
  const b = clampBounds(bounds);
  const s = stat || {};
  const missed = s.missedRate || 0;
  const noisy = s.auditFlipRate || 0;
  if (missed > 0.15) b.lo = Math.max(b.loMin, b.lo - b.step);
  if (noisy > 0.35) b.hi = Math.max(b.hiMin, b.hi - b.step);
  if (noisy < 0.10 && missed < 0.05) b.lo = Math.min(b.loMax, b.lo + b.step * 0.5);
  return clampBounds(b);
}
