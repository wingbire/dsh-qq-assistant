// N6 决策：回复超字数时「优先截断在句号，然后分两条/多条发送」。
// 纯函数，无 IO，便于单测。

const ENDERS = "。！？!?…；;";

export function splitSentences(text) {
  const s = String(text == null ? "" : text);
  const out = [];
  let cur = "";
  for (const ch of s) {
    cur += ch;
    if (ENDERS.indexOf(ch) >= 0) { out.push(cur); cur = ""; }
  }
  if (cur.trim()) out.push(cur);
  return out.length ? out : [s];
}

// 在 maxChars 内找最后一个句末标点断开；找不到或太靠前就硬切。
export function cutAtSentence(text, maxChars) {
  const s = String(text == null ? "" : text);
  const max = Math.max(1, Number(maxChars) || 1);
  if (s.length <= max) return s;
  let cut = -1;
  for (let i = 0; i < Math.min(s.length, max); i++) if (ENDERS.indexOf(s[i]) >= 0) cut = i + 1;
  if (cut >= Math.floor(max * 0.5)) return s.slice(0, cut);
  return s.slice(0, max);
}

// 返回按发送顺序排列的若干条消息。
export function splitReply(text, maxChars, opts) {
  const o = opts || {};
  const max = Math.max(1, Number(maxChars) || 1);
  const maxSegments = Math.max(1, o.maxSegments || 3);
  const parts = splitSentences(text);
  const segs = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + p).length > max) { segs.push(cur); cur = p; }
    else cur += p;
  }
  if (cur) segs.push(cur);
  const trimmed = segs.map(function (s) { return s.length > max ? cutAtSentence(s, max) : s; }).filter(function (s) { return s.trim(); });
  if (trimmed.length <= maxSegments) return trimmed.length ? trimmed : [""];
  const head = trimmed.slice(0, maxSegments - 1);
  const tail = trimmed.slice(maxSegments - 1).join("");
  head.push(tail.length > max ? cutAtSentence(tail, max) : tail);
  return head;
}
