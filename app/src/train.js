// 训练（标定）：用配置端标注的语料拟合开口概率模型的权重与阈值。
// 纯函数 + 一个写文件入口，供网页「开始训练」和自动触发共用。
import fs from "node:fs";
import path from "node:path";
import { loadCorpus, corpusFile } from "./corpus.js";
import { features, FEATURE_KEYS, pFinal, PRIOR_WEIGHTS } from "./probability.js";

function pz(w, x) { let z = w[0]; for (let j = 0; j < x.length; j++) z += w[j + 1] * x[j]; return 1 / (1 + Math.exp(-z)); }

function fit(xs, ys, as, lambda) {
  let w = new Array(FEATURE_KEYS.length + 1).fill(0);
  w[0] = Math.log((ys.filter(function (y) { return y === 1; }).length + 1) / (ys.filter(function (y) { return y === 0; }).length + 1));
  const lr = 0.12;
  for (let it = 0; it < 3000; it++) {
    const g = new Array(w.length).fill(0);
    for (let i = 0; i < xs.length; i++) {
      const p0 = pz(w, xs[i]);
      const p = as[i] ? pFinal(p0, as[i]) : p0;
      const e = p - ys[i];
      g[0] += e;
      for (let j = 0; j < xs[i].length; j++) g[j + 1] += e * xs[i][j];
    }
    for (let j = 0; j < w.length; j++) {
      const reg = j === 0 ? 0 : lambda * w[j];
      w[j] -= lr * (g[j] / xs.length + reg);
    }
  }
  return w;
}

export function trainFromLabels(dataDir, opts) {
  const o = opts || {};
  const file = corpusFile(dataDir);
  const items = loadCorpus(file).filter(function (i) { return i && i.expect; });
  if (items.length < 10) return { ok: false, error: "标注太少（" + items.length + " 条，至少 10 条）" };
  const X = items.map(function (it) {
    const f = features({ text: it.text, botNames: ["小肥鱼"], nicknames: ["肥鱼", "鲸鲸"], atBot: it.atBot, replyToBot: it.replyToBot });
    return FEATURE_KEYS.map(function (k) { return f[k] || 0; });
  });
  const Y = items.map(function (it) { return it.expect === "该不回" ? 0 : 1; });
  const A = items.map(function (it) { return it.audit || ""; });

  const w = fit(X, Y, A, 0.02);
  // 语料里没出现过的特征保持先验（否则会被压成 0，形同虚设）
  const unused = [];
  FEATURE_KEYS.forEach(function (k, j) {
    const seen = X.some(function (row) { return row[j] > 0; });
    if (!seen) { w[j + 1] = PRIOR_WEIGHTS[k] || 0; unused.push(k); }
  });
  let hit = 0;
  for (let i = 0; i < X.length; i++) {
    const p0 = pz(w, X[i]);
    const p = A[i] ? pFinal(p0, A[i]) : p0;
    if ((p >= 0.5 ? 1 : 0) === Y[i]) hit += 1;
  }
  const acc = Math.round((hit / X.length) * 100);

  // 留一交叉验证 + 最佳阈值（更诚实，也更适合线上用）
  const preds = [];
  let looHit = 0;
  for (let k = 0; k < X.length; k++) {
    const xs = X.filter(function (_, i) { return i !== k; });
    const ys = Y.filter(function (_, i) { return i !== k; });
    const as = A.filter(function (_, i) { return i !== k; });
    const w2 = fit(xs, ys, as, 0.02);
    const p0 = pz(w2, X[k]);
    const p = A[k] ? pFinal(p0, A[k]) : p0;
    preds.push(p);
    if ((p >= 0.5 ? 1 : 0) === Y[k]) looHit += 1;
  }
  let bestT = 0.5, bestHit = -1;
  for (let t = 0.2; t <= 0.8; t += 0.02) {
    let h = 0;
    for (let i = 0; i < preds.length; i++) if ((preds[i] >= t ? 1 : 0) === Y[i]) h += 1;
    if (h > bestHit) { bestHit = h; bestT = t; }
  }
  const loo = Math.round((looHit / X.length) * 100);
  const bestAcc = Math.round((bestHit / X.length) * 100);
  const threshold = Math.round(bestT * 100) / 100;

  const out = { at: new Date().toISOString(), n: items.length, acc: acc, loo: loo, bestAcc: bestAcc, threshold: threshold, weights: {}, unused: unused };
  FEATURE_KEYS.forEach(function (k, j) { out.weights[k] = Math.round(w[j + 1] * 1000) / 1000; });
  out.weights.bias = Math.round(w[0] * 1000) / 1000;
  const dest = path.join(dataDir, "calibration.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  return Object.assign({ ok: true, file: dest }, out);
}
