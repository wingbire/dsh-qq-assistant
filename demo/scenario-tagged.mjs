import { loadConfig, loadFieldTable, runtimeConfig } from "../app/src/config.js";
import { createGates } from "../app/src/gates.js";
import { isGreeting } from "../app/src/localreply.js";

// 复杂群聊情景：带标签的新输入（语音转写 / 引用原文 / 识图描述）+ 老毛病（指代不明、人称混用、灌水、转述）
const CASES = [
  { id: "T01", want: "brain",    text: "[语音] 转写：这个报错怎么解", traits: "语音转写=真问题·没点名" },
  { id: "T02", want: "short",    text: "[语音] 转写：小肥鱼在吗", traits: "语音转写=点名寒暄", atBot: false },
  { id: "T03", want: "brain",    text: "[引用 甲：这个报错怎么解] 对", traits: "引用原文带着真问题 → 一个字也能判" },
  { id: "T04", want: "short",    text: "[引用 甲：哈哈哈] 笑死", traits: "引用的是灌水 → 只配短答" },
  { id: "T05", want: "ignore",   text: "[语音]", traits: "语音但没转写（诚实说听不了）" },
  { id: "T06", want: "brain",    text: "[图片] 蓝发鲸鱼女仆，白围裙上有小鲸图案 [语音转写：这是谁啊]", traits: "图文语音混合+提问" },
  { id: "T07", want: "short",    text: "他昨天说的那个方案你觉得行不行", traits: "指代不明·无点名" },
  { id: "T08", want: "short",    text: "你俩别吵了，说点别的", traits: "劝架·复数你" },
  { id: "T09", want: "short",    text: "他妈的这游戏怎么又崩了", traits: "情绪宣泄" },
  { id: "T10", want: "brain",    text: "小肥鱼 这个报错的原因是什么，帮我看看", traits: "点名+求详" },
  { id: "T11", want: "ignore",   text: "?", traits: "单符号灌水" },
  { id: "T12", want: "brain",    text: "他说你会写代码，能帮我写个脚本吗", traits: "转述里求它帮忙" },
  { id: "T13", want: "short",    text: "哈哈哈哈哈哈", traits: "纯灌水" },
  { id: "T14", want: "brain",    text: "那按你的意思再试一次？", traits: "上下文延续", lastBotText: "先改 3001 再试", lastBotAt: 1, now: 30000 },
  { id: "T15", want: "short",    text: "不是说你，别插嘴", traits: "否定" },
  { id: "T16", want: "brain",    text: "谁有那个插件的下载地址", traits: "无点名求助" }
];

const cfg = loadConfig({ table: loadFieldTable() });
const rc = runtimeConfig(cfg);
const base = { bounds: rc.gates.bounds, tiers: rc.gates.tiers, utilityWeights: rc.gates.weights, rescueAsk: rc.gates.rescueAsk, blockInjected: rc.gates.blockInjected, audit: rc.audit };
const ACT = { ignore: "不回", local_short: "本地短答", short: "本地短答", brain: "过大脑" };
const rows = [];
let hit = 0;
for (const c of CASES) {
  const evt = { gid: "100000001", uid: "10000", now: c.now || 0, text: c.text, atBot: !!c.atBot, botNames: ["小肥鱼"], nicknames: [], lastBotText: c.lastBotText, lastBotAt: c.lastBotAt };
  const d = await createGates(Object.assign({}, base, { auditFn: async function () { return { verdict: "unsure", error: "本机外审不可用（占位）" }; } })).decide(Object.assign({}, evt), {});
  const wantAct = c.want === "short" ? "local_short" : c.want;
  const ok = d.action === wantAct;
  if (ok) hit += 1;
  rows.push({ id: c.id, want: ACT[c.want], got: ACT[d.action] || String(d.action || "?"), ok: ok, tier: d.tier || "-", pSay: Number(d.pSay) || 0, U: d.U, why: (d.reason || []).slice(-2).join(" / "), traits: c.traits });
}
console.log("id   | 预估        | 实际        | 一致 | tier | pSay | U     | 依据（后两条）");
console.log("-----|-------------|-------------|------|------|------|-------|----------------");
for (const r of rows) {
  console.log([r.id.padEnd(4), "| " + r.want.padEnd(11), "| " + r.got.padEnd(11), "| " + (r.ok ? "✓" : "✗").padEnd(4), "| " + String(r.tier).padEnd(4), "| " + r.pSay.toFixed(2), "| " + String(r.U).padEnd(5), "| " + r.why].join(" "));
}
console.log("");
console.log("一致率：" + hit + "/" + CASES.length + "（" + Math.round(hit / CASES.length * 100) + "%）");
const dist = {};
for (const r of rows) { const k = r.got; dist[k] = (dist[k] || 0) + 1; }
console.log("动作分布：" + JSON.stringify(dist));
const bad = rows.filter(function (r) { return !r.ok; });
console.log(bad.length ? ("不一致：" + bad.map(function (r) { return r.id + " 预估" + r.want + "实际" + r.got + "（" + r.traits + "）"; }).join("；")) : "全部符合预估 ✓");
console.log("全部都有明确动作（无 grey 悬空）：" + (rows.every(function (r) { return r.got === "不回" || r.got === "本地短答" || r.got === "过大脑"; }) ? "是" : "否"));
