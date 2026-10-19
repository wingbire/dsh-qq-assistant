// 用用户的标注拟合开口概率模型的权重（逻辑回归 + L2 + 留一交叉验证）。
// 用法：node tools/calibrate.mjs [语料路径]
import fs from "node:fs";
import path from "node:path";
import { loadCorpus, corpusFile } from "../app/src/corpus.js";
import { features, FEATURE_KEYS, sigmoid, pFinal, PRIOR_WEIGHTS } from "../app/src/probability.js";

const file = corpusFile(path.resolve(process.argv[2] || "app/dsh-data/data/data"));
const items = loadCorpus(file).filter(function (i) { return i && i.expect; });
if (items.length < 10) { console.log("标注太少（" + items.length + " 条），先标至少 10 条"); process.exit(0); }

const X = items.map(function (it) {
  const f = features({ text: it.text, botNames: ["小肥鱼"], nicknames: ["肥鱼", "鲸鲸"], atBot: it.atBot, replyToBot: it.replyToBot });
  return FEATURE_KEYS.map(function (k) { return f[k] || 0; });
});
const Y = items.map(function (it) { return it.expect === "该不回" ? 0 : 1; });
const A = items.map(function (it) { return it.audit || ""; });

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
function acc(w) {
  let hit = 0;
  for (let i = 0; i < X.length; i++) {
    const p0 = pz(w, X[i]);
    const p = A[i] ? pFinal(p0, A[i]) : p0;
    if ((p >= 0.5 ? 1 : 0) === Y[i]) hit += 1;
  }
  return hit / X.length;
}

let bestThreshold = 0.5;
const w = fit(X, Y, A, 0.02);
// 语料里从未出现过的特征，学不到东西 —— 保持先验权重（否则会被压成 0，特征形同虚设）。
const unused = [];
FEATURE_KEYS.forEach(function (k, j) {
  const seen = X.some(function (row) { return row[j] > 0; });
  if (!seen) {
    w[j + 1] = PRIOR_WEIGHTS[k] || 0;
    unused.push(k);
  }
});
if (unused.length) console.log("语料里未出现的特征（保持先验权重）：" + unused.join(", "));
console.log("语料 " + items.length + " 条（该回 " + Y.filter(function (y) { return y === 1; }).length + " / 该不回 " + Y.filter(function (y) { return y === 0; }).length + "）");
console.log("训练集符合率：" + Math.round(acc(w) * 100) + "%");

// 留一交叉验证：更诚实的数字
let looHit = 0;
for (let k = 0; k < X.length; k++) {
  const xs2 = X.filter(function (_, i) { return i !== k; });
  const ys2 = Y.filter(function (_, i) { return i !== k; });
  const as2 = A.filter(function (_, i) { return i !== k; });
  const w2 = fit(xs2, ys2, as2, 0.02);
  const p0 = pz(w2, X[k]);
  const p = A[k] ? pFinal(p0, A[k]) : p0;
  if ((p >= 0.5 ? 1 : 0) === Y[k]) looHit += 1;
}
const looPreds = [];
for (let k = 0; k < X.length; k++) {
  const xs3 = X.filter(function (_, i) { return i !== k; });
  const ys3 = Y.filter(function (_, i) { return i !== k; });
  const as3 = A.filter(function (_, i) { return i !== k; });
  const w3 = fit(xs3, ys3, as3, 0.02);
  const p0 = pz(w3, X[k]);
  looPreds.push(A[k] ? pFinal(p0, A[k]) : p0);
}
let bestT = 0.5, bestHit = -1;
for (let t = 0.2; t <= 0.8; t += 0.02) {
  let h = 0;
  for (let i = 0; i < looPreds.length; i++) if ((looPreds[i] >= t ? 1 : 0) === Y[i]) h += 1;
  if (h > bestHit) { bestHit = h; bestT = t; }
}
console.log("留一交叉验证：" + Math.round((looHit / X.length) * 100) + "%（阈值 0.5）；最佳阈值 " + Math.round(bestT * 100) / 100 + " → " + Math.round((bestHit / X.length) * 100) + "%");
bestThreshold = Math.round(bestT * 100) / 100;
console.log("学到的权重：");
FEATURE_KEYS.forEach(function (k, j) { console.log("  " + k.padEnd(14) + (Math.round(w[j + 1] * 100) / 100)); });
console.log("  bias".padEnd(16) + (Math.round(w[0] * 100) / 100));
const out = { at: new Date().toISOString(), n: items.length, weights: {}, acc: Math.round(acc(w) * 100), loo: Math.round((looHit / X.length) * 100) };
FEATURE_KEYS.forEach(function (k, j) { out.weights[k] = Math.round(w[j + 1] * 1000) / 1000; });
out.weights.bias = Math.round(w[0] * 1000) / 1000;
out.threshold = bestThreshold;
const f2 = path.join(path.dirname(file), "calibration.json");
fs.writeFileSync(f2, JSON.stringify(out, null, 2));
console.log("已写入 " + f2);