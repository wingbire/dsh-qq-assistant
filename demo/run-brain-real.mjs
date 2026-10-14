// 真实大脑通道验证（P0 验收）：工作区内 DSH_HOME + profile 人设 patch + 真实模型调用。
// 判据：ok=true、正文非空、usage 被解析、且模型能答出人设里的名字（证明人设确实进了 system prompt）。
import { resolveDshCli, ensureBrainProfile, runBrain, cacheHitRate, PROFILE_DEFAULT, DEPTH_POLICY_DEFAULT } from "../app/src/brain.js";
import { pickApiKey, maskKey, importApiKeyFromDshHome } from "../app/src/secrets.js";
import { DSH_HOME, DATA_ROOT } from "../app/src/paths.js";
import { DEFAULT_PERSONA } from "../app/src/dshprofile.js";

const cli = resolveDshCli();
console.log("=== 环境 ===");
console.log("  DSH 启动器 : " + (cli || "未找到"));
console.log("  DSH_HOME   : " + DSH_HOME);
console.log("  数据根     : " + DATA_ROOT);
console.log("  profile    : " + PROFILE_DEFAULT);

let key = pickApiKey();
if (!key) {
  console.log("  密钥       : 工作区没有，尝试从既有 DSH 凭据导入一次…");
  const imp = importApiKeyFromDshHome();
  console.log("  导入结果   : " + JSON.stringify(imp));
  key = pickApiKey();
}
console.log("  密钥       : " + (key ? maskKey(key) : "缺失 —— 请写入 app/dsh-data/config/secrets.json 的 deepseekApiKey"));

console.log("");
console.log("=== 装配 profile（工作区内，零写入 ~/.dsh）===");
const boot = ensureBrainProfile({ cliPath: cli, persona: DEFAULT_PERSONA });
console.log("  " + JSON.stringify({ ok: boot.ok, created: boot.created, patch: boot.patch, error: boot.error || null }));

// 连打两次：第一次冷启动写入前缀缓存，第二次应命中——这是「人设常驻 personaPrefix」的经济学证明。
const asks = ["你叫什么名字？只回答名字，不要解释。", "再说一次你叫什么名字？只回答名字。"];
console.log("");
console.log("=== 真实调用（连打两次，看前缀缓存）===");
let last = null, personaHit = false;
for (let i = 0; i < asks.length; i++) {
  const r = await runBrain({ cliPath: cli, promptText: asks[i], timeoutMs: 180000 });
  last = r;
  if (r.text && r.text.includes("小肥鱼")) personaHit = true;
  console.log("  #" + (i + 1) + " ok=" + r.ok + " steps=" + r.steps + (r.error ? " error=" + String(r.error).slice(0, 200) : ""));
  console.log("     正文=" + JSON.stringify(r.text));
  console.log("     usage=" + JSON.stringify(r.usage) + "  命中率=" + (cacheHitRate(r.usage) * 100).toFixed(1) + "%");
}
console.log("");
console.log("=== 判定 ===");
console.log("  通道可用   : " + (last && last.ok ? "是" : "否"));
console.log("  人设生效   : " + (personaHit ? "是（模型答出了人设里的名字）" : "否（正文里没出现人设名）"));
process.exitCode = last && last.ok && personaHit ? 0 : 1;
