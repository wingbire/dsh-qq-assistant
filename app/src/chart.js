import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// archify 只产出**独立 HTML**（内联 SVG，可交互），不产图。
// 所以"把图表发进群"这件事要程序自己补一步：HTML → PNG（无头 Edge/Chrome 截图）。
// 找不到浏览器就如实失败，不假装成功。

export const CHART_DEFAULTS = { width: 1600, height: 1000, scale: 2, timeoutMs: 60000 };

export function browserCandidates(env) {
  const e = env || process.env;
  const pf = e.ProgramFiles || "C:\\Program Files";
  const pf86 = e["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const lad = e.LOCALAPPDATA || "";
  return [
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    lad ? path.join(lad, "Google", "Chrome", "Application", "chrome.exe") : "",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
}

export function findBrowser(env) {
  for (const c of browserCandidates(env)) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

export function fileUrl(p) {
  const abs = path.resolve(p).replace(/\\/g, "/");
  return "file:///" + (abs.startsWith("/") ? abs.slice(1) : abs);
}

// HTML → PNG。同步实现（画图是低频动作，不值得为它把调用链改成异步）
export function htmlToPng(htmlPath, opts) {
  const o = opts || {};
  const src = path.resolve(htmlPath);
  if (!fs.existsSync(src)) return { ok: false, error: "找不到 HTML：" + src };
  const browser = o.browser || findBrowser(o.env);
  if (!browser) return { ok: false, error: "没找到 Edge/Chrome，无法把 HTML 转成图片" };
  const outDir = o.outDir || path.dirname(src);
  fs.mkdirSync(outDir, { recursive: true });
  const png = o.outFile || path.join(outDir, path.basename(src, path.extname(src)) + ".png");
  try { if (fs.existsSync(png)) fs.unlinkSync(png); } catch (e) {}

  const opts2 = [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--force-device-scale-factor=" + (o.scale || CHART_DEFAULTS.scale),
    "--window-size=" + (o.width || CHART_DEFAULTS.width) + "," + (o.height || CHART_DEFAULTS.height),
    "--screenshot=" + png,
    fileUrl(src)
  ];
  const r = spawnSync(browser, opts2, { encoding: "utf8", windowsHide: true, timeout: o.timeoutMs || CHART_DEFAULTS.timeoutMs });
  if (!fs.existsSync(png)) {
    return { ok: false, error: "截图失败：" + String((r && (r.stderr || r.error && r.error.message)) || "没出文件").slice(0, 200) };
  }
  let bytes = 0;
  try { bytes = fs.statSync(png).size; } catch (e) {}
  if (bytes < 2000) return { ok: false, error: "截出来的图太小（" + bytes + " 字节），可能是空白页" };
  return { ok: true, file: png, bytes: bytes, browser: path.basename(browser) };
}

// 把大脑给的图表标记解析成"可以发出去的图片"
//  - .png/.jpg 直接就是图
//  - .html 先转 PNG
export function resolveChartFile(target, opts) {
  const o = opts || {};
  const p = path.isAbsolute(target) ? target : path.resolve(o.root || process.cwd(), target);
  if (!fs.existsSync(p)) return { ok: false, error: "图表文件不存在：" + target, source: p };
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".gif") {
    return { ok: true, file: p, converted: false };
  }
  if (ext === ".html" || ext === ".htm") {
    const r = htmlToPng(p, o);
    if (!r.ok) return { ok: false, error: r.error, source: p, needsBrowser: true };
    return { ok: true, file: r.file, converted: true, source: p };
  }
  return { ok: false, error: "不认识的图表格式：" + ext, source: p };
}

// 发完清理：删图片；如果它旁边还有 archify 的工程目录（.archify/<...>/），一并收走
export function cleanupChart(pngPath, opts) {
  const o = opts || {};
  const out = { removed: [], kept: [] };
  const tryRm = function (p) {
    try { fs.unlinkSync(p); out.removed.push(p); return true; } catch (e) { out.kept.push(p); return false; }
  };
  const tryRmDir = function (p) {
    try { fs.rmSync(p, { recursive: true, force: true }); out.removed.push(p); return true; } catch (e) { out.kept.push(p); return false; }
  };
  if (fs.existsSync(pngPath)) tryRm(pngPath);

  // 原始产物（大脑给的那个文件）：同目录的 .html，以及它的 .archify/<...>/ 工程目录
  const source = o.source ? path.resolve(o.source) : null;
  if (source && source !== path.resolve(pngPath) && fs.existsSync(source)) tryRm(source);
  const anchor = source ? path.dirname(source) : path.dirname(pngPath);
  const sibling = path.join(anchor, path.basename(anchor) + ".html");
  if (!source && fs.existsSync(sibling)) tryRm(sibling);
  // 再往上看看是不是 .archify/<type>-<slug>-<时间戳>/ 这种工程目录
  const parent = path.dirname(anchor);
  if (path.basename(parent).toLowerCase() === ".archify" && o.cleanProjectDir !== false) {
    tryRmDir(anchor);
  }
  return out;
}
