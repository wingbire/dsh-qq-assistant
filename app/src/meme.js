import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

// node:sqlite 是内置模块，但 ESM 里同步拿到它要用 createRequire
const _require = createRequire(import.meta.url);
let _DatabaseSync = null;
try { _DatabaseSync = _require("node:sqlite").DatabaseSync; } catch (e) { _DatabaseSync = null; }

// N15 决策：直接用 dsh-meme 插件的图库。
// 图库结构（实测）：
//   <pack>/manifest.json          包信息（id/name/version/description/tags/license）
//   <pack>/index.db               SQLite：memes(path, tag, file_name, file_hash, caption, keywords, mtime, captioned_at)
//   <pack>/memes/<tag>/<name>.jpg
// 优先读 index.db（有 caption 与 keywords，匹配准）；读不到就退回按目录名扫。
export const MEME_DEFAULTS = { maxPerMessage: 1, replyGapReplies: 3 };

// 找图库：显式路径 > dsh-expression.json 里选的包 > 本机各 profile 里 dsh-meme 内置包
export function resolveMemeRoots(env, dshHome) {
  const e = env || process.env;
  const out = [];
  if (e.DSHQQ_MEME_ROOT) out.push(e.DSHQQ_MEME_ROOT);
  const home = path.join(os.homedir(), ".dsh");
  const exprFile = path.join(home, "dsh-expression.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(exprFile, "utf8"));
    for (const k of ["memeRoot", "root", "libraryPath", "current"]) {
      if (typeof cfg[k] === "string" && cfg[k]) out.push(cfg[k]);
    }
  } catch (err) {}
  out.push(path.join(home, "meme-packs"));        // 用户自己加的图库（~/dsh/meme-packs/<包名>/）
  const profileRoots = [path.join(home, "profiles")];
  if (dshHome) profileRoots.push(path.join(path.resolve(dshHome), "profiles"));
  for (const root of profileRoots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (err) { continue; }
    for (const n of names) out.push(path.join(root, n, "node_modules", "dsh-meme", "memes"));
  }
  // 校验：必须含 manifest.json 或 index.db
  const packs = [];
  for (const raw of out) {
    if (!raw) continue;
    try {
      if (!fs.existsSync(raw)) continue;
      if (fs.existsSync(path.join(raw, "index.db")) || fs.existsSync(path.join(raw, "manifest.json"))) { packs.push(raw); continue; }
      for (const sub of fs.readdirSync(raw)) {
        const p = path.join(raw, sub);
        if (fs.existsSync(path.join(p, "index.db")) || fs.existsSync(path.join(p, "manifest.json"))) packs.push(p);
      }
    } catch (err) {}
  }
  return Array.from(new Set(packs));
}

export function readManifest(packDir) {
  try { return JSON.parse(fs.readFileSync(path.join(packDir, "manifest.json"), "utf8")); } catch (e) { return null; }
}

// 无 sqlite 时的兜底：靠目录名与文件名
export function scanPack(packDir) {
  const rows = [];
  const base = path.join(packDir, "memes");
  let tags = [];
  try { tags = fs.readdirSync(base); } catch (e) { return rows; }
  for (const tag of tags) {
    const dir = path.join(base, tag);
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    for (const f of files) {
      if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(f)) continue;
      rows.push({ tag: tag, file_name: f, caption: "", keywords: "", path: path.join(dir, f) });
    }
  }
  return rows;
}

export function loadIndexRows(packDir, sqliteLoader) {
  const dbFile = path.join(packDir, "index.db");
  if (!fs.existsSync(dbFile)) return null;
  const DatabaseSync = sqliteLoader || _DatabaseSync;
  if (!DatabaseSync) return null;
  try {
    const db = new DatabaseSync(dbFile);
    const rows = db.prepare("select path, tag, file_name, caption, keywords from memes").all();
    try { db.close(); } catch (e) {}
    return rows.map(function (r) {
      return { tag: r.tag, file_name: r.file_name, caption: r.caption || "", keywords: r.keywords || "", path: r.path };
    });
  } catch (e) { return null; }
}

export function scoreRow(row, desc) {
  const d = String(desc || "").toLowerCase().replace(/\s+/g, "");
  if (!d) return 0;
  let score = 0;
  const tag = String(row.tag || "").toLowerCase();
  const kws = String(row.keywords || "").toLowerCase().split(/\s+/).filter(Boolean);
  const cap = String(row.caption || "").toLowerCase();
  const file = String(row.file_name || "").replace(/\.[a-z]+$/i, "").toLowerCase();
  if (tag && (d.includes(tag) || tag.includes(d))) score = Math.max(score, 10 + tag.length);
  for (const k of kws) {
    if (!k) continue;
    if (d === k) score = Math.max(score, 60 + k.length * 2);
    else if (d.includes(k) || k.includes(d)) score = Math.max(score, 30 + k.length);
  }
  if (cap) {
    if (d.includes(cap) || cap.includes(d)) score = Math.max(score, 20 + cap.length);
    // 逐字兜底：必须又长又像才算（至少 3 个字重合、且重合率 ≥60%），
    // 而且分数封顶在 12 —— 任何关键词命中（≥30）都必须赢过它。
    let hit = 0;
    for (const ch of d) if (cap.includes(ch)) hit += 1;
    if (hit >= 3 && hit / d.length >= 0.6) score = Math.max(score, Math.min(12, 8 + hit));
  }
  if (file && (d.includes(file) || file.includes(d))) score = Math.max(score, 15 + file.length);
  return score;
}

export function createMemeLibrary(opts) {
  const o = opts || {};
  const packs = o.packs || resolveMemeRoots(o.env, o.dshHome);
  const sqliteLoader = o.DatabaseSync || _DatabaseSync;
  const perGroupLastAt = new Map();      // gid -> 上一次配图是第几次回复
  let replies = 0;
  const stats = { lookups: 0, hits: 0, misses: 0, attached: 0, suppressed: 0 };

  const rows = [];
  let packDir = null, manifest = null;
  // 合并所有包（以前遇到第一个有内容的包就 break，用户新加的包全被忽略）
  for (const p of packs) {
    const idx = loadIndexRows(p, sqliteLoader);
    const r = idx && idx.length ? idx : scanPack(p);
    if (!r.length) continue;
    if (!packDir) { packDir = p; manifest = readManifest(p); }
    for (const row of r) rows.push(Object.assign({}, row, { path: path.isAbsolute(row.path) ? row.path : path.join(p, row.path), pack: path.basename(p) }));
  }

  function byTag(tag) {
    return rows.filter(function (r) { return String(r.tag) === String(tag); });
  }

  function find(desc) {
    stats.lookups += 1;
    if (!rows.length) { stats.misses += 1; return null; }
    let best = null, bestScore = 0;
    for (const r of rows) {
      const s = scoreRow(r, desc);
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (!best || bestScore <= 0) { stats.misses += 1; return null; }
    stats.hits += 1;
    return {
      score: bestScore, tag: best.tag, file: best.file_name, path: best.path,
      caption: best.caption || best.file_name.replace(/\.[a-z]+$/i, ""),
      keywords: best.keywords || "",
      name: best.caption ? best.tag + "/" + best.file_name : best.file_name.replace(/\.[a-z]+$/i, "")
    };
  }

  return {
    ready: rows.length > 0, packDir: packDir, manifest: manifest, rows: rows,
    packs: packs, find: find, byTag: byTag, tags: function () { return Array.from(new Set(rows.map(function (r) { return r.tag; }))); },
    stats: function () { return Object.assign({ rows: rows.length, packDir: packDir, freq: null }, stats); },
    _internal: { scoreRow: scoreRow }
  };
}

// 配图节制：高档（详细回答）不配图；一条最多 1 张；「少」档还要拉开回复间隔
export function shouldAttachMeme(tier, mood, opts) {
  const o = opts || {};
  if (!mood) return { attach: false, reason: "没有情绪标记" };
  if (tier === "high") return { attach: false, reason: "详细回答不配图" };
  if (o.adminCommand) return { attach: false, reason: "管理指令不配图" };
  const freq = o.freq || "少";
  if (freq === "关") return { attach: false, reason: "表情包频率=关" };
  if (freq === "少" && o.sinceLastMeme != null && o.sinceLastMeme < (o.replyGapReplies != null ? o.replyGapReplies : MEME_DEFAULTS.replyGapReplies)) {
    return { attach: false, reason: "「少」档：距上次配图才 " + o.sinceLastMeme + " 次回复" };
  }
  return { attach: true, reason: "情绪明确" };
}
