// 反馈定义（技术架构文档 §8）：
//   小助手对**某个人**回复一次后，看**那个人**是继续跟小助手聊（正）还是转去跟别人聊（负）。
// engagement 档位（取回源码）：+4 接着聊并叫外号 / +2 接着说 / −1 没人接 / −2 嫌烦。
// 时间全部由外部传入（now），所以可测、可确定。
export const FEEDBACK_DEFAULTS = { windowMs: 90000 };

export const ANNOYED_WORDS = ["别说了", "别烦", "闭嘴", "滚", "烦人", "别发了", "安静点", "谁问你了", "没人问你", "别回", "少说两句"];

export function isAnnoyed(text) {
  const t = String(text || "");
  for (const w of ANNOYED_WORDS) if (t.includes(w)) return true;
  return false;
}

export function calledBot(text, names) {
  const t = String(text || "");
  for (const n of (names || [])) if (n && t.includes(n)) return true;
  return false;
}

export function createTracker(opts) {
  const o = opts || {};
  const windowMs = o.windowMs != null ? o.windowMs : FEEDBACK_DEFAULTS.windowMs;
  const pending = new Map();          // gid -> [ { uid, arm, bucket, tokens, at, inTokens, outTokens, ... } ]
  let resolvedCount = 0;

  function noteReply(rec) {
    const key = String(rec.gid);
    const arr = pending.get(key) || [];
    arr.push(Object.assign({}, rec));
    pending.set(key, arr);
    return arr.length;
  }

  function finish(p, outcome, nowMs, evt) {
    resolvedCount += 1;
    return Object.assign({}, p, {
      outcome: outcome,
      nickCall: !!p.nickCall || !!(evt && calledBot(evt.text, p.botNames)),
      resolvedAt: nowMs,
      latencyMs: nowMs - p.at
    });
  }

  // 这个群里来了新消息 —— 结算该群所有待定反馈
  function resolve(evt) {
    const key = String(evt.gid);
    const arr = pending.get(key);
    if (!arr || !arr.length) return [];
    const out = [];
    pending.delete(key);
    for (const p of arr) {
      if (evt.now - p.at > windowMs) { out.push(finish(p, "no_one_replied", evt.now)); continue; }
      if (String(p.uid) === String(evt.uid)) {
        out.push(finish(p, isAnnoyed(evt.text) ? "annoyed" : "continued_with_bot", evt.now, evt));
      } else {
        out.push(finish(p, "went_to_others", evt.now, evt));
      }
    }
    return out;
  }

  // 窗口内没人接话 —— 弱负
  function sweep(nowMs) {
    const out = [];
    for (const [key, arr] of Array.from(pending.entries())) {
      const keep = [];
      for (const p of arr) {
        if (nowMs - p.at >= windowMs) out.push(finish(p, "no_one_replied", nowMs));
        else keep.push(p);
      }
      if (keep.length) pending.set(key, keep); else pending.delete(key);
    }
    return out;
  }

  return {
    windowMs: windowMs, noteReply: noteReply, resolve: resolve, sweep: sweep,
    pendingCount: function () { return Array.from(pending.values()).reduce(function (a, b) { return a + b.length; }, 0); },
    resolvedCount: function () { return resolvedCount; },
    clear: function () { pending.clear(); }
  };
}
