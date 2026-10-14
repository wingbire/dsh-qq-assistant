import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// 程序目录 = 本文件所在目录的上一层（即 <工作区>/app）。
// 用模块位置推导而不是 process.cwd()，这样无论从哪个目录启动，
// 运行期数据都稳定落在 <工作区>/app/dsh-data（对齐 存储契约.md §一）。
// 覆盖方式：DSHQQ_ROOT 指向程序目录。
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = process.env.DSHQQ_ROOT ? path.resolve(process.env.DSHQQ_ROOT) : path.resolve(HERE, "..");
export const WORKSPACE_ROOT = path.resolve(APP_ROOT, "..");

export const DATA_ROOT = path.join(APP_ROOT, "dsh-data");
export const CONFIG_DIR = path.join(DATA_ROOT, "config");
export const CONFIG_FILE = path.join(CONFIG_DIR, "app.json");
export const SECRETS_FILE = path.join(CONFIG_DIR, "secrets.json");
export const FEED_DIR = path.join(DATA_ROOT, "feed");
export const BRAIN_TMP_DIR = path.join(DATA_ROOT, "brain");
export const BACKUP_DIR = path.join(DATA_ROOT, "backup");

// N1 决策：大脑通道的 DSH_HOME 落在工作区内，零写入 ~/.dsh。
// 覆盖方式：DSHQQ_DSH_HOME。
export const DSH_HOME = process.env.DSHQQ_DSH_HOME
  ? path.resolve(process.env.DSHQQ_DSH_HOME)
  : path.join(APP_ROOT, "dsh-home");
export const PROFILES_DIR = path.join(DSH_HOME, "profiles");

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
