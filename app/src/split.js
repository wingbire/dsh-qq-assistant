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
  // ① 句末标点（最理想）
  let cut = -1;
  for (let i = 0; i < Math.min(s.length, max); i++) if (ENDERS.indexOf(s[i]) >= 0) cut = i + 1;
  if (cut >= Math.floor(max * 0.5)) return s.slice(0, cut);
  // ② 允许略微超一点（最多 +12 字）去够下一个句末标点
  for (let i = max; i < Math.min(s.length, max + 12); i++) if (ENDERS.indexOf(s[i]) >= 0) return s.slice(0, i + 1);
  // ③ 退一步：最后一个逗号/顿号/空格
  const SOFT = "，,、 ";
  for (let i = Math.min(s.length, max) - 1; i >= Math.floor(max * 0.5); i--) {
    if (SOFT.indexOf(s[i]) >= 0) return s.slice(0, i + 1).trim();
  }
  // ④ 实在没有断点：硬切并补省略号，别让词断在半截（用户实测 19:43「真干不」就是这样被切掉的）
  if (max <= 1) return "…";
  return s.slice(0, max - 1) + "…";
}

// 按标点把超长的一句拆开（只在标点处断；真没有标点才在硬上限处断）。
function splitAtPunct(s, hardMax) {
  const out = [];
  let rest = s;
  const PUNCT = "。！？!?…；;，,、";
  while (rest.length > hardMax) {
    let cut = -1;
    for (let i = 0; i < hardMax; i++) if (PUNCT.indexOf(rest[i]) >= 0) cut = i + 1;
    if (cut < Math.floor(hardMax * 0.4)) cut = hardMax;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

// 软区间拆条：softMax 是「一条消息的舒适长度」，不是硬上限。
// 超长就按句号/逗号拆成多条发（最多 maxSegments 条；实在多出来就并进最后一条 —— 宁可长一点，也不丢内容）。
export function splitReply(text, softMax, opts) {
  const o = opts || {};
  const soft = Math.max(8, Number(softMax) || 60);
  const hard = Math.min(Math.max(soft + 20, Math.round(soft * 2)), 300);
  const maxSegments = Math.max(1, o.maxSegments || 3);
  const parts = splitSentences(String(text == null ? "" : text)).map(function (x) { return String(x).trim(); }).filter(Boolean);
  const segs = [];
  let cur = "";
  for (const p of parts) {
    if (!cur) { cur = p; continue; }
    if ((cur + p).length <= soft) { cur += p; continue; }
    segs.push(cur); cur = p;
  }
  if (cur) segs.push(cur);
  const out = [];
  for (const seg of segs) {
    if (seg.length <= hard) { out.push(seg); continue; }
    for (const piece of splitAtPunct(seg, hard)) out.push(piece);
  }
  if (out.length > maxSegments) {
    const head = out.slice(0, maxSegments - 1);
    head.push(out.slice(maxSegments - 1).join(""));
    return head.filter(Boolean);
  }
  return out.length ? out.filter(Boolean) : [""];
}
