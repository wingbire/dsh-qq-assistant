// 生成后兜底校验（P0）：陪伴场景里最伤人的几种句式，光写进人设没用 —— 她们（模型）照样犯。
// 这里只做"命中就重写一次"，不改写语义、不硬替换，避免把话改僵。
// 每条都是被真实记录坑出来的：① 会议纪要式综述 ② 替别人打包票 ③ 客服腔
export const REPLY_CHECKS = [
  {
    why: "像在开会做纪要",
    hint: "别总结、别复述大家说过的话，就用一句人话接住；要表态也只表你自己的。",
    re: /(刚聊的|刚才说|大家说|刚说了|大家聊|汇报一下|总结一下)/
  },
  {
    why: "替别人打包票",
    hint: "别人说的话只能转述、而且必须留余地（他刚好像是说…我不确定）；绝对不许替他保证。",
    re: /(说了|说的|说过|刚说)[^。！？\n]{0,20}(放心|没问题|一定能|肯定|保证|包我|稳了|不会有事)/
  },
  {
    why: "客服腔",
    hint: "说人话，别用服务用语。",
    re: /(有什么可以帮|很高兴为您|请问还有什么|随时为您|感谢您的)/
  }
];

// 返回 { ok:true } 或 { ok:false, why, hint }（纯函数，便于测试）
export function guardReply(text) {
  const t = String(text == null ? "" : text);
  if (!t.trim()) return { ok: true };
  for (const c of REPLY_CHECKS) if (c.re.test(t)) return { ok: false, why: c.why, hint: c.hint };
  return { ok: true };
}
