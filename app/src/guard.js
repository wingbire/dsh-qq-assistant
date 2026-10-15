// 生成后兜底校验（P0）：**只拦"信任与事实"这两类**，语气问题交给正例，不设闸门。
// 为什么不宽：规则越多，模型越把算力花在"别违规"上，输出会变成安全但僵硬的合规腔。
// 所以这里只保留两条"说了会出事"的：替别人打包票、把闲聊做成会议纪要。
export const REPLY_CHECKS = [
  {
    why: "替别人打包票",
    hint: "别人说的话你只能转述还要留余地。像这样：「他刚好像是说可以，我不确定，你直接问他更准」。",
    re: /(说了|说的|说过|刚说)[^。！？\n]{0,20}(放心|没问题|一定能|肯定|保证|包我|稳了|不会有事)/
  },
  {
    why: "像在开会做纪要",
    hint: "别总结、别复述大家说过的话，只说你自己的看法。像这样接：「台式确实划算，就是占地方，我要是你就再等等」。",
    re: /(刚聊的|刚才说|大家说|刚说了|大家聊|汇报一下|总结一下)/
  }
];

// 语气类问题**不进闸门**（不重写、不惩罚），只在文档和人设里用正例带：
// 这些交给【我可以】+【语气样板】，硬拦反而会把话改僵。
export const SOFT_HINTS = [
  { why: "客服腔", re: /(有什么可以帮|很高兴为您|请问还有什么|随时为您|感谢您的)/ },
  { why: "过度自证", re: /(我之所以|之所以.{0,10}是因为).{0,30}(是因为|所以)/ },
  { why: "过度道歉", re: /(非常抱歉|十分抱歉|实在不好意思).{0,30}(抱歉|对不起)/ }
];

// 返回 { ok:true } 或 { ok:false, why, hint }（纯函数，便于测试）
export function guardReply(text) {
  const t = String(text == null ? "" : text);
  if (!t.trim()) return { ok: true };
  for (const c of REPLY_CHECKS) if (c.re.test(t)) return { ok: false, why: c.why, hint: c.hint };
  return { ok: true };
}

// 语气体检：只用于观察/记录，不阻断发送
export function softFlags(text) {
  const t = String(text == null ? "" : text);
  return SOFT_HINTS.filter(function (c) { return c.re.test(t); }).map(function (c) { return c.why; });
}
