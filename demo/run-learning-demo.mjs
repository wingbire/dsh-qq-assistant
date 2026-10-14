// P3 验收：学习闭环 —— 观察期攒样本 → 人工标注 → 回流标定 → 反馈归因 → reward → bandit → refN 重炼群档案
// 不连 QQ、不调模型（大脑用假实现），但走的是真实 store / 真实判定中枢 / 真实学习模块。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../app/src/store.js";
import { createBot } from "../app/src/index.js";
import { createRuntime } from "../app/src/runtime.js";
import { createLabelQueue, agreementStats } from "../app/src/label.js";
import { engagementOf, reward } from "../app/src/score.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA = path.join(ROOT, "app", "dsh-data", "learning-demo");
fs.rmSync(DATA, { recursive: true, force: true });

const checks = [];
function check(name, pass, detail) { checks.push({ name: name, pass: !!pass }); console.log((pass ? "PASS " : "FAIL ") + name + (detail != null ? "  :: " + detail : "")); }

let clock = 0;
const store = createStore(path.join(DATA, "data"));
const bot = createBot({ store: store, score: { refN: 2 }, botNames: ["小肥鱼"], nicknames: ["肥鱼"] });
const sent = [];
const obs = [];
const prompts = [];

const rt = createRuntime({
  config: {}, runtime: { observe: false, coalesceWindowMs: 50, contextWindow: 10, labelMinSamples: 3 },
  store: store, bot: bot,
  evtDefaults: { botNames: ["小肥鱼"], nicknames: ["肥鱼"], interests: ["单机游戏"] },
  send: function (g, t) { sent.push(t); },
  askBrain: async function (o) { prompts.push(o.promptText); return { ok: true, text: "先换把武器试试。", usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 2400, cacheWriteTokens: 0 } }; },
  now: function () { return clock; }, sleep: async function () {}, sendGapMs: 0
});
const rtl = createRuntime({
  config: {}, runtime: { observe: true, coalesceWindowMs: 50, labelMinSamples: 3 },
  store: store, bot: createBot({ store: store, botNames: ["小肥鱼"] }),
  send: function () {}, askBrain: async function () { return { ok: true, text: "x" }; },
  now: function () { return clock; }, sleep: async function () {}, sendGapMs: 0
});

const G = "123456789";          // 学习用的群
const G2 = "111222333";         // 观察期攒样本的群

async function say(rtx, evt, at) { clock = at; await rtx.onEvent(evt); }
async function tick(rtx, at) { clock = at; return rtx.tick(at); }

console.log("=== ① 观察期：新群攒待标注样本 ===");
await say(rtl, { gid: G2, uid: "9001", speaker: "路人甲", text: "这个报错怎么解", now: 0 });
await tick(rtl, 100);
await say(rtl, { gid: G2, uid: "9002", speaker: "路人乙", text: "哈哈哈哈", now: 200 });
await tick(rtl, 300);
await say(rtl, { gid: G2, uid: "9003", speaker: "路人丙", text: "小肥鱼 你觉得呢", atBot: true, now: 400 });
await tick(rtl, 500);
const q = createLabelQueue({ store: store, minSamples: 3 });
const st0 = q.status();
check("观察期只判定不发送", sent.length === 0, "已发 " + sent.length + " 条");
check("判定都进了待标注队列", st0.pending === 3, "pending=" + st0.pending);

console.log("");
console.log("=== ② 人工标注 + 回流标定 ===");
const pend = q.pending();
const before = bot.getBounds();
q.label(pend[0].id, "该回");
q.label(pend[1].id, "不该回");
q.label(pend[2].id, "该回");
const reflow = q.reflowIfReady(before, 1000);
const ag = agreementStats(q.rows());
check("满 3 条即触发回流", reflow.ready === true, JSON.stringify({ n: reflow.n, missedRate: reflow.stats.missedRate }));
check("回流给出了新边界", !!reflow.bounds, JSON.stringify(reflow.bounds));
if (reflow.changed && bot.setBounds) bot.setBounds(reflow.bounds);
check("一致率高 → 灰区收紧（下界上抬）", reflow.bounds.lo >= before.lo, "lo " + before.lo + " → " + reflow.bounds.lo);
console.log("     一致率=" + (ag.agreement * 100).toFixed(0) + "%  漏接率=" + (ag.missedRate * 100).toFixed(0) + "%  灰区噪声=" + (ag.flipRate * 100).toFixed(0) + "%");

// 反向场景：管理员标了三条「本地判否但其实该回」→ 漏接率 100% → 灰区应放宽
const loBefore = bot.getBounds().lo;
for (let i = 0; i < 3; i++) {
  q.recordCandidate({ gid: G2, messageId: "miss-" + i, text: "被误杀的第 " + i + " 句", localVerdict: "no", localAction: "ignore" });
  q.label(G2 + ":miss-" + i, "该回");
}
const reflow2 = q.reflowIfReady(bot.getBounds(), 2000);
check("漏接率高 → 灰区放宽（下界下调）", reflow2.ready && reflow2.stats.missedRate >= 0.5 && reflow2.bounds.lo < loBefore,
  "missedRate=" + (reflow2.stats.missedRate * 100).toFixed(0) + "%  lo " + loBefore + " → " + reflow2.bounds.lo);

console.log("");
console.log("=== ③ 反馈归因：被回复的人有没有接着说 ===");
await say(rt, { gid: G, uid: "1001", speaker: "甲", text: "小肥鱼 这个报错怎么解", atBot: true, now: 2000 });
await tick(rt, 2100);
check("回了一条并挂上待定反馈", sent.length >= 1 && rt.pendingFeedback() === 1, "sent=" + sent.length + " pending=" + rt.pendingFeedback());
await say(rt, { gid: G, uid: "1001", speaker: "甲", text: "小肥鱼 那再说说原因", now: 2200 });   // 同人接着说 + 叫外号
await tick(rt, 2300);
check("同人接着说 → continued_with_bot", rt.stats().feedbackResolved === 1, "已结算 " + rt.stats().feedbackResolved);
const fb1 = store.readJsonl(store.paths.feedback);
check("反馈写进了 interaction-feedback.jsonl", fb1.length === 1, "行数=" + fb1.length);
check("outcome 记为 continued_with_bot", fb1[0].outcome === "continued_with_bot", "outcome=" + fb1[0].outcome);
check("叫了外号 → engagement 4", engagementOf(fb1[0]) === 4, "engagement=" + engagementOf(fb1[0]) + " nickCall=" + fb1[0].nickCall);

await say(rt, { gid: G, uid: "1002", speaker: "乙", text: "小肥鱼 帮我看看", atBot: true, now: 2400 });
await tick(rt, 2500);
await say(rt, { gid: G, uid: "1003", speaker: "丙", text: "对了那个副本", now: 2600 });     // 换人 → 负
await tick(rt, 2700);
const fb2 = store.readJsonl(store.paths.feedback);
check("换人说话 → went_to_others", fb2.length >= 2 && fb2.some(function (f) { return f.outcome === "went_to_others"; }),
  "共 " + fb2.length + " 条：" + fb2.map(function (f) { return f.outcome; }).join(","));

console.log("");
console.log("=== ④ reward 与 bandit 后验 ===");
for (const f of fb2) console.log("     outcome=" + f.outcome + "  engagement=" + engagementOf(f) + "  reward=" + f.reward + "  arm=" + f.arm + "  bucket=" + f.bucket);
const bs = bot.bandit.state();
const keys = Object.keys(bs);
check("bandit 后验键名带群号（跨群隔离）", keys.length > 0 && keys.every(function (k) { return k.split("|")[0] === G; }), keys.join(" , "));
check("reward 已被记录", fb2.every(function (f) { return typeof f.reward === "number"; }), JSON.stringify(fb2.map(function (f) { return f.reward; })));

console.log("");
console.log("=== ⑤ refN=2 到点重炼群档案，并进后续 prompt ===");
const prof = store.loadProfile(G);
check("群档案已生成", !!prof && prof.rounds >= 1, JSON.stringify(prof && { rounds: prof.rounds, interests: prof.interests }));
await say(rt, { gid: G, uid: "1004", speaker: "丁", text: "小肥鱼 再来一次", atBot: true, now: 2800 });
await tick(rt, 2900);
const lastPrompt = prompts[prompts.length - 1] || "";
check("群档案进了 prompt", lastPrompt.indexOf("【本群画像】") >= 0);
check("上下文仍在 prompt 最后（N8）", lastPrompt.trim().endsWith("丁：小肥鱼 再来一次"), "结尾=" + JSON.stringify(lastPrompt.trim().slice(-24)));
const jsonl = store.readJsonl(store.paths.observe);
check("全过程都有 observation 落盘", jsonl.length > 5, "行数=" + jsonl.length);

console.log("");
console.log("=== 汇总 ===");
const failed = checks.filter(function (c) { return !c.pass; });
console.log("  通过 " + (checks.length - failed.length) + " / " + checks.length);
console.log("  反馈 " + fb2.length + " 条，重炼 " + rt.stats().refits + " 次，待标注候选 " + rtl.stats().labelCandidates + " 条");
process.exitCode = failed.length ? 1 : 0;
