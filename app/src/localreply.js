import fs from "node:fs";
import path from "node:path";

// N5 决策：low 档「本地短句 ≤20 字，不进大脑」，所以需要一份本地回复池。
// 目标：不像机器人、不冷场、不负责信息量 —— 但**绝对不能**来回就那四句。
// 实测被吐槽的原话：「只会嗯嗯啊啊说是」—— 日志里 sent 全是 嗯？/咋了/啥事/在的 在循环。
// 所以这里有三条硬规则：
//   1) 按场景分池（寒暄 / 被点名 / 情绪 / 图片 / 语音 / 各 bucket），别拿"嗯？"糊弄一切
//   2) 同一群里最近 6 条不重复（createLocalReplies）
//   3) 图片 / 语音这种"本来就没看到 / 没转写"的，直接给诚实的短答，零成本也不装懂
export const LOCAL_POOL = {
  question: ["咋啦？", "我看看哈", "嗯，让我想想", "什么事？", "等下，我想想", "这个得琢磨下", "你说，我听着"],
  banter: ["哈哈", "确实", "笑死", "典", "哈哈哈哈", "绷不住了", "有一说一，确实"],
  game: ["我也卡这儿", "这关确实烦", "打不过就躺", "等我来", "别急，下把赢回来", "这游戏是这样的"],
  daily: ["在呢", "嗯哼", "咋了嘛", "在的在的", "我在", "哎，在的"],
  general: ["嗯？", "在的", "咋了", "啥事", "我听着呢", "嗯，你说", "怎么了"]
};

// 被点名（@我 / 回复我 / 叫名字）时改用"应答型"：用户 @ 你是想让你说话，
// 回一句"嗯？/啥事"最伤观感 —— 实测就是这么被吐槽"呆呆的、没过脑子"的。
export const ADDRESSED_POOL = {
  question: ["在的，你说", "在呢，什么事？", "我看看哈", "咋啦？", "你说，我在听", "什么事，说说看"],
  banter: ["在的在的", "来了来了", "哈哈，你说", "嗯哼？", "我听着呢", "咋啦咋啦"],
  game: ["在的在的", "来了来了", "在呢，开黑？", "咋啦", "我也来", "哪个服"],
  daily: ["在的～", "来了来了", "在呢，你说", "咋啦？", "哎，我在", "怎么啦～"],
  general: ["在的，你说", "来了来了", "在呢，咋啦？", "我在，你说", "咋啦咋啦", "在，怎么了？"]
};

// 打招呼/寒暄单独一套：这种话只该有一句像样的回应
// 注意"打招呼"在"打个招呼"里是不连续的 —— 只认整串会漏，所以连"招呼"一起认。
// 拉丁文那几个（hi/hey）交给下面带边界的正则，别用子串匹配（"this" 里也有 hi）。
export const GREET_WORDS = ["打招呼", "打个招呼", "招呼", "在吗", "在么", "在不在", "你好", "早上好", "晚上好", "嗨"];
export const GREET_POOL = ["在的～咋啦？", "在的在的，什么事？", "来啦，怎么啦～", "哟，我在", "在呢，你说～"];

// 情绪宣泄（他妈的…又崩了）：接一句同情的短话，比"嗯？"强得多
export const VENT_POOL = ["咋了？", "又崩了？", "这也太离谱了", "别气别气", "哎，难绷", "气死个人", "缓缓，别急"];

// 图片 / 语音：没看到就直说。这条最要紧 —— 用户发的图和语音不能拿"嗯？"糊过去
// 被戳一戳：别没反应，也别复读"嗯？"—— 一句带情绪的短话
export const POKE_POOL = ["干嘛～", "别戳了", "戳我干嘛", "哎，在呢", "痒", "你戳我我就看你一眼", "再戳一下试试"];

// 引用场景：这回是在答复某条具体消息（我自己或别人），指向明确的短答比"嗯？"自然
export const QUOTE_POOL = ["嗯，就是我说的那个", "对，上一条", "就那个意思", "你往上翻翻", "我说的是那个", "嗯，那条"];

export const MEDIA_POOL = {
  image: ["图我这边没看到内容，你描述下？", "这图我识别不了，说说是啥？", "图没看出来，文字讲讲？", "我这边看不到图，你说说我猜"],
  voice: ["语音我听不了，打字吧", "语音听不到内容，打个字哈", "发语音我这边听不了", "语音没转写，打个字？"],
  other: ["这个我这边打不开，文字说说？", "多媒体我这边看不到，打字吧", "发文字吧，这个我认不出来"]
};

export function isGreeting(text) {
  const t = String(text || "").toLowerCase();
  for (const w of GREET_WORDS) if (t.indexOf(w) >= 0) return true;
  return /^(hi|hello|hey)[\s!！.。~～]*$/.test(t);
}

function bucketOf(d) { return (d && d.bucket) || "general"; }
function addressedOf(d) {
  const hits = (d && Array.isArray(d.hardHits)) ? d.hardHits : [];
  return (Number(d && d.hardStrength) || 0) >= 0.7
    || hits.indexOf("nick") >= 0 || hits.indexOf("at") >= 0 || hits.indexOf("reply") >= 0;
}

// 场景 → 用哪个池子。分开写是为了能单独测：图片就必须走"看不到图"那套。
export function poolFor(decision, opts) {
  const o = opts || {};
  const d = decision || {};
  const text = String(o.text != null ? o.text : (d.text || ""));
  const bucket = bucketOf(d);
  const reasonText = (Array.isArray(d.reason) ? d.reason : []).join(" ");
  if (o.poke || reasonText.indexOf("被戳") >= 0) return { scene: "poke", pool: POKE_POOL };
  if (text.indexOf("[图片]") >= 0) return { scene: "image", pool: MEDIA_POOL.image };
  if (text.indexOf("[语音]") >= 0) return { scene: "voice", pool: MEDIA_POOL.voice };
  if (text.indexOf("[多媒体]") >= 0) return { scene: "media", pool: MEDIA_POOL.other };
  if (reasonText.indexOf("情绪宣泄") >= 0) return { scene: "vent", pool: VENT_POOL };
  if (o.quoted || reasonText.indexOf("引用") >= 0) return { scene: "quote", pool: QUOTE_POOL };
  if (isGreeting(text)) return { scene: "greet", pool: GREET_POOL };
  if (addressedOf(d)) return { scene: "addressed:" + bucket, pool: ADDRESSED_POOL[bucket] || ADDRESSED_POOL.general };
  return { scene: bucket, pool: LOCAL_POOL[bucket] || LOCAL_POOL.general };
}

function pickFrom(pool, recent, rng) {
  const rec = Array.isArray(recent) ? recent : [];
  const fresh = pool.filter(function (s) { return rec.indexOf(s) < 0; });
  const use = fresh.length ? fresh : pool;                 // 池子都说过一遍了，才允许重复
  const r = typeof rng === "function" ? rng() : Math.random();
  const i = Math.floor(r * use.length) % use.length;
  return { text: use[i], fresh: fresh.length > 0, size: use.length };
}

// 旧签名保留：不传 recent 就是纯随机（测试与旧调用点不用改）
export function localReply(decision, opts) {
  const o = opts || {};
  const rng = o.rng || Math.random;
  const p = poolFor(decision, o);
  return pickFrom(p.pool, o.recent, rng).text;
}

// 落地版：同一群最近 maxRecent 条不重复，并把"说过什么"落盘活过重启。
export function createLocalReplies(opts) {
  const o = opts || {};
  const file = o.file || null;
  const maxRecent = Number(o.maxRecent) || 6;
  const rng = o.rng || Math.random;
  const recentBy = {};
  const stats = { picks: 0, avoidedRepeats: 0 };
  let saveTimer = null;

  function load() {
    if (!file) return false;
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!v || typeof v !== "object") return false;
      for (const k of Object.keys(v)) if (Array.isArray(v[k])) recentBy[k] = v[k].slice(-maxRecent);
      return true;
    } catch (e) { return false; }
  }
  function save(immediate) {
    if (!file) return;
    if (!immediate) {
      if (saveTimer) return;
      saveTimer = setTimeout(function () { saveTimer = null; save(true); }, 1000);
      if (saveTimer.unref) saveTimer.unref();
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(recentBy), "utf8");
    } catch (e) {}
  }
  function reply(decision, opts2) {
    const o2 = opts2 || {};
    const gid = String(o2.gid || "default");
    const p = poolFor(decision, o2);
    const rec = recentBy[gid] || [];
    const picked = pickFrom(p.pool, rec, o2.rng || rng);
    stats.picks += 1;
    if (!picked.fresh) stats.avoidedRepeats += 0;
    recentBy[gid] = rec.concat([picked.text]).slice(-maxRecent);
    save(false);
    return picked.text;
  }
  function flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } save(true); }

  load();
  return {
    reply: reply,
    flush: flush,
    poolFor: poolFor,
    recent: function (gid) { return (recentBy[String(gid || "default")] || []).slice(); },
    stats: function () { return Object.assign({}, stats); }
  };
}
