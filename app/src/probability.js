// 开口概率模型：把"该不该回"算成一个真正的概率，而不是一堆闸门。
//
// 设计（对应用户的两层判定思路）：
//   p_local = sigmoid(Σ 特征×权重 + b)         ← 权重由用户的标注拟合（tools/calibrate.mjs）
//   p_final = sigmoid(logit(p_local) + 外审证据)  ← 外审只加/减证据，不做"否"的硬否决
//   verdict  = p_final ≥ θ ? 回 : 不回          ← 一个阈值，θ 由标定/bandit 维护
// 这样"该不该说"是一个连续判断，不再是开关。

export function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
export function logit(p) {
  const x = Math.min(0.999999, Math.max(0.000001, Number(p) || 0.5));
  return Math.log(x / (1 - x));
}

// 外审结论 → 证据（对数几率增量）。不确定 = 0，不偏向任何一边。
export const AUDIT_EVIDENCE = { yes: 1.4, short: 0.7, unsure: 0, no: -1.6 };

// 从一条消息提取特征。离线（语料回放）和在线（运行时）用同一套，保证可校准。
export function features(input) {
  const i = input || {};
  const text = String(i.text || "");
  const names = (i.botNames || []).concat(i.nicknames || []).filter(Boolean);
  const plain = text.replace(/[\s\p{P}\p{S}]/gu, "");
  const q = /[?？]|吗|怎么|为什么|什么|哪|如何|能不能|可不可以|要不要/.test(text);
  const detail = /详细|展开|说说|讲讲|具体|解释一下/.test(text);
  const second = /你|您/.test(text);
  const nick = names.some(function (n) { return n && text.indexOf(n) >= 0; });
  const third = (text.match(/他|她|它/g) || []).length;
  return {
    atMe: i.atBot ? 1 : 0,
    replyToMe: i.replyToBot ? 1 : 0,
    nickCall: nick ? 1 : 0,
    secondPerson: second ? 1 : 0,
    question: q ? 1 : 0,
    detailAsk: detail ? 1 : 0,
    longText: plain.length >= 12 ? 1 : 0,
    thirdDense: third >= 2 ? 1 : 0,
    reporting: /他说|她说|听说|有人说|转述/.test(text) ? 1 : 0,
    twoPerson: i.twoPersonDialog ? 1 : 0,
    continuation: i.continuation ? 1 : 0
  };
}

export const FEATURE_KEYS = ["atMe", "replyToMe", "nickCall", "secondPerson", "question", "detailAsk", "longText", "thirdDense", "reporting", "twoPerson", "continuation"];

// 初始权重：保守的先验（标定脚本会用标注覆盖它）。
export const PRIOR_WEIGHTS = {
  atMe: 2.2, replyToMe: 1.8, nickCall: 1.4, secondPerson: 0.5, question: 0.7, detailAsk: 0.6,
  longText: 0.35, thirdDense: -0.9, reporting: -0.6, twoPerson: -1.6, continuation: 0.9, bias: -1.5
};

export function pLocal(feat, w) {
  const W = Object.assign({}, PRIOR_WEIGHTS, w || {});
  let z = W.bias || 0;
  for (const k of FEATURE_KEYS) z += (feat[k] || 0) * (W[k] || 0);
  return sigmoid(z);
}

// 融合：外审作为证据（对数几率相加），而不是"否"就一票否决。
export function pFinal(pLocalValue, auditVerdict) {
  const d = AUDIT_EVIDENCE[String(auditVerdict || "")] || 0;
  return sigmoid(logit(pLocalValue) + d);
}

// 一条消息算到底（离线校准/在线判定共用）。
export function scoreMessage(input, weights) {
  const f = features(input);
  const p0 = pLocal(f, weights);
  const p1 = input && input.auditVerdict ? pFinal(p0, input.auditVerdict) : p0;
  return { feat: f, pLocal: p0, p: p1 };
}
