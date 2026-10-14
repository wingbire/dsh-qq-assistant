import { adaptBounds, clampBounds } from "./gatescore.js";

// N21 决策：配置端加「标注」页，管理员标「这条该不该回」，满 30 条自动回流一次。
// 存储用 labels.jsonl（append-only）：同一 id 后写的行覆盖先写的行。
export const LABEL_MIN_SAMPLES = 30;

// 稳定短哈希（djb2）：没有 messageId 时用它兜底，保证同一条消息的 id 稳定可复现
export function shortHash(s) {
  let h = 5381;
  const t = String(s == null ? "" : s);
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

export function labelIdOf(rec) {
  const r = rec || {};
  const tail = r.messageId != null ? String(r.messageId)
    : (r.text ? shortHash(r.text)
      : (r.at != null ? String(r.at) : "x"));
  return String(r.gid) + ":" + tail;
}

// append-only + 同 id 取最后一条
export function foldLabels(rows) {
  const byId = new Map();
  for (const r of (rows || [])) {
    if (!r || r.id == null) continue;
    byId.set(String(r.id), Object.assign({}, byId.get(String(r.id)) || {}, r));
  }
  return Array.from(byId.values());
}

export function pendingOf(rows) { return foldLabels(rows).filter(function (r) { return r.human == null; }); }
export function labeledOf(rows) { return foldLabels(rows).filter(function (r) { return r.human != null; }); }

// 人工标注 → 双目标校准用的两个统计量
//   missRate：人工说「该回」而本地判否的比例（漏接）
//   flipRate：人工说「不该回」而本地落灰区的比例（外审/灰区噪声）
export function agreementStats(rows) {
  const labeled = labeledOf(rows);
  let should = 0, missed = 0, shouldNot = 0, greyNoise = 0, agree = 0;
  for (const r of labeled) {
    const localSaid = r.localVerdict;
    if (r.human === "该回") {
      should += 1;
      if (localSaid === "no") missed += 1; else agree += 1;
    } else {
      shouldNot += 1;
      if (localSaid === "grey") greyNoise += 1;
      if (localSaid === "no") agree += 1;
    }
  }
  return {
    n: labeled.length,
    shouldReply: should, shouldNotReply: shouldNot,
    missedRate: should ? missed / should : 0,
    flipRate: shouldNot ? greyNoise / shouldNot : 0,
    agreement: labeled.length ? agree / labeled.length : 0
  };
}

export function createLabelQueue(opts) {
  const o = opts || {};
  const store = o.store;
  const minSamples = o.minSamples || LABEL_MIN_SAMPLES;
  let lastReflowAt = 0;
  // store 不支持标注时给一个空实现，别让整个 runtime 因为缺能力而崩
  const capable = !!(store && typeof store.addLabel === "function" && typeof store.readJsonl === "function" && store.paths);
  if (!capable) {
    return {
      minSamples: minSamples, capable: false,
      rows: function () { return []; }, recordCandidate: function () { return null; },
      label: function () { return null; }, pending: function () { return []; },
      status: function () { return { pending: 0, labeled: 0, minSamples: minSamples, stats: agreementStats([]) }; },
      reflowIfReady: function () { return { ready: false, n: 0, need: minSamples }; }
    };
  }

  function rows() { return store.readJsonl(store.paths.labels); }

  function recordCandidate(rec) {
    if (!store) return null;
    const id = rec.id || labelIdOf(rec);
    return store.addLabel(Object.assign({}, rec, { id: id, human: null }));
  }

  function label(id, human, labeler) {
    if (!store) return null;
    return store.addLabel({ id: String(id), human: String(human), labeler: labeler || "admin", at: new Date().toISOString() });
  }

  function status() {
    const all = rows();
    return { pending: pendingOf(all).length, labeled: labeledOf(all).length, minSamples: minSamples, stats: agreementStats(all) };
  }

  // 满 minSamples 就回流一次：把人工结论喂给灰区自适应
  function reflowIfReady(bounds, nowMs) {
    const all = rows();
    const labeled = labeledOf(all);
    if (labeled.length < minSamples) return { ready: false, n: labeled.length, need: minSamples - labeled.length };
    const t = nowMs || Date.now();
    if (t - lastReflowAt < (o.cooldownMs || 0)) return { ready: false, n: labeled.length, cooling: true };
    const stats = agreementStats(all);
    const next = adaptBounds(bounds || {}, { missedRate: stats.missedRate, auditFlipRate: stats.flipRate });
    lastReflowAt = t;
    return { ready: true, n: labeled.length, stats: stats, bounds: next, changed: JSON.stringify(clampBounds(bounds || {})) !== JSON.stringify(next) };
  }

  return {
    minSamples: minSamples, capable: true, rows: rows, recordCandidate: recordCandidate, label: label,
    status: status, reflowIfReady: reflowIfReady,
    pending: function () { return pendingOf(rows()); }
  };
}
