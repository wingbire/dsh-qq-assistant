import path from "node:path";
import { fileURLToPath } from "node:url";
import fsx from "node:fs";
import { depthPolicy, buildPersonaText, buildTaskText, runBrain, cacheHitRate } from "../app/src/brain.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(HERE, "mock-dsh-cli.mjs");
// 优先用环境变量指定的 node（本地 DSH 运行时自带的那个），否则用当前这个
const CAND = [process.env.MOCK_NODE, process.execPath];
let EXE = process.execPath;
for (const c of CAND) {
  if (!c) continue;
  try { if (fsx.statSync(c).isFile()) { EXE = c; break; } } catch (e) {}
}
const PERSONA = { botName: "小肥鱼", age: "二十来岁", traits: ["嘴贫但有分寸", "对熟的人话多", "被问到就认真"], interests: ["单机游戏", "做视频"], dislikes: ["政治", "催更"] };
const CFG = { contextWindow: 20 };

console.log("=== 三档策略（模型 / 推理档 / 搜索 / 字数 / 上下文窗口）===");
for (const d of ["low", "mid", "high"]) {
  const p = depthPolicy(d, CFG);
  console.log("  " + d.padEnd(5) + " 调大脑=" + String(p.callBrain).padEnd(6) + " 模型=" + p.model.padEnd(16) + " 推理=" + p.reasoningEffort.padEnd(5) + " 搜索=" + p.search + " 字数≤" + String(p.maxChars).padEnd(4) + " 窗口=" + p.contextWindow);
}

console.log("");
console.log("=== 人设文本（首 6 行）===");
const personaText = buildPersonaText(PERSONA, CFG);
for (const l of personaText.split(String.fromCharCode(10)).slice(0, 6)) console.log("  " + l);
console.log("  …共 " + personaText.length + " 字符");

console.log("");
console.log("=== 走 mock CLI 跑两档（验证事件解析 / usage 累加 / 命中率）===");
for (const depth of ["mid", "high"]) {
  const p = depthPolicy(depth, CFG);
  const taskText = buildTaskText(depth, p, depth === "high" ? ["报错", "路径", "配置"] : []);
  const full = personaText + String.fromCharCode(10, 10) + taskText;
  const r = await runBrain({
    depth: depth, promptText: full, timeoutMs: 15000,
    overrideLaunch: { exe: EXE, cliJs: MOCK, installRoot: HERE, source: "mock" }
  });
  console.log("  [" + depth + "] ok=" + r.ok + (r.error ? " error=" + String(r.error).slice(0, 120) : "") + " steps=" + r.steps + " 文本=" + (r.text || "").slice(0, 40));
  console.log("        usage=" + JSON.stringify(r.usage) + "  命中率=" + (cacheHitRate(r.usage) * 100).toFixed(1) + "%");
}
