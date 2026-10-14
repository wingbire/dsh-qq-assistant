// N5 决策：low 档「本地短句 ≤20 字，不进大脑」，所以需要一份本地回复池。
// 目标只有一个：不像机器人、不冷场；不承担信息量。
export const LOCAL_POOL = {
  question: ["咋啦？", "我看看哈", "嗯，让我想想", "什么事？"],
  banter: ["哈哈", "确实", "笑死", "典"],
  game: ["我也卡这儿", "这关确实烦", "打不过就躺", "等我来"],
  daily: ["在呢", "嗯哼", "咋了嘛", "在的在的"],
  general: ["嗯？", "在的", "咋了", "啥事"]
};

// 被点名（@我 / 回复我 / 叫名字）时改用"应答型"：用户 @ 你是想让你说话，
// 回一句"嗯？/啥事"最伤观感 —— 实测就是这么被吐槽"呆呆的、没过脑子"的。
export const ADDRESSED_POOL = {
  question: ["在的，你说", "在呢，什么事？", "我看看哈", "咋啦？"],
  banter: ["在的在的", "来了来了", "哈哈，你说", "嗯哼？"],
  game: ["在的在的", "来了来了", "在呢，开黑？", "咋啦"],
  daily: ["在的～", "来了来了", "在呢，你说", "咋啦？"],
  general: ["在的，你说", "来了来了", "在呢，咋啦？", "我在，你说"]
};

// 打招呼/寒暄单独一套：这种话只该有一句像样的回应
// 注意"打招呼"在"打个招呼"里是不连续的 —— 只认整串会漏，所以连"招呼"一起认。
// 拉丁文那几个（hi/hey）交给下面带边界的正则，别用子串匹配（"this" 里也有 hi）。
export const GREET_WORDS = ["打招呼", "打个招呼", "招呼", "在吗", "在么", "在不在", "你好", "早上好", "晚上好", "嗨"];
export const GREET_POOL = ["在的～咋啦？", "在的在的，什么事？", "来啦，怎么啦～", "哟，我在"];

export function isGreeting(text) {
  const t = String(text || "").toLowerCase();
  for (const w of GREET_WORDS) if (t.indexOf(w) >= 0) return true;
  return /^(hi|hello|hey)[\s!！.。~～]*$/.test(t);
}

export function localReply(decision, opts) {
  const o = opts || {};
  const rng = o.rng || Math.random;
  const d = decision || {};
  const bucket = d.bucket || "general";
  const hits = Array.isArray(d.hardHits) ? d.hardHits : [];
  const addressed = (Number(d.hardStrength) || 0) >= 0.7
    || hits.indexOf("nick") >= 0 || hits.indexOf("at") >= 0 || hits.indexOf("reply") >= 0;
  const text = o.text != null ? o.text : d.text;
  let pool = LOCAL_POOL[bucket] || LOCAL_POOL.general;
  if (isGreeting(text)) pool = GREET_POOL;
  else if (addressed) pool = ADDRESSED_POOL[bucket] || ADDRESSED_POOL.general;
  const idx = Math.floor(rng() * pool.length) % pool.length;
  return pool[idx];
}
