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

// 群档案拆成两块，按「缓存优先级」分别摆放：
//   【本群画像】  = 概况（说话习惯 / 备注 / 节奏 / 活跃时段）—— 每 refN 次提炼才变一次，属"少变"
//   【本群兴趣词条】= 常聊话题 / 少碰话题 —— 提炼时最容易翻，且直接影响主动搭话，属"多变"
const NL = String.fromCharCode(10);

export function buildProfileFactsPrompt(profile) {
  const p = profile || {};
  const lines = [];
  lines.push("【本群画像】");
  if (p.habits) lines.push("- 说话习惯：" + p.habits);
  if (p.notes) lines.push("- 其他注意：" + p.notes);
  lines.push("- 本群节奏：" + (p.pace || "未知") + "；活跃时段：" + (p.activeHours || "未统计"));
  return lines.join(NL);
}

export function buildProfileInterestsPrompt(profile) {
  const p = profile || {};
  const lines = [];
  if (p.interests && p.interests.length) lines.push("- 本群常聊、也容易接话的话题：" + p.interests.slice(0, 8).join("、"));
  if (p.dislikes && p.dislikes.length) lines.push("- 本群容易冷场或反感的话题（少碰）：" + p.dislikes.slice(0, 6).join("、"));
  if (!lines.length) return "";
  return ["【本群兴趣词条】"].concat(lines).join(NL);
}

// 兼容旧调用（配置端展示 / 旧接口）：两块拼一起，顺序也是 概况 → 兴趣词条
export function buildProfilePrompt(profile) {
  return [buildProfileFactsPrompt(profile), buildProfileInterestsPrompt(profile)].filter(Boolean).join(NL + NL);
}

// 话题词条的生命周期规则（可按群/全局覆盖）：
//   临时起意 → 只进「观察区」，3 天没再提就丢；
//   持续稳定（累计命中 ≥4 次 且 跨 ≥2 天）→ 固化，21 天没再提才降级回观察区。
// 为什么要它：原来是"旧词永远粘住 + 新词被 slice 挤掉"（只会加、不会删），
// 于是"是什么 / 给小 / 看史"这种一次性的碎片一直占着名额，长期话题反而挤不进来。
export const INTEREST_RULES = {
  stableHits: 4,
  stableDays: 2,
  watchDays: 3,
  stableKeepDays: 21,
  maxInterests: 8,
  maxWatch: 12
};

function dayOf(ts) { return new Date(ts).toISOString().slice(0, 10); }
const DAY_MS = 86400000;

// 纯函数：喂一批"本轮命中的话题词"，返回新的固化列表 / 观察区 / 统计 / 本轮动作日志
export function updateInterests(prev, seen, now, opts) {
  const o = Object.assign({}, INTEREST_RULES, opts || {});
  const t = now || Date.now();
  const stats = {};
  // 旧档案没有 stats：把老 interests 当成"已经固化"，别把历史一把清空
  const prevStats = (prev && prev.interestStats) || {};
  // 旧档案（只有 interests 数组、没有 stats）迁移成"已固化"。关键：lastAt 用**上次更新时间**而不是现在，
  // 否则每次提炼都把 lastAt 刷成当下，沉寂天数永远算不出来 → 老话题永远不会降级/淘汰。
  const legacyAt = (prev && prev.updatedAt ? Date.parse(prev.updatedAt) : 0) || t;
  for (const term of (prev && prev.interests) || []) {
    if (prevStats[term]) continue;                  // 有统计的以统计为准，别动它的 lastAt
    const byAdmin = prev && prev.updatedBy === "admin";   // 管理员手写过的老档案：钉住，别让生命周期把它清掉
    stats[term] = { hits: o.stableHits, days: [dayOf(legacyAt)], firstAt: legacyAt, lastAt: legacyAt, stable: true, pinned: byAdmin };
  }
  for (const k of Object.keys(prevStats)) {
    const s = prevStats[k] || {};
    const keep = stats[k] || { hits: 0, days: [], firstAt: s.firstAt || t };
    stats[k] = {
      hits: Math.max(keep.hits || 0, Number(s.hits) || 0),
      days: (Array.isArray(s.days) && s.days.length ? s.days.slice(-8) : keep.days) || [],
      firstAt: keep.firstAt || s.firstAt || t,
      lastAt: Math.max(keep.lastAt || 0, Number(s.lastAt) || 0) || t,
      stable: !!s.stable || !!keep.stable,
      pinned: !!s.pinned || !!keep.pinned     // 管理员手写的钉住不动
    };
  }
  const added = [];
  for (const item of seen || []) {
    const term = typeof item === "string" ? item : (item && item.term);
    if (!term) continue;
    const w = typeof item === "string" ? 1 : Math.max(1, Number(item.hits) || 1);
    let s = stats[term];
    if (!s) { s = { hits: 0, days: [], firstAt: t, lastAt: t, stable: false }; added.push(term); }
    s.hits += w;
    s.lastAt = t;
    const d = dayOf(t);
    if (s.days.indexOf(d) < 0) s.days.push(d);
    if (s.days.length > 8) s.days = s.days.slice(-8);
    stats[term] = s;
  }
  const promoted = [], demoted = [], dropped = [];
  for (const term of Object.keys(stats)) {
    const s = stats[term];
    if (s.pinned) { s.stable = true; continue; }        // 钉住的：既不降级也不淘汰
    const idleDays = (t - (Number(s.lastAt) || t)) / DAY_MS;
    if (!s.stable) {
      if (s.hits >= o.stableHits && s.days.length >= o.stableDays) { s.stable = true; promoted.push(term); }
      else if (idleDays > o.watchDays) { delete stats[term]; dropped.push(term); }
    } else if (idleDays > o.stableKeepDays) {
      s.stable = false; demoted.push(term);       // 先降级回观察区，不直接删（避免误伤）
    }
  }
  const terms = Object.keys(stats);
  const stableList = terms.filter(function (x) { return stats[x].stable; })
    .sort(function (a, b) { return (stats[b].hits - stats[a].hits) || (stats[b].lastAt - stats[a].lastAt); });
  const watchList = terms.filter(function (x) { return !stats[x].stable; })
    .sort(function (a, b) { return stats[b].lastAt - stats[a].lastAt; });
  return {
    interests: stableList.slice(0, o.maxInterests),
    watch: watchList.slice(0, o.maxWatch),
    stats: stats, added: added, promoted: promoted, demoted: demoted, dropped: dropped
  };
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
  function top(m, n) {
    return Array.from(m.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n || 10).map(function (x) { return x[0]; });
  }
  // 常聊话题走生命周期（临时的会过期、反复出现的固化）；"少碰"沿用原来的并集但一样限量
  const now = (opts && opts.now) || Date.now();
  const seen = Array.from(good.entries()).map(function (x) { return { term: x[0], hits: x[1] }; });
  const li = updateInterests(base, seen, now, (opts && opts.rules) || null);
  const dislikes = Array.from(new Set((base.dislikes || []).concat(top(bad, 8)))).slice(0, 8);
  return {
    interests: li.interests,
    interestWatch: li.watch,                 // 观察区：还没固化，先不给提示词用
    interestStats: li.stats,                 // 每个词的命中次数 / 跨天 / 是否固化
    interestLog: {                            // 便于排查："这词为什么不见了"
      at: now,
      added: li.added, promoted: li.promoted, demoted: li.demoted, dropped: li.dropped,
      watch: li.watch.slice(0, 6), stable: li.interests
    },
    dislikes: dislikes,
    habits: base.habits || "句短、爱接梗、不爱长篇",
    notes: base.notes || "",
    rounds: (base.rounds || 0) + 1,
    updatedAt: new Date(now).toISOString()
  };
}
