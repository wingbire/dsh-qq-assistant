// 图表管线演示：大脑给 [图表: xxx.html] → 程序转 PNG → 发进群 → 清理本地
// 自包含：自己造一个小 HTML（不依赖 archify 是否安装），走真实 WebSocket 与真实无头浏览器。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMockOneBotServer } from "../app/src/mock-onebot-server.js";
import { createOneBot } from "../app/src/onebot.js";
import { createRuntime } from "../app/src/runtime.js";
import { createStore } from "../app/src/store.js";
import { findBrowser, resolveChartFile } from "../app/src/chart.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA = path.join(ROOT, "app", "dsh-data", "chart-demo");
fs.rmSync(DATA, { recursive: true, force: true });

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass });
  console.log((pass ? "PASS " : "FAIL ") + name + (detail != null ? "  :: " + detail : ""));
}

const GID = "123456789";
const srv = createMockOneBotServer({ token: "", selfId: 999 });
const port = await srv.listen(0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function drive(rt, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { await rt.tick(); await wait(60); } }

// --- 0) 先看有没有无头浏览器（没有就跳过截图部分，如实报） ---
const browser = findBrowser();
console.log("=== 环境 ===");
console.log("  无头浏览器: " + (browser || "（没找到，本演示会跳过）"));
if (!browser) {
  console.log("  找不到 Edge/Chrome，无法把 HTML 转成图片。装一个再跑。");
  await srv.close();
  process.exit(0);
}

// --- 1) 造一份 archify 风格的产物：.archify/<type>-<slug>-<ts>/xxx.html ---
const projDir = path.join(DATA, ".archify", "architecture-demo-20261014");
fs.mkdirSync(projDir, { recursive: true });
const html = path.join(projDir, "architecture.html");
const page = '<html><body style="margin:0;background:linear-gradient(135deg,#2f7ff0,#12a37a)">' +
  '<div style="padding:70px;font:700 54px sans-serif;color:#fff">DSH-QQ 群小助手 · 图表管线</div>' +
  '<div style="padding:0 70px;font:400 26px sans-serif;color:#eaf4ff">HTML → PNG → 发送 → 清理</div></body></html>';
fs.writeFileSync(html, page, "utf8");
console.log("");
console.log("=== ① 直接调 chart 模块：HTML → PNG ===");
const conv = resolveChartFile(html, { outDir: path.join(DATA, "charts") });
const convSize = conv.ok ? fs.statSync(conv.file).size : 0;
check("HTML 能转成 PNG", conv.ok && conv.converted, conv.ok ? (Math.round(convSize / 1024) + " KB") : conv.error);
if (!conv.ok) { await srv.close(); process.exit(1); }
const sig = fs.readFileSync(conv.file).slice(0, 4).toString("binary");
check("产物是真的 PNG", sig === "\x89PNG", "magic=" + JSON.stringify(sig));

// --- 2) 走完整链路：大脑给标记 → 运行时转换 → 发图 → 清理 ---
console.log("");
console.log("=== ② 走完整链路（真 WebSocket）===");
const link = { ob: null };
const store = createStore(path.join(DATA, "data"));
const rt = createRuntime({
  config: { observe: false, coalesceWindowMs: 50 },
  runtime: { observe: false, coalesceWindowMs: 50, plugins: { archify: true, archifyCleanup: true } },
  store: store,
  bot: {
    handleEvent: async () => ({ verdict: "yes", pSay: 0.95, tier: "mid", action: "brain", bucket: "mid", reason: ["要画图"] }),
    interests: () => ({}), persona: () => "", profilePrompt: () => "", learn: () => null,
    observe: () => ({ refit: false }), meme: { ready: false }, proactive: { markBotReply: () => {} }
  },
  askBrain: async () => ({ ok: true, text: "画好了 [图表: " + html + "]", usage: { inputTokens: 900, outputTokens: 30 } }),
  send: (g, t) => link.ob.sendGroupMsg(g, t),
  sendImage: (g, f) => link.ob.sendGroupImage(g, f),
  now: () => Date.now(), sleep: async () => {}, sendGapMs: 0
});
const ob = createOneBot({ url: "ws://127.0.0.1:" + port, token: "", reconnectMs: 999999, onEvent: (e) => rt.onEvent(e) });
link.ob = ob;
ob.connect();
await wait(400);
check("接上 mock OneBot", ob.state() === "open", "state=" + ob.state());

srv.groupMessage({ group_id: GID, user_id: 2001, nickname: "甲", segments: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "小肥鱼 画个架构图" } }] });
await drive(rt, 25000);

const msgs = srv.received.filter((r) => r && r.action === "send_group_msg");
const imgs = msgs.filter((r) => Array.isArray(r.params.message) && r.params.message[0] && r.params.message[0].type === "image");
const txts = msgs.filter((r) => typeof r.params.message === "string");
check("发出去了一个图片段", imgs.length === 1, "段数=" + imgs.length);
const sentPath = imgs.length ? String(imgs[0].params.message[0].data.file || "").replace(/^file:\/\//, "") : "";
check("发的确实是 PNG", sentPath.toLowerCase().endsWith(".png"), sentPath.replace(ROOT, "."));
check("正文里的 [图表:] 标记被摘掉", txts.length > 0 && txts.every((t) => String(t.params.message).indexOf("[图表") < 0), JSON.stringify(txts.map((t) => t.params.message)));
check("发完把图删了（不留本地）", sentPath && !fs.existsSync(sentPath), "还在吗=" + fs.existsSync(sentPath));
check("源 HTML 也清掉了", !fs.existsSync(html));
check("archify 工程目录也收走了", !fs.existsSync(projDir));
check("统计记到了", rt.stats().chartsSent === 1 && rt.stats().chartsFailed === 0, JSON.stringify({ ok: rt.stats().chartsSent, fail: rt.stats().chartsFailed }));
const obs = store.readJsonl(store.paths.observe).filter((r) => r.kind === "sent");
const lastChart = obs.length ? obs[obs.length - 1].chart : null;
check("observe 里记了 chart 字段", !!(lastChart && lastChart.converted), JSON.stringify(lastChart));

// --- 3) 关掉开关就不该发 ---
// 注意：mock 服务器是**广播**给所有连接的，所以第二个 runtime 起来之前必须把第一个客户端关掉，
// 否则两个 runtime 都会收到这条消息（这个坑我当场踩了一次）
console.log("");
console.log("=== ③ 关掉 archify 开关后不该再发图 ===");
ob.close();
await wait(300);
const cntBefore = srv.received.filter((r) => r && r.action === "send_group_msg" && Array.isArray(r.params.message) && r.params.message[0] && r.params.message[0].type === "image").length;
const html2 = path.join(DATA, "off.html");
fs.writeFileSync(html2, page, "utf8");
const rt2 = createRuntime({
  config: { observe: false, coalesceWindowMs: 50 },
  runtime: { observe: false, coalesceWindowMs: 50, plugins: { archify: false, archifyCleanup: true } }, store: store,
  bot: { handleEvent: async () => ({ verdict: "yes", pSay: 0.95, tier: "mid", action: "brain", bucket: "mid", reason: ["x"] }), interests: () => ({}), persona: () => "", profilePrompt: () => "", learn: () => null, observe: () => ({ refit: false }), meme: { ready: false }, proactive: { markBotReply: () => {} } },
  askBrain: async () => ({ ok: true, text: "喏 [图表: " + html2 + "]", usage: { inputTokens: 100, outputTokens: 10 } }),
  send: (g, t) => link.ob.sendGroupMsg(g, t), sendImage: (g, f) => link.ob.sendGroupImage(g, f),
  now: () => Date.now(), sleep: async () => {}, sendGapMs: 0
});
const ob2 = createOneBot({ url: "ws://127.0.0.1:" + port, token: "", reconnectMs: 999999, onEvent: (e) => rt2.onEvent(e) });
link.ob = ob2;
ob2.connect();
await wait(400);
srv.groupMessage({ group_id: GID, user_id: 2001, nickname: "甲", segments: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "再画一张" } }] });
await drive(rt2, 3000);
const cntAfter = srv.received.filter((r) => r && r.action === "send_group_msg" && Array.isArray(r.params.message) && r.params.message[0] && r.params.message[0].type === "image").length;
check("开关关掉就不发图", cntAfter === cntBefore, "图片段 " + cntBefore + " -> " + cntAfter);
check("关掉后本地文件不被删（不是我们发的就不动）", fs.existsSync(html2));

ob2.close();
await srv.close();

const pass = checks.filter((c) => c.pass).length;
console.log("");
console.log("=== 汇总 ===");
console.log("  通过 " + pass + " / " + checks.length);
process.exit(pass === checks.length ? 0 : 1);
