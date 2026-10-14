export const PARAM_BOUNDS = {
  speakAt: [0.05, 0.55],
  terseAt: [0.10, 0.75],
  detailedAt: [0.20, 0.95],
  lambda: [0, 2],
  rate: [0.15, 0.6],
  minGapSec: [5, 600]
};

export const AUTOJOIN_KEYS = ["rate", "minGapSec"];

export function clampParams(p, globalGates) {
  const src = Object.assign({}, globalGates || {}, p || {});
  const out = {};
  for (const k of Object.keys(src)) {
    const b = PARAM_BOUNDS[k];
    let v = src[k];
    if (b && typeof v === "number") {
      if (v < b[0]) v = b[0];
      if (v > b[1]) v = b[1];
    }
    out[k] = v;
  }
  return out;
}

export function buildProfilePrompt(profile) {
  const p = profile || {};
  const lines = [];
  lines.push("【本群画像】");
  if (p.interests && p.interests.length) lines.push("- 本群常聊、也容易接话的话题：" + p.interests.slice(0, 8).join("、"));
  if (p.dislikes && p.dislikes.length) lines.push("- 本群容易冷场或反感的话题（少碰）：" + p.dislikes.slice(0, 6).join("、"));
  if (p.habits) lines.push("- 说话习惯：" + p.habits);
  if (p.notes) lines.push("- 其他注意：" + p.notes);
  lines.push("- 本群节奏：" + (p.pace || "未知") + "；活跃时段：" + (p.activeHours || "未统计"));
  return lines.join(String.fromCharCode(10));
}

const FLAG_NOISE = ["帮我", "求", "教我", "写个", "给个", "推荐", "麻烦", "顺便", "详细", "解释", "原因", "原理", "文档", "步骤", "教程", "深入", "展开", "具体", "怎么", "为什么", "什么", "吗", "呢", "吧", "啊", "呀", "呢"];
const STOP = ["这个", "那个", "什么", "怎么", "就是", "然后", "可以", "应该", "还是", "因为", "所以", "你们", "我们"];

export function refitProfile(events, prev, opts) {
  const exclude = (opts && opts.exclude) || [];
  const base = prev || { interests: [], dislikes: [], rounds: 0 };
  const good = new Map();
  const bad = new Map();
  for (const e of events || []) {
    const toks = e.tokens || [];
    const target = (e.outcome === "continued_with_bot" || e.outcome === "annoyed") ? (e.outcome === "continued_with_bot" ? good : bad) : null;
    if (!target) continue;
    for (const t of toks) {
      if (t.length < 2) continue;
      if (STOP.includes(t)) continue;
      if (FLAG_NOISE.includes(t)) continue;
      let banned = false;
      for (const x of exclude) { if (x && x.length >= 2 && (t.includes(x) || x.includes(t))) { banned = true; break; } }
      if (banned) continue;
      let noisy = false;
      for (const bad of ["你", "我", "他", "她", "它", "的", "了", "吗", "呢", "吧", "在吗", "不会"]) { if (t.includes(bad)) { noisy = true; break; } }
      if (noisy) continue;
      target.set(t, (target.get(t) || 0) + 1);
    }
  }
  function top(m) {
    return Array.from(m.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10).map(function (x) { return x[0]; });
  }
  const interests = Array.from(new Set(base.interests.concat(top(good)))).slice(0, 10);
  const dislikes = Array.from(new Set(base.dislikes.concat(top(bad)))).slice(0, 8);
  return {
    interests: interests,
    dislikes: dislikes,
    habits: base.habits || "句短、爱接梗、不爱长篇",
    notes: base.notes || "",
    rounds: (base.rounds || 0) + 1,
    updatedAt: new Date().toISOString()
  };
}
