export const BUCKETS = ["question", "banter", "game", "smalltalk", "general"];

export const CLASSIFY_TABLE = {
  question: ["怎么", "如何", "为什么", "是什么", "在哪", "哪个", "有没有", "能不能", "可以吗", "吗", "呢", "咋", "多少", "多久", "谁", "啥时候", "什么时候", "什么"],
  banter: ["哈哈", "笑死", "草", "离谱", "绷不住", "乐", "绝了", "典", "6", "无语", "服了", "麻了", "太顶"],
  game: ["游戏", "关卡", "boss", "联机", "开黑", "副本", "天赋", "装备", "存档", "打分", "上分", "第五层", "打野", "排位", "mod"],
  smalltalk: ["吃了", "睡了", "上班", "下班", "天气", "周末", "加班", "摸鱼", "放假", "早安", "晚安", "困了"]
};

export const FLAG_WORDS = {
  request: ["帮我", "求", "教我", "写个", "给个", "推荐", "搞一个", "弄个", "顺便", "麻烦", "谁有", "谁知道", "有人知道", "有没有人", "求个", "哪里能", "在哪下"],
  detail: ["详细", "解释", "原因", "原理", "文档", "步骤", "教程", "深入", "展开", "具体", "说说", "讲讲", "多讲", "介绍", "举例", "怎么弄"],
  media: ["[图片]", "[语音]", "[视频]", "[表情]", "[动画表情]", "[文件]"],
  quote: ["[转发]", "转发", "转自", "引用"],
  url: ["http://", "https://", "www."],
  // N22 搜索闸门用：① "要外部/实时信息"的信号 ② 用户明确让搜
  fresh: ["今天", "现在", "最新", "刚刚", "近期", "几点", "什么时候", "哪天", "多久", "天气", "气温", "股价", "价格", "多少钱", "新闻", "版本", "更新", "赛程", "比分", "汇率", "上映", "发售", "下载地址", "链接", "网址", "地址", "官网"],
  search: ["搜一下", "搜搜", "搜索", "查一下", "查查", "帮我搜", "帮忙搜", "百度一下", "谷歌"]
};

export const PARTICLES = ["吗", "呢", "吧", "啊", "呀", "咋", "6"];

export const STOPWORDS = ["这个", "那个", "什么", "怎么", "就是", "然后", "可以", "应该", "还是", "因为", "所以", "你们", "我们", "他们", "一下", "一下下", "现在", "今天", "明天"];

export function squashSpace(s) {
  let out = "";
  let prev = false;
  for (const ch of String(s == null ? "" : s)) {
    const c = ch.charCodeAt(0);
    const isSpace = c <= 32 || c === 12288;
    if (isSpace) { if (!prev) { out += " "; prev = true; } }
    else { out += ch; prev = false; }
  }
  return out.trim();
}

export function findWords(text, list) {
  const t = squashSpace(text);
  const hit = [];
  for (const w of list) if (t.includes(w)) hit.push(w);
  return hit;
}

export function flagsOf(text) {
  const t = squashSpace(text);
  return {
    isQuestion: findWords(t, CLASSIFY_TABLE.question).length > 0,
    isRequest: findWords(t, FLAG_WORDS.request).length > 0,
    isDetailAsk: findWords(t, FLAG_WORDS.detail).length > 0,
    isMedia: findWords(t, FLAG_WORDS.media).length > 0,
    isQuote: findWords(t, FLAG_WORDS.quote).length > 0,
    hasUrl: findWords(t, FLAG_WORDS.url).length > 0,
    isFresh: findWords(t, FLAG_WORDS.fresh).length > 0,          // 问的是会变的信息（价格/时间/版本/链接…）
    explicitSearch: findWords(t, FLAG_WORDS.search).length > 0   // 明确让"搜一下"
  };
}

// 口语废词：拿它们当检索词只会把搜索带偏（实测"我去/好像/确实"这种真的被拿去搜过）
export const WEAK_KEYWORDS = STOPWORDS.concat([
  "我去", "去调", "调调", "好像", "确实", "觉得", "无敌", "开始", "这个", "那个", "废话", "行了",
  "就是", "可以", "应该", "你们", "我们", "他们", "一下", "哈哈", "笑死", "无语"
]);

// 能拿去搜的词：去掉废词与纯数字，长词优先（长词更像真主题词）
export function searchableKeywords(list) {
  return (list || []).map(function (w) { return String(w); }).filter(function (w) {
    if (w.length < 2) return false;
    if (WEAK_KEYWORDS.indexOf(w) >= 0) return false;
    if (/^[0-9]+$/.test(w)) return false;
    // 整词全由废词拼出来（"我去调调"）也不当检索词
    if (w.length >= 2) {
      let junk = 0, total = 0;
      for (let i = 0; i + 2 <= w.length; i++) { total += 1; if (WEAK_KEYWORDS.indexOf(w.slice(i, i + 2)) >= 0) junk += 1; }
      if (total > 0 && junk === total) return false;
    }
    return true;
  }).sort(function (a, b) { return b.length - a.length; });
}

export function extractKeywords(text, ctx) {
  const t = squashSpace(text);
  const out = [];
  const push = function (w) { if (w && w.length >= 2 && !STOPWORDS.includes(w) && !out.includes(w)) out.push(w); };

  for (const b of BUCKETS) for (const w of findWords(t, CLASSIFY_TABLE[b] || [])) push(w);
  for (const k of ["request", "detail"]) for (const w of findWords(t, FLAG_WORDS[k])) push(w);
  for (const w of ((ctx && ctx.interests) || [])) if (t.includes(w)) push(w);

  const lat = [];
  let cur = "";
  for (const ch of t) {
    const c = ch.charCodeAt(0);
    const isWord = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || ch === "-" || ch === "_" || ch === ".";
    if (isWord) cur += ch.toLowerCase();
    else { if (cur.length >= 3) lat.push(cur); cur = ""; }
  }
  if (cur.length >= 3) lat.push(cur);
  for (const w of lat) push(w);

  const runs = [];
  let han = "";
  for (const ch of t) {
    const c = ch.charCodeAt(0);
    const isHan = c >= 19968 && c <= 40959;
    if (isHan) han += ch;
    else { if (han.length >= 2) runs.push(han); han = ""; }
  }
  if (han.length >= 2) runs.push(han);
  let added = 0;
  for (const run of runs) {
    if (added >= 4) break;
    // 长句不切 2 字 n-gram —— "我去调调"→"我去/去调/调调"这种废词就是这么来的；超长句干脆不抽（句子不是关键词）
    const sizes = run.length <= 6 ? [run.length] : [];   // 短句整句当关键词，长句不切片（碎片检索词=废词）
    for (const n of sizes) {
      for (let i = 0; i + n <= run.length; i++) {
        const w = run.slice(i, i + n);
        let bad = false;
        for (const sw of STOPWORDS) if (w.includes(sw)) { bad = true; break; }
        if (bad) continue;
        push(w);
        added += 1;
        if (added >= 4) break;
      }
      if (added >= 4) break;
    }
  }

  return out.slice(0, 8);
}

export function classify(text, ctx) {
  const t = squashSpace(text);
  const flags = flagsOf(t);
  const hits = {};
  let total = 0;
  for (const b of BUCKETS) {
    hits[b] = findWords(t, CLASSIFY_TABLE[b] || []);
    let content = 0;
    for (const w of hits[b]) if (!PARTICLES.includes(w)) content += 1;
    total += content;
  }

  const buckets = BUCKETS.filter(function (b) { return hits[b].length > 0; });
  if (buckets.length === 0) buckets.push("general");

  let depth = 0;
  if (flags.isQuestion || flags.isRequest) depth += 1;
  if (t.length > 40) depth += 1;
  if (total >= 2) depth += 1;
  if (flags.isDetailAsk) depth = Math.max(depth, 2);
  if (flags.isDetailAsk && (t.length >= 12 || total >= 1)) depth = 3;
  if (depth > 3) depth = 3;

  const keywords = extractKeywords(t, ctx);
  const interest = ((ctx && ctx.interests) || []).filter(function (w) { return t.includes(w); });

  return {
    buckets: buckets, topicDepth: depth, keywords: keywords,
    interestHit: interest, hits: hits, flags: flags, length: t.length
  };
}
