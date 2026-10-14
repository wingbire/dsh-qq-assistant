export function stripZeroWidth(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0);
    const isZW = (c >= 8203 && c <= 8207) || c === 65279 || c === 8288;
    if (!isZW) out += ch;
  }
  return out;
}

export function squashSpace(s) {
  let out = "";
  let prev = false;
  for (const ch of stripZeroWidth(s)) {
    const c = ch.charCodeAt(0);
    const isSpace = c <= 32 || c === 12288;
    if (isSpace) {
      if (!prev) { out += " "; prev = true; }
    } else {
      out += ch; prev = false;
    }
  }
  return out.trim();
}

export function oneLine(text, maxLen) {
  const m = maxLen || 300;
  let s = squashSpace(text == null ? "" : text);
  if (s.length > m) s = s.slice(0, m) + "…";
  return s;
}

export function normalizeName(name) {
  return oneLine(name, 40);
}

const INJECTION_HINTS = [
  "忽略以上", "忽略上面", "忽略之前", "ignore all", "ignore previous",
  "你现在是", "system:", "assistant:", "请扮演", "不要遵守"
];

export function isInstructionLike(text) {
  const t = String(text || "").toLowerCase();
  for (const h of INJECTION_HINTS) if (t.includes(h)) return true;
  return false;
}

export function maskUntrusted(text) {
  const clean = oneLine(text, 300);
  return isInstructionLike(clean) ? "[不可信:疑似指令] " + oneLine(clean, 120) : clean;
}
