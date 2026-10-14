// P6：分发版打包（N27 决策 + §12 要求）
// 白名单打包 —— 只复制明确列出的东西，其余一律不进包。
// 硬要求：不含任何密钥、不含图库素材（dsh-meme 内置包 license=personal 不可再分发）、
//        不含开发者私有资料、不含运行期数据。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const VERSION = "3.0.0";
export const PKG_NAME = "DSHQQ-Assistant-" + VERSION;

// 白名单：{ 源（相对工作区）, 目标（相对包目录，默认同源） }
export const WHITELIST = [
  { from: "app/main.js" },
  { from: "app/src" },
  { from: "prompts" },
  { from: "launcher" },
  { from: "dsh-preset" },
  { from: "test/run-tests.mjs" },
  { from: "demo/mock-dsh-cli.mjs" },
  { from: "demo/run-onebot-mock.mjs" },
  { from: "demo/run-learning-demo.mjs" },
  { from: "demo/run-meme-demo.mjs" },
  { from: "demo/run-voice-vision-demo.mjs" },
  { from: "demo/run-brain-mock.mjs" },
  { from: "demo/run-acceptance.mjs" },
  { from: "demo/import-key.mjs" },
  { from: "README.md" },
  { from: "LICENSE" },
  { from: "docs/INSTALL.md", to: "INSTALL.md" },
  { from: "docs/PRIVACY.md", to: "隐私说明.md" },
  { from: "docs/ARCHITECTURE.md" },
  { from: "docs/DESIGN.md" },
  { from: "docs/ROADMAP.md" },
  { from: "dist/首次运行.txt", to: "首次运行.txt" }
];

// 两类闸门：
//   ① 路径闸门 —— 这些**东西本身**不许进包（不是「提到它的文字」）
//   ② 内容闸门 —— 只认真正的密钥形状（sk- + 长串），文档里提到"密钥"两个字不算
export const FORBIDDEN_PATH = [
  { re: /(^|\/)secrets\.json$/i, why: "凭据文件" },
  { re: /算法复原包/, why: "开发者私史（史料）" },
  { re: /(^|\/)(交接|残留清理|设计节点|新工作区)/, why: "内部交接/运维笔记" },
  { re: /dafeiyu/i, why: "dsh-meme 内置图库素材（license=personal，不可再分发）" },
  { re: /(^|\/)dsh-data\//, why: "运行期数据" },
  { re: /(^|\/)dsh-home\//, why: "大脑 profile 运行期状态" },
  { re: /(^|\/)\.git\//, why: "版本库" },
  { re: /node_modules\//, why: "依赖目录" }
];
export const FORBIDDEN_CONTENT = [
  { re: /sk-[A-Za-z0-9]{16,}/, why: "疑似真实 API key" },
  { re: /DEEPSEEK_API_KEY\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/, why: "疑似写死的密钥" }
];

const SKIP_DIRS = new Set([".git", "app\\dsh-data", "app\\dsh-home", "node_modules", "dist"]);

function walk(dir, base, out) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names) {
    const abs = path.join(dir, n);
    const rel = base ? base + "/" + n : n;
    if (SKIP_DIRS.has(n)) continue;
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    if (st.isDirectory()) walk(abs, rel, out);
    else out.push({ abs: abs, rel: rel, size: st.size });
  }
  return out;
}

export function plan() {
  const files = [];
  for (const w of WHITELIST) {
    const abs = path.join(ROOT, w.from);
    const to = w.to || w.from;
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      const bag = [];
      walk(abs, "", bag);
      for (const f of bag) files.push({ src: f.abs, rel: to + "/" + f.rel, size: f.size });
    } else {
      files.push({ src: abs, rel: to, size: st.size });
    }
  }
  return files;
}

export function audit(files, reader) {
  const problems = [];
  for (const f of files) {
    const rel = String(f.rel || "").replace(/\\/g, "/");
    for (const rule of FORBIDDEN_PATH) if (rule.re.test(rel)) problems.push({ file: rel, why: rule.why });
    if (/\.(exe|dll|png|jpg|jpeg|gif|webp|zstd|db|ico)$/i.test(rel)) continue;
    let text = "";
    try { text = (reader || fs.readFileSync)(f.src, "utf8"); } catch (e) { continue; }
    for (const rule of FORBIDDEN_CONTENT) if (rule.re.test(text)) problems.push({ file: rel, why: rule.why });
  }
  return problems;
}

export function build() {
  const outDir = path.join(ROOT, "dist", PKG_NAME);
  fs.rmSync(outDir, { recursive: true, force: true });
  const files = plan();
  const problems = audit(files);
  if (problems.length) {
    return { ok: false, outDir: outDir, files: files.length, problems: problems };
  }
  for (const f of files) {
    const dst = path.join(outDir, f.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f.src, dst);
  }
  return { ok: true, outDir: outDir, files: files.length, bytes: files.reduce(function (a, b) { return a + b.size; }, 0), problems: [] };
}

export function auditDir(dir) {
  const bag = [];
  walk(dir, "", bag);
  return audit(bag.map(function (f) { return { src: f.abs, rel: f.rel }; }));
}

if (process.argv[1] && process.argv[1].endsWith("build-package.mjs")) {
  const res = build();
  console.log("=== 分发版打包 ===");
  console.log("  输出：" + res.outDir);
  console.log("  文件：" + res.files + " 个，原大小 " + Math.round((res.bytes || 0) / 1024) + " KB");
  if (!res.ok) {
    console.log("  ✗ 打包被拦下，命中黑名单：");
    for (const p of res.problems) console.log("    - " + p.file + "  ←  " + p.why);
    process.exit(1);
  }
  const after = auditDir(res.outDir);
  console.log("  成品复查：命中黑名单 " + after.length + " 处" + (after.length ? "（不合格）" : "（干净）"));
  process.exit(after.length ? 1 : 0);
}
