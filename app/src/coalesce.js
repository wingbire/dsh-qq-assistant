// N23 决策：取消每群每小时条数上限，改成「短时间同一群成员的连续消息结合上文，
// 只回复最近通过判定的一条」。
// 时间由调用方传入（now），所以可测、可确定。

export function createCoalescer(opts) {
  const o = opts || {};
  const windowMs = o.windowMs != null ? o.windowMs : 6000;
  const maxBatch = o.maxBatch != null ? o.maxBatch : 5;
  const maxWaitMs = o.maxWaitMs != null ? o.maxWaitMs : windowMs * 4;
  const buckets = new Map();

  function keyOf(evt) { return String(evt.gid) + "|" + String(evt.uid); }

  function push(evt) {
    const k = keyOf(evt);
    let b = buckets.get(k);
    if (!b) { b = { gid: evt.gid, uid: evt.uid, evts: [], firstAt: evt.now, lastAt: evt.now }; buckets.set(k, b); }
    b.evts.push(evt);
    b.lastAt = evt.now;
    if (b.evts.length > maxBatch) b.evts = b.evts.slice(b.evts.length - maxBatch);
    return b;
  }

  // 到点的（静默超过 windowMs，或从第一条起超过 maxWaitMs）成批吐出
  function flushDue(now) {
    const done = [];
    for (const [k, b] of Array.from(buckets.entries())) {
      const quiet = now - b.lastAt >= windowMs;
      const tooLong = now - b.firstAt >= maxWaitMs;
      if (quiet || tooLong) { done.push(mergeBucket(b)); buckets.delete(k); }
    }
    return done;
  }

  return { push: push, flushDue: flushDue, size: function () { return buckets.size; }, clear: function () { buckets.clear(); }, windowMs: windowMs, maxBatch: maxBatch };
}

export function mergeBucket(b) {
  const evts = b.evts || [];
  const last = evts[evts.length - 1] || {};
  return {
    gid: b.gid, uid: b.uid, evts: evts, count: evts.length,
    firstAt: b.firstAt, lastAt: b.lastAt,
    // 合并后的上下文（进大脑用），保留「名字：内容」的行式
    text: evts.map(function (e) { return e.speaker ? e.speaker + "：" + e.text : e.text; }).join(String.fromCharCode(10)),
    // 纯文本（进本地判定用）：不掺说话人名字，免得污染关键词
    plainText: evts.map(function (e) { return e.text; }).join(" "),
    // 是否任一环带硬触发（@/回复/外号）
    atBot: evts.some(function (e) { return !!e.atBot; }),
    replyToBot: evts.some(function (e) { return !!e.replyToBot; })
  };
}

// 「最近通过判定的一条」：从后往前找第一条 action !== ignore 的决策。
export function pickAnchor(decisions) {
  const list = decisions || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (d && d.action && d.action !== "ignore") return { index: i, decision: d, evt: (d.evt || null) };
  }
  return null;
}
