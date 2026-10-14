// P4 验收：dsh-meme 图库真发图 + 主动搭话 + 指令注册表
// 真 WebSocket（自写 mock 服务器）、真图库（sqlite index.db）、真判定中枢；只有大脑是假的。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMockOneBotServer } from "../app/src/mock-onebot-server.js";
import { createOneBot } from "../app/src/onebot.js";
import { createRuntime } from "../app/src/runtime.js";
import { createBot } from "../app/src/index.js";
import { createStore } from "../app/src/store.js";
import { createMemeLibrary } from "../app/src/meme.js";
import { createDefaultCommands } from "../app/src/commands.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA = path.join(ROOT, "app", "dsh-data", "meme-demo");
fs.rmSync(DATA, { recursive: true, force: true });

const checks = [];
function check(name, pass, detail) { checks.push({ name: name, pass: !!pass }); console.log((pass ? "PASS " : "FAIL ") + name + (detail != null ? "  :: " + detail : "")); }
const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
async function drive(rt, ms, step) { const t0 = Date.now(); while (Date.now() - t0 < ms) { await rt.tick(); await wait(step || 60); } }

const lib = createMemeLibrary({});
console.log("=== 图库 ===");
console.log("  位置：" + lib.packDir);
console.log("  张数：" + lib.rows.length + "  情绪标签 " + lib.tags().length + " 个：" + lib.tags().slice(0, 8).join("/") + "…");
check("图库可用", lib.ready === true, "rows=" + lib.rows.length);

const GID = "123456789";
const srv = createMockOneBotServer({ token: "t", selfId: 999 });
const port = await srv.listen(0);
let handler = function () {};
const ob = createOneBot({ url: "ws://127.0.0.1:" + port, token: "t", reconnectMs: 500, onEvent: function (e) { handler(e); } });

const store = createStore(path.join(DATA, "data"));
const bot = createBot({ store: store, botNames: ["小肥鱼"], nicknames: ["肥鱼"], proactive: { rate: 1, minGapSec: 0, maxPerHour: 10, cooldownAfterBotReplySec: 0, requireInterest: true } });
let brainText = "行吧这波我确实没看懂 [表情: 无语]";
const rt = createRuntime({
  config: { admin: { owners: ["1001"] } },
  runtime: { observe: false, coalesceWindowMs: 150, coalesceMaxBatch: 5, memeFreq: "中", memeGapReplies: 0, contextWindow: 10 },
  store: store, bot: bot, memes: lib,
  send: function (g, t) { return ob.sendGroupMsg(g, t); },
  sendImage: function (g, f) { return ob.sendGroupImage(g, f); },
  evtDefaults: { botNames: ["小肥鱼"], nicknames: ["肥鱼"], interests: ["单机游戏"] },
  askBrain: async function () { return { ok: true, text: brainText, usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 1800, cacheWriteTokens: 0 } }; },
  sleep: function () { return Promise.resolve(); }, sendGapMs: 0
});
ob.connect();
await wait(400);
check("接上 mock OneBot", ob.state() === "open", "state=" + ob.state());
handler = function (e) { rt.onEvent(e); };

console.log("");
console.log("=== ① 中档回复带 [表情: 无语] → 应图 + 正文摘标记 ===");
srv.groupMessage({ group_id: GID, user_id: 2001, nickname: "甲", segments: [{ type: "text", data: { text: "小肥鱼 你怎么看" } }] });
await drive(rt, 1200);
const texts = srv.received.filter(function (r) { return r && r.action === "send_group_msg" && typeof r.params.message === "string"; }).map(function (r) { return r.params.message; });
const imgs = srv.received.filter(function (r) { return r && r.action === "send_group_msg" && Array.isArray(r.params.message) && r.params.message[0] && r.params.message[0].type === "image"; });
check("正文发出且标记被摘掉", texts.length >= 1 && texts[0].indexOf("[表情:") < 0, JSON.stringify(texts));
check("发了一张图", imgs.length === 1, "图片段数=" + imgs.length);
if (imgs.length) {
  const f = imgs[0].params.message[0].data.file;
  check("图是图库里的真实文件（绝对路径且存在）", path.isAbsolute(f) && fs.existsSync(f), f);
  check("图落在 sigh 标签（「无语」的对应图）", f.indexOf("sigh") >= 0 || f.indexOf("wuyu") >= 0, f);
}
check("配图计数", rt.stats().memesSent === 1, "memesSent=" + rt.stats().memesSent);

console.log("");
console.log("=== ② 详细档不配图 ===");
brainText = "这个报错的成因是配置路径没转义。先看第一段。 [表情: 得意]";
srv.groupMessage({ group_id: GID, user_id: 2002, nickname: "乙", segments: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: " 详细讲讲这个报错的原因和原理，我要写进文档里" } }] });
await drive(rt, 1500);
const imgs2 = srv.received.filter(function (r) { return r && r.action === "send_group_msg" && Array.isArray(r.params.message); });
check("详细档没有新增图", imgs2.length === 1, "累计图片段=" + imgs2.length);
check("被抑制的配图有记录", rt.stats().memesSuppressed >= 1, "suppressed=" + rt.stats().memesSuppressed);

console.log("");
console.log("=== ③ 指令注册表 ===");
const cmds = createDefaultCommands({ brakes: rt.brakes, budget: rt.budget, stopMinutes: 45 });
check("内置四条指令", cmds.list().length === 4, cmds.list().map(function (s) { return "/" + s.name; }).join(" "));
srv.groupMessage({ group_id: GID, user_id: 9999, nickname: "路人", role: "member", segments: [{ type: "text", data: { text: "/停" } }] });
await drive(rt, 600);
check("普通成员停不动", rt.brakes.state(GID, Date.now()).stopped === false);
srv.groupMessage({ group_id: GID, user_id: 1001, nickname: "群主", role: "owner", segments: [{ type: "text", data: { text: "/停 45" } }] });
await drive(rt, 600);
const st = rt.brakes.state(GID, Date.now());
check("群主 /停 45 生效", st.stopped === true, JSON.stringify(st));
srv.groupMessage({ group_id: GID, user_id: 1001, nickname: "群主", role: "owner", segments: [{ type: "text", data: { text: "/开" } }] });
await drive(rt, 600);
check("群主 /开 解除", rt.brakes.state(GID, Date.now()).stopped === false);
check("指令都进了 observation", store.readJsonl(store.paths.observe).some(function (x) { return x.kind === "command"; }));

console.log("");
console.log("=== ④ 主动搭话（全自动阶段 + 兴趣命中）===");
// 放开兴趣与概率，确保这一段真的能走到主动搭话（真实运行时由群档案兴趣决定）
// 换一个干净的群：刚刚回过话的群会因「连续性」特征把 p_say 抬上去，那条就不会被判否了
bot.proactive.config().requireInterest = false;
bot.proactive.config().rate = 1;
brainText = "我也在玩这个。";
const GID2 = "111222333";
srv.groupMessage({ group_id: GID2, user_id: 2003, nickname: "丙", segments: [{ type: "text", data: { text: "他说这个副本要打三遍才行，他说他会带我们" } }] });
await drive(rt, 1200);
const pro = store.readJsonl(store.paths.observe).filter(function (x) { return x.kind === "proactive_sent" || x.kind === "proactive_error"; });
console.log("     主动搭话记录：" + JSON.stringify(pro.slice(-2)));
console.log("     统计：" + JSON.stringify({ tried: rt.stats().proactiveTried, spoken: rt.stats().proactiveSpoken, blocked: rt.stats().proactiveBlocked }));
check("主动搭话真的插了一句（全自动阶段）", rt.stats().proactiveSpoken === 1, "spoken=" + rt.stats().proactiveSpoken);
check("插话内容进了 observation", pro.length >= 1 && pro[pro.length - 1].kind === "proactive_sent", JSON.stringify(pro[pro.length - 1] || null));

ob.close();
await srv.close();
console.log("");
console.log("=== 汇总 ===");
const failed = checks.filter(function (c) { return !c.pass; });
console.log("  通过 " + (checks.length - failed.length) + " / " + checks.length);
console.log("  图库 " + lib.rows.length + " 张 / " + lib.tags().length + " 标签；实发图 " + rt.stats().memesSent + " 次；抑制 " + rt.stats().memesSuppressed + " 次");
process.exitCode = failed.length ? 1 : 0;
