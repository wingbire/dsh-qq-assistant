// 统一的计价口径：价目表、tokens 拆解、单条成本。
// 前端状态页、demo/cost-report.mjs、docs/COST.md 共用这一份，避免三处口径不一致。
// 价目来源：官方价格页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 模型 deepseek-flash（服务版本 DeepSeek-V4.1-Flash，支持图像理解）。
export const PRICE = {
  offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },   // 元 / 百万 tokens
  peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
};
export const PRICE_MODEL = "deepseek-flash";
export const PRICE_NOTE = "空闲时段半价；高峰 = 北京时间周一至周五 9:00-12:00 / 14:00-18:00（法定节假日除外）";

// 高峰/空闲：按本机时区判断（程序就跑在国内机器上）
export function isPeakTime(ms) {
  const d = new Date(ms == null ? Date.now() : ms);
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  const h = d.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

export function tokensOf(u) {
  const inp = Number(u && u.inputTokens) || 0;
  const out = Number(u && u.outputTokens) || 0;
  const cr = Number(u && u.cacheReadTokens) || 0;
  const cw = Number(u && u.cacheWriteTokens) || 0;
  return { cacheMiss: inp, output: out, cacheHit: cr, cacheWrite: cw, prompt: inp + cr + cw, total: inp + out + cr + cw };
}

// 单次调用花多少钱（元）。when: "peak" | "offPeak"（默认空闲）
export function costOf(u, when) {
  const t = tokensOf(u);
  const p = when === "peak" ? PRICE.peak : PRICE.offPeak;
  return (t.cacheMiss * p.cacheMiss + t.cacheWrite * p.cacheMiss + t.cacheHit * p.cacheHit + t.output * p.output) / 1e6;
}

// 缓存命中相比"全按未命中"省下的钱（元）
export function cacheSavedOf(u, when) {
  const t = tokensOf(u);
  const p = when === "peak" ? PRICE.peak : PRICE.offPeak;
  return (t.cacheHit * (p.cacheMiss - p.cacheHit)) / 1e6;
}

// 把状态页那批观测行折算成"今天的钱"
export function moneyOfRows(rows) {
  let today = 0, replies = 0, cacheSaved = 0, costed = [];
  for (const r of (rows || [])) {
    const u = r && r.usage;
    if (!u) continue;
    const t = tokensOf(u);
    if (!t.total) continue;
    const ts = r.at ? Date.parse(r.at) : NaN;
    const when = (isFinite(ts) && isPeakTime(ts)) ? "peak" : "offPeak";
    const m = costOf(u, when);
    today += m;
    cacheSaved += cacheSavedOf(u, when);
    replies += 1;
    costed.push(m);
  }
  const perReplyAvg = replies ? today / replies : 0;
  return { today: today, replies: replies, perReplyAvg: perReplyAvg, cacheSaved: cacheSaved };
}
