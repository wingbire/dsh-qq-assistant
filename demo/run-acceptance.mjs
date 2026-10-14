// P6 全量验收：把该跑的都跑一遍，最后给一张记分卡。
// 默认只跑「快、不花 API 额度」的那些；加 --real 才跑真实模型调用。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REAL = process.argv.includes("--real");

function run(label, args, expect) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 300000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(expect.re);
  const ok = r.status === 0 && (!expect.re || !!m);
  return { label: label, ok: ok, code: r.status, detail: m ? m[0].trim().slice(0, 80) : (expect.re ? "没匹配到 " + expect.re : (out.trim().split(String.fromCharCode(10)).pop() || "").slice(0, 80)) };
}

const plan = [
  { label: "骨架回归测试", args: ["test/run-tests.mjs"], expect: { re: /通过 \d+ 项，失败 0 项/ } },
  { label: "判定中枢演示", args: ["demo/run-demo.mjs"], expect: { re: /判决分布：\{[^}]*\}/ } },
  { label: "大脑通道（mock CLI）", args: ["demo/run-brain-mock.mjs"], expect: { re: /\[high\] ok=true/ } },
  { label: "接入端到端（mock OneBot）", args: ["demo/run-onebot-mock.mjs"], expect: { re: /通过 \d+ \/ \d+/ } },
  { label: "学习闭环演示", args: ["demo/run-learning-demo.mjs"], expect: { re: /通过 \d+ \/ \d+/ } },
  { label: "图库 / 指令 / 主动搭话", args: ["demo/run-meme-demo.mjs"], expect: { re: /通过 \d+ \/ \d+/ } },
  { label: "识图 / 语音（真 TTS）", args: ["demo/run-voice-vision-demo.mjs"], expect: { re: /通过 \d+ \/ \d+/ } },
  { label: "程序自检（含配置端）", args: ["app/main.js", "--selftest"], expect: { re: /配置端自检：http:\/\/127\.0\.0\.1:\d+  \/api\/status ok=true/ } }
];
if (REAL) {
  plan.push({ label: "真实大脑链路（会花额度）", args: ["demo/run-brain-real.mjs"], expect: { re: /人设生效   : 是/ } });
  plan.push({ label: "真实外审通道（会花额度）", args: ["demo/run-audit-real.mjs"], expect: { re: /一致 \d+ \/ \d+/ } });
}

console.log("=== 全量验收 ===" + (REAL ? "（含真实调用）" : "（快速档，不含真实调用）"));
const rows = [];
for (const p of plan) {
  const r = run(p.label, p.args, p.expect);
  rows.push(r);
  console.log((r.ok ? "PASS " : "FAIL ") + r.label.padEnd(24) + "  " + r.detail);
}
const failed = rows.filter(function (r) { return !r.ok; });
console.log("");
console.log("=== 记分卡 ===");
console.log("  通过 " + (rows.length - failed.length) + " / " + rows.length);
for (const f of failed) console.log("  ✗ " + f.label + "（exit " + f.code + "）");
process.exitCode = failed.length ? 1 : 0;
