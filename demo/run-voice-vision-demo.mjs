// N18 验收：识图（走独立多模态调用）+ 语音（真 SAPI 合成 → 真 record 段发出去）
// 真 WebSocket（自写 mock 服务器）、真 TTS；识图用假 fetch（不发真实请求、不花钱）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { createMockOneBotServer } from "../app/src/mock-onebot-server.js";
import { createOneBot } from "../app/src/onebot.js";
import { createRuntime } from "../app/src/runtime.js";
import { createBot } from "../app/src/index.js";
import { createStore } from "../app/src/store.js";
import { createVision } from "../app/src/vision.js";
import { createTts } from "../app/src/tts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA = path.join(ROOT, "app", "dsh-data", "voice-vision-demo");
fs.rmSync(DATA, { recursive: true, force: true });

const checks = [];
function check(name, pass, detail) { checks.push({ name: name, pass: !!pass }); console.log((pass ? "PASS " : "FAIL ") + name + (detail != null ? "  :: " + detail : "")); }
const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
async function drive(rt, ms, step) { const t0 = Date.now(); while (Date.now() - t0 < ms) { await rt.tick(); await wait(step || 60); } }
// 等一个条件成立（TTS 要起 PowerShell 念一遍，1~2 秒很正常，不能只睡固定时长就断言）
async function until(fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 8000)) { if (fn()) return true; await wait(120); }
  return false;
}
const recCount = function () {
  return srv.received.filter(function (r) { return r && r.action === "send_group_msg" && Array.isArray(r.params.message) && r.params.message[0] && r.params.message[0].type === "record"; }).length;
};

// 造一张真实的本地图片（1×1 PNG），让识图链路走真文件
const imgPath = path.join(DATA, "test.png");
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(imgPath, Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001od".replace(/[^0-9a-f]/gi, "").slice(0, 130), "hex"));

const vision = createVision({
  config: { mode: "http", endpoint: "https://fake.test/v1/chat/completions", model: "mimo-v2.6-flash-free", maxChars: 300 },
  fetch: async function () {
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: "一张截图，上面写着 TypeError: undefined is not a function" } }], usage: { total_tokens: 321 } }; } };
  }
});
const tts = createTts({ config: { enabled: true, voice: "Microsoft Huihui", maxChars: 60 }, outDir: path.join(DATA, "voice") });

const GID = "123456789";
const srv = createMockOneBotServer({ token: "t", selfId: 999 });
const port = await srv.listen(0);
let handler = function () {};
const ob = createOneBot({ url: "ws://127.0.0.1:" + port, token: "t", reconnectMs: 500, onEvent: function (e) { handler(e); } });

const store = createStore(path.join(DATA, "data"));
const bot = createBot({ store: store, botNames: ["小肥鱼"], nicknames: ["肥鱼"] });
const prompts = [];
let voiceMode = false;      // 让假大脑在某一轮带上 [语音: …] 标记
const rt = createRuntime({
  config: { admin: { owners: ["1001"] } },
  runtime: { observe: false, coalesceWindowMs: 150 },
  store: store, bot: bot, vision: vision, tts: tts, imageDir: path.join(DATA, "images"),
  send: function (g, t) { return ob.sendGroupMsg(g, t); },
  sendRecord: function (g, f) { return ob.sendGroupRecord(g, f); },
  evtDefaults: { botNames: ["小肥鱼"], nicknames: ["肥鱼"] },
  askBrain: async function (o) {
    prompts.push(o.promptText);
    return {
      ok: true,
      text: voiceMode ? "行吧我念给你听 [语音: 那个变量不是函数啦]" : "我看看……是个类型错误，那个变量不是函数。",
      usage: { inputTokens: 200, outputTokens: 20 }
    };
  },
  sleep: function () { return Promise.resolve(); }, sendGapMs: 0
});
ob.connect();
await wait(400);
check("接上 mock OneBot", ob.state() === "open", "state=" + ob.state());
handler = function (e) { rt.onEvent(e); };

console.log("");
console.log("=== ① 识图：纯图片消息（没有文字）===");
// 带上 @：纯图片没被点名本来就不该回（判定中枢会判否），这里要看的是「图片描述进没进 prompt」
srv.groupMessage({ group_id: GID, user_id: 2001, nickname: "甲", segments: [{ type: "at", data: { qq: "999" } }, { type: "image", data: { file: imgPath } }] });
await drive(rt, 1200);
check("纯图片消息没被丢掉", rt.stats().events >= 1, "events=" + rt.stats().events);
check("识图调了一次", rt.stats().visionCalls === 1, "calls=" + rt.stats().visionCalls);
check("识图成功", rt.stats().visionOk === 1, "ok=" + rt.stats().visionOk);
check("图片描述进了 prompt", (prompts[0] || "").indexOf("TypeError") >= 0, JSON.stringify((prompts[0] || "").slice(-90)));
const texts = srv.received.filter(function (r) { return r && r.action === "send_group_msg" && typeof r.params.message === "string"; }).map(function (r) { return r.params.message; });
check("照常回了正文", texts.length >= 1, JSON.stringify(texts.slice(0, 1)));
check("识图失败不影响回复（此处应成功）", rt.stats().visionFail === 0);

console.log("");
console.log("=== ② 语音：管理员 /说 → 真 TTS → record 段 ===");
srv.groupMessage({ group_id: GID, user_id: 1001, nickname: "群主", role: "owner", segments: [{ type: "text", data: { text: "/说 大家好,我是小肥鱼" } }] });
await drive(rt, 300);
const gotRecord = await until(function () { return recCount() >= 1; }, 12000);
const recs = srv.received.filter(function (r) { return r && r.action === "send_group_msg" && Array.isArray(r.params.message) && r.params.message[0] && r.params.message[0].type === "record"; });
check("发出去了一个 record 段", recs.length === 1 && gotRecord, "record 段数=" + recs.length);
if (recs.length) {
  const f = recs[0].params.message[0].data.file;
  const exists = fs.existsSync(f);
  check("语音文件真实存在", exists, f);
  if (exists) {
    const head = fs.readFileSync(f).subarray(0, 4).toString();
    check("是合法 wav（RIFF 头）", head === "RIFF", head + "  " + Math.round(fs.statSync(f).size / 1024) + " KB");
  }
}
check("语音计数", rt.stats().voiceSent === 1, "voiceSent=" + rt.stats().voiceSent);

console.log("");
console.log("=== ③ 权限：普通成员 /说 不动 ===");
srv.groupMessage({ group_id: GID, user_id: 2002, nickname: "路人", role: "member", segments: [{ type: "text", data: { text: "/说 我也要" } }] });
await drive(rt, 600);
check("普通成员发不了语音", rt.stats().voiceSent === 1, "voiceSent 仍是 " + rt.stats().voiceSent);

console.log("");
console.log("=== ④ [语音: …] 标记：大脑自己决定要用语音 ===");
const before = rt.stats().voiceSent;
const recsBefore = srv.received.filter(function (r) { return r && r.action === "send_group_msg" && Array.isArray(r.params.message) && r.params.message[0] && r.params.message[0].type === "record"; }).length;
voiceMode = true;   // 让假大脑这一轮带上 [语音: …]
srv.groupMessage({ group_id: GID, user_id: 2003, nickname: "乙", segments: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: " 那你说一句听听" } }] });
await drive(rt, 400);
await until(function () { return recCount() >= recsBefore + 1; }, 12000);
await drive(rt, 200);
voiceMode = false;
const recsAfter = srv.received.filter(function (r) { return r && r.action === "send_group_msg" && Array.isArray(r.params.message) && r.params.message[0] && r.params.message[0].type === "record"; }).length;
check("[语音:] 标记也会发 record", recsAfter === recsBefore + 1, "record " + recsBefore + " -> " + recsAfter);
check("语音计数涨了", rt.stats().voiceSent === before + 1, "voiceSent " + before + " -> " + rt.stats().voiceSent);
const lastTexts = srv.received.filter(function (r) { return r && r.action === "send_group_msg" && typeof r.params.message === "string"; }).map(function (r) { return r.params.message; });
check("正文里的 [语音:] 标记被摘掉", lastTexts.slice(-1).every(function (t) { return t.indexOf("[语音:") < 0; }), JSON.stringify(lastTexts.slice(-1)));

ob.close();
await srv.close();
console.log("");
console.log("=== 汇总 ===");
const failed = checks.filter(function (c) { return !c.pass; });
console.log("  通过 " + (checks.length - failed.length) + " / " + checks.length);
console.log("  识图 " + rt.stats().visionCalls + " 次（成 " + rt.stats().visionOk + " / 败 " + rt.stats().visionFail + "），语音 " + rt.stats().voiceSent + " 条");
process.exitCode = failed.length ? 1 : 0;
