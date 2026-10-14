// 把既有 DSH 凭据（~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY）导入本工作区一次。
// 只读 ~/.dsh，绝不写入；明文只落 app/dsh-data/config/secrets.json（gitignored）。
// 轮换密钥后：更新 ~/.dsh 里那把 → node demo/import-key.mjs --force
import { importApiKeyFromDshHome, maskKey, pickApiKey } from "../app/src/secrets.js";

const force = process.argv.includes("--force");
const cur = pickApiKey();
if (cur && !force) {
  console.log("工作区已有密钥 " + maskKey(cur) + "；要覆盖请加 --force");
  process.exit(0);
}
const r = importApiKeyFromDshHome();
console.log(JSON.stringify(r));
process.exitCode = r.ok ? 0 : 1;
