// P2 验收：真实外审通道（qq-audit profile + rubric + 8s 超时 → 不确定）
import { createAuditor, loadRubric, AUDIT_PROFILE_ID, AUDIT_TIMEOUT_MS } from "../app/src/audit.js";
import { runBrain, ensureBrainProfile, resolveDshCli } from "../app/src/brain.js";
import { DSH_HOME } from "../app/src/paths.js";
import { pickApiKey, maskKey } from "../app/src/secrets.js";

const cli = resolveDshCli();
const key = pickApiKey();
console.log("=== 环境 ===");
console.log("  DSH 启动器: " + (cli || "未找到"));
console.log("  DSH_HOME  : " + DSH_HOME);
console.log("  密钥      : " + (key ? maskKey(key) : "缺失"));

const rubric = loadRubric();
const boot = ensureBrainProfile({ cliPath: cli, profile: AUDIT_PROFILE_ID, personaText: rubric });
console.log("  外审 profile: " + JSON.stringify({ ok: boot.ok, created: boot.created, patch: boot.patch, error: boot.error || null }));

const auditor = createAuditor({
  timeoutMs: AUDIT_TIMEOUT_MS,
  rubric: rubric,
  runner: async function (req) {
    if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
    return runBrain({ cliPath: cli, profile: req.profile, promptText: req.promptText, timeoutMs: req.timeoutMs });
  }
});

const cases = [
  { text: "小肥鱼 这个报错怎么解", expect: "yes" },
  { text: "他说这个副本要打三遍才行，他说他会带我们", expect: "no" },
  { text: "嗯", expect: "no" }
];

console.log("");
console.log("=== 外审实测 ===");
let hits = 0;
for (const c of cases) {
  const r = await auditor(c.text, { botNames: ["小肥鱼"], nicknames: ["肥鱼"] });
  const okMatch = r.verdict === c.expect;
  if (okMatch) hits += 1;
  console.log("  [" + (okMatch ? "符合" : "不符") + "] 期望 " + c.expect + " 实得 " + r.verdict + "  " + r.ms + "ms  raw=" + JSON.stringify(r.raw || null) + "  消息=" + JSON.stringify(c.text.slice(0, 24)));
}
console.log("");
console.log("=== 汇总 ===");
console.log("  一致 " + hits + " / " + cases.length + "（外审是模型判定，个别不一致属正常，主要用于灰区联合）");
process.exitCode = 0;
