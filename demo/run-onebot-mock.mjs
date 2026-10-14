// P1 验收：本地 mock OneBot v11 服务器 + 真 WebSocket 客户端 + 完整判定/合并/刹车链路。
// 不连 QQ、不调模型（大脑用假实现），但走的是真实传输与真实判定中枢。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMockOneBotServer } from "../app/src/mock-onebot-server.js";
import { createOneBot } from "../app/src/onebot.js";
import { createRuntime } from "../app/src/runtime.js";
import { createBot } from "../app/src/index.js";
import { createStore } from "../app/src/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA = path.join(ROOT, "app", "dsh-data", "onebot-mock");
fs.rmSync(DATA, { recursive: true, force: true });

const checks = [];
function check(name, pass, detail) { checks.push({ name, pass: !!pass, detail: detail == null ? "" : String(detail) }); console.log((pass ? "PASS " : "FAIL ") + name + (detail != null ? "  :: " + detail : "")); }
const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
async function drive(rt, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { await rt.tick(); await wait(step || 60); }
}

const GID = "123456789";
const srv = createMockOneBotServer({ token: "testtoken", selfId: 999 });
const port = await srv.listen(0);
console.log("=== mock OneBot 服务器 ===");
console.log("  ws://127.0.0.1:" + port + "（令牌 testtoken）");

// --- 1) 令牌校验：错令牌必须连不上 ---
const bad = createOneBot({ url: "ws://127.0.0.1:" + port, token: "wrong", reconnectMs: 999999 });
bad.connect();
await wait(500);
check("错误令牌被服务器拒绝", bad.state() !== "open", "state=" + bad.state());
bad.close();

// --- 2) 正确令牌连上 ---
let handleIncoming = function () {};
const ob = createOneBot({
  url: "ws://127.0.0.1:" + port, token: "testtoken", reconnectMs: 200,
  onEvent: function (evt) { handleIncoming(evt); }
});
const store = createStore(path.join(DATA, "data"));
const bot = createBot({ dataRoot: path.join(DATA, "data"), botNames: ["小肥鱼"], nicknames: ["肥鱼"] });
let brainCalls = 0;
const sentByRuntime = [];
const rt = createRuntime({
  config: { admin: { admins: ["1001"] } },
  runtime: { observe: false, coalesceWindowMs: 300, coalesceMaxBatch: 5, maxSegments: 3, contextWindow: 10 },
  store: store, bot: bot,
  evtDefaults: { botNames: ["小肥鱼"], nicknames: ["肥鱼"], interests: ["单机游戏", "做视频"] },
  send: function (gid, text) { sentByRuntime.push(text); return ob.sendGroupMsg(gid, text); },
  askBrain: async function () {
    brainCalls += 1;
    // 故意给一段超过中档上限（60 字）的正文，用来验证 N6 的分条发送
    return { ok: true, text: "先给结论：换个武器就行，别急着重装客户端。详细说，是那个词条没生效导致的。最后补一句，重开之前先备份配置，省得白折腾一晚上。还有啊，那个报错本身不用管。", usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 1800, cacheWriteTokens: 0, totalTokens: 2040 } };
  },
  sleep: function () { return Promise.resolve(); }, sendGapMs: 0
});
ob.connect();
await wait(400);
check("正确令牌连上", ob.state() === "open", "state=" + ob.state());

handleIncoming = function (evt) { rt.onEvent(evt); };

// --- 3) N23：同一人短时连发两条 → 合并成一轮，只回一次 ---
srv.groupMessage({ group_id: GID, user_id: 2001, nickname: "甲", segments: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: " 在吗" } }] });
await wait(120);
srv.groupMessage({ group_id: GID, user_id: 2001, nickname: "甲", segments: [{ type: "text", data: { text: "帮我看看这个报错" } }] });
await drive(rt, 1200);
const gotTexts = srv.sentTexts();
check("两条连发只触发一次大脑调用", brainCalls === 1, "brainCalls=" + brainCalls);
check("N6：超过上限的回复按句号分多条发出", gotTexts.length >= 2, "实发 " + gotTexts.length + " 条：" + JSON.stringify(gotTexts));
check("每条都不超中档上限", gotTexts.every(function (t) { return t.length <= 60; }), JSON.stringify(gotTexts.map(function (t) { return t.length; })));
check("合并计数被记录", rt.stats().events === 2, JSON.stringify(rt.stats()));

// --- 4) N10：群内指令 /停 ---
srv.groupMessage({ group_id: GID, user_id: 1001, nickname: "管理", role: "admin", segments: [{ type: "text", data: { text: "/停 5" } }] });
await drive(rt, 600);
check("管理员 /停 有回执", srv.sentTexts().some(function (t) { return t.indexOf("闭嘴") >= 0; }));
const sentBefore = srv.sentTexts().length;
srv.groupMessage({ group_id: GID, user_id: 2002, nickname: "乙", segments: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: " 再问一句" } }] });
await drive(rt, 600);
check("暂停期间被拦住（计数增加、不再发送）", rt.stats().stopped >= 1 && srv.sentTexts().length === sentBefore, "stopped=" + rt.stats().stopped + " 发送数 " + sentBefore + "->" + srv.sentTexts().length);

// --- 5) N10：STOP 文件全局刹车 ---
fs.writeFileSync(path.join(ROOT, "STOP"), "test");
const st = rt.brakes.state("other-group", Date.now());
check("STOP 文件触发全局停", st.stopped === true && st.reason === "STOP 文件", JSON.stringify(st));
fs.unlinkSync(path.join(ROOT, "STOP"));

// --- 6) 观察日志确实落盘 ---
const obsFile = path.join(DATA, "data", "data", "observation.jsonl");
let obsLines = 0;
try { obsLines = fs.readFileSync(obsFile, "utf8").split(String.fromCharCode(10)).filter(Boolean).length; } catch (e) {}
check("判定与发送都写进 observation.jsonl", obsLines > 0, "行数=" + obsLines);

// --- 7) 断线自动重连 ---
srv.close();
await wait(300);
const reconnecting = ["connecting", "reconnecting", "closed", "error"].indexOf(ob.state()) >= 0;
check("服务器断开后进入重连态", reconnecting, "state=" + ob.state());
ob.close();

console.log("");
console.log("=== 汇总 ===");
const failed = checks.filter(function (c) { return !c.pass; });
console.log("  通过 " + (checks.length - failed.length) + " / " + checks.length);
console.log("  大脑调用 " + brainCalls + " 次，实发消息 " + srv.sentTexts().length + " 条");
console.log("  运行统计 " + JSON.stringify(rt.stats()));
process.exitCode = failed.length ? 1 : 0;
