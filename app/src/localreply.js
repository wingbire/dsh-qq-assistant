// N5 决策：low 档「本地短句 ≤20 字，不进大脑」，所以需要一份本地回复池。
// 目标只有一个：不像机器人、不冷场；不承担信息量。
export const LOCAL_POOL = {
  question: ["咋啦？", "我看看哈", "嗯，让我想想", "什么事？"],
  banter: ["哈哈", "确实", "笑死", "典"],
  game: ["我也卡这儿", "这关确实烦", "打不过就躺", "等我来"],
  daily: ["在呢", "嗯哼", "咋了嘛", "在的在的"],
  general: ["嗯？", "在的", "咋了", "啥事"]
};

export function localReply(decision, opts) {
  const o = opts || {};
  const rng = o.rng || Math.random;
  const bucket = (decision && decision.bucket) || "general";
  const pool = LOCAL_POOL[bucket] || LOCAL_POOL.general;
  const idx = Math.floor(rng() * pool.length) % pool.length;
  return pool[idx];
}
