import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SECRETS_FILE, CONFIG_DIR, ensureDir } from "./paths.js";

// 工作区自持密钥：只读写 <项目>/app/dsh-data/config/secrets.json，不碰 ~/.dsh。
// 硬规则：
//   1) 密钥只落 <工作区>/app/dsh-data/config/secrets.json（已被 .gitignore 挡住）
//   2) 任何日志/返回值都不得出现明文密钥，只允许 maskKey() 的输出
//   3) 绝不写入 ~/.dsh

export function loadSecrets(file) {
  const p = file || SECRETS_FILE;
  try {
    if (!fs.existsSync(p)) return {};
    const v = JSON.parse(fs.readFileSync(p, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch (e) { return {}; }
}

export function saveSecrets(patch, file) {
  const p = file || SECRETS_FILE;
  const next = Object.assign({}, loadSecrets(p), patch || {});
  ensureDir(path.dirname(p));
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, p);
  return next;
}

export function maskKey(key) {
  if (!key) return null;
  const k = String(key);
  if (k.length <= 10) return "***";
  return k.slice(0, 6) + "..." + k.slice(-4);
}

// 优先级：工作区文件 > 进程环境变量。返回 null 表示没有可用密钥。
export function pickApiKey(env, file) {
  const e = env || process.env;
  const fromFile = loadSecrets(file).deepseekApiKey;
  if (fromFile && String(fromFile).trim()) return String(fromFile).trim();
  const fromEnv = e && e.DEEPSEEK_API_KEY;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return null;
}

// 从既有 DSH 凭据里取出 refs.DEEPSEEK_API_KEY —— 只读一次，用于迁移；
// 不复制文件、不改动 ~/.dsh。纯函数，便于测试。
export function parseRefsApiKey(yamlText, refName) {
  const name = refName || "DEEPSEEK_API_KEY";
  const lines = String(yamlText || "").split(String.fromCharCode(10));
  let inRefs = false;
  let refsIndent = -1;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (!inRefs) {
      if (/^refs\s*:/.test(body)) { inRefs = true; refsIndent = indent; }
      continue;
    }
    // refs 块内：缩进更深才算成员；回到同级或更浅说明块结束
    if (indent <= refsIndent) break;
    const m = body.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    if (m[1].trim() === name) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v || null;
    }
  }
  return null;
}

export function readDshHomeApiKey(dshHome) {
  const p = path.join(dshHome || path.join(os.homedir(), ".dsh"), ".credentials.yaml");
  let raw = "";
  try { raw = fs.readFileSync(p, "utf8"); } catch (e) { return null; }
  return parseRefsApiKey(raw, "DEEPSEEK_API_KEY");
}

// 迁移助手：把既有 DSH 凭据导入本工作区（一次性）。返回掩码后的信息，绝不返回明文。
export function importApiKeyFromDshHome(dshHome) {
  const key = readDshHomeApiKey(dshHome);
  if (!key) return { ok: false, error: "在 DSH 凭据里没找到 refs.DEEPSEEK_API_KEY" };
  saveSecrets({ deepseekApiKey: key, importedAt: new Date().toISOString() });
  return { ok: true, mask: maskKey(key), file: SECRETS_FILE };
}
