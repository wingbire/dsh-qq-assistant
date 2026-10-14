import { oneLine, normalizeName, maskUntrusted } from "./untrusted.js";

export const DEFAULT_WEIGHTS = {
  atMe: 1.0,
  replyToMe: 0.9,
  nickCall: 0.7,
  secondPerson: 0.45,
  aboutBotTopic: 0.35,
  continuation: 0.30,
  idfOverlapToMyWords: 0.40,
  userHabit: 0.25,
  questionNoAt: 0.15,
  toOtherName: -0.40,
  negationToMe: -0.50,
  reporting: -0.25,
  thirdPersonDense: -0.30,
  evaluative: -0.20
};

export function tokensOf(text) {
  const t = squash(text);
  const out = [];
  const han = [];
  for (const ch of t) {
    const c = ch.charCodeAt(0);
    if (c >= 19968 && c <= 40959) han.push(ch);
    else if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)) out.push(ch.toLowerCase());
  }
  const N = 2;
  for (let i = 0; i + N <= han.length; i++) out.push(han.slice(i, i + N).join(""));
  if (han.length === 1) out.push(han[0]);
  for (let i = 0; i < out.length; i++) out[i] = out[i];
  return out.filter(function (x) { return x.length > 0; });
}

function squash(s) {
  let out = "";
  for (const ch of String(s || "")) {
    const c = ch.charCodeAt(0);
    if (c <= 32 || c === 12288) continue;
    out += ch;
  }
  return out;
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

export function looksAboutBot(text, names) {
  const t = squash(text);
  for (const n of names || []) if (n && t.includes(n)) return true;
  return false;
}

export function createAddressee(opts) {
  const o = opts || {};
  const weights = Object.assign({}, DEFAULT_WEIGHTS, o.weights || {});
  const state = new Map();

  function st(gid) {
    const k = String(gid);
    let s = state.get(k);
    if (!s) { s = { df: new Map(), docs: 0, perUser: new Map(), me: [] }; state.set(k, s); }
    return s;
  }

  function learn(gid, text) {
    const s = st(gid);
    const toks = tokensOf(text);
    const seen = new Set();
    for (const t of toks) if (!seen.has(t)) { seen.add(t); s.df.set(t, (s.df.get(t) || 0) + 1); }
    s.docs += 1;
    return toks;
  }

  function idf(gid, tok) {
    const s = st(gid);
    const df = s.df.get(tok) || 0;
    return Math.log((s.docs + 1) / (df + 1)) + 1;
  }

  function judge(gid, inp) {
    const s = st(gid);
    const text = maskUntrusted(inp.text || "");
    const toks = tokensOf(text);
    const botNames = (inp.botNames || []).concat(inp.nicknames || []).map(normalizeName).filter(Boolean);
    const groupNames = (inp.groupNames || []).map(normalizeName).filter(Boolean);
    const signals = [];

    function add(k, v, note) { signals.push({ k: k, v: v, w: weights[k] || 0, note: note || "" }); }

    add("atMe", inp.atBot ? 1 : 0, "被 @");
    add("replyToMe", inp.replyToBot ? 1 : 0, "回复我");
    add("nickCall", looksAboutBot(text, botNames) ? 1 : 0, "外号/昵称命中");

    const second = (text.includes("你") || text.includes("您")) ? 1 : 0;
    add("secondPerson", second, "第二人称");

    const other = groupNames.some(function (n) { return n.length > 1 && text.includes(n) && !botNames.includes(n); });
    add("toOtherName", other ? 1 : 0, "点到别人名字");

    add("questionNoAt", (text.includes("吗") || text.includes("怎么") || text.includes("?")) && !inp.atBot ? 1 : 0, "未 @ 的提问");

    let overlap = 0;
    const my = tokensOf(inp.lastBotText || "");
    const mySet = new Set(my);
    for (const t of toks) if (mySet.has(t)) overlap += idf(gid, t);
    const norm = Math.max(1, my.length);
    const ov = Math.min(1, overlap / norm);
    add("idfOverlapToMyWords", ov, "与我上句的词重叠(IDF 加权)");

    const dt = inp.now && inp.lastBotAt ? (inp.now - inp.lastBotAt) / 1000 : 9999;
    add("continuation", dt <= 90 ? 1 - dt / 180 : 0, "对话连续性");

    const pu = s.perUser.get(String(inp.userId)) || { seen: 0, repliesToMe: 0 };
    const habit = pu.seen > 0 ? pu.repliesToMe / pu.seen : 0;
    add("userHabit", habit, "此人历史接话率");

    const third = (text.match(/他|她|它/g) || []).length;
    add("thirdPersonDense", third >= 2 ? 1 : 0, "第三人称密集");
    add("negationToMe", /不是.*你|没说你|不是在问你/.test(text) ? 1 : 0, "否定我");
    add("reporting", /他说|她说|有人说|转述|听说/.test(text) ? 1 : 0, "转述");
    add("evaluative", /有点|感觉|是不是/.test(text) && second ? 1 : 0, "评价调侃");

    let z = 0;
    for (const s2 of signals) z += s2.v * s2.w;
    const conf = sigmoid(z * 2.2 - 0.6);

    for (const tok of toks) s.df.has(tok);
    s.me.push({ text: text, toks: toks });
    if (s.me.length > 30) s.me.shift();

    const pu2 = s.perUser.get(String(inp.userId)) || { seen: 0, repliesToMe: 0 };
    pu2.seen += 1;
    if (inp.replyToBot || inp.atBot) pu2.repliesToMe += 1;
    s.perUser.set(String(inp.userId), pu2);

    return { conf: conf, signals: signals, tokens: toks };
  }

  return { judge: judge, learn: learn, tokensOf: tokensOf, weights: weights };
}
