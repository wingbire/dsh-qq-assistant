import fs from "node:fs";
import path from "node:path";

// Our Free Model（社区插件 dsh-our-free-model）接进配置端：
//   ① 读插件自己的 catalog/availability（有哪些模型、上游探测结果）
//   ② 提供一个"真机检测"，用大脑同一条 CLI 路径挨个试，结果落盘
// 实测（2026-10-14）：Kilo 车道可用（kilo-auto/free、nemotron-3-ultra、dots-3-note-preview…）；
// OpenCode 免费池的 *-free 会 ECONNRESET（上游指纹识别客户端），标成 blocked 不给选。
export const OFM_PROVIDER = "our-free-model";
export const OFM_FALLBACK_MODEL = "kilo-auto/free";     // 比原来的 nemotron-ultra 快很多，且实测可用
export const OFM_DEFAULT_CANDIDATES = [
  "kilo-auto/free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "stealth/glyph-cluster"
];

export function ofmDir(dshHome) { return path.join(dshHome, "our-free-model"); }

export function readOfmState(dshHome) {
  const dir = ofmDir(dshHome);
  const out = { dir: dir, catalog: null, availability: null, settings: null, stats: null, at: null, error: null };
  const files = { catalog: "catalog.json", availability: "availability.json", settings: "settings.json", stats: "stats.json" };
  for (const k of Object.keys(files)) {
    try { out[k] = JSON.parse(fs.readFileSync(path.join(dir, files[k]), "utf8")); } catch (e) { out[k] = null; }
  }
  if (!out.catalog) out.error = "读不到 " + path.join(dir, "catalog.json") + "（Our Free Model 插件没装？）";
  out.at = out.catalog && out.catalog.at ? out.catalog.at : null;
  return out;
}

// 归一化成"能在下拉里列出来"的模型清单（带状态，UI 只把 available 的放前面）
export function modelList(state, probe) {
  const cat = (state && state.catalog) || {};
  const av = (state && state.availability && state.availability.results) || {};
  const pr = (probe && probe.results) || {};
  const rows = [];
  for (const r of (cat.kiloRows || [])) {
    const p = pr[r.id];
    rows.push({
      id: String(r.id), name: String(r.name || r.id), lane: String(r.channel || "kilo"),
      vision: !!r.vision, reasoning: !!r.reasoning, contextWindow: r.contextWindow || null, free: true,
      state: p ? (p.ok ? "available" : "failed") : "untested",
      detail: p ? (p.ok ? ("实测可用 " + (p.ms || "?") + " ms") : String(p.error || "失败").slice(0, 80)) : "还没实测",
      latencyMs: p && p.ms ? p.ms : null
    });
  }
  for (const id of (cat.entries || [])) {
    const a = av[String(id)] || {};
    const st = String(a.state || "unknown");
    rows.push({
      id: String(id), name: String(id), lane: "opencode", vision: false, reasoning: false, free: true,
      state: st === "unknown" ? "blocked" : st,
      detail: String(a.detail || "").slice(0, 120) || "未探测", latencyMs: a.latencyMs || null
    });
  }
  // 可用的排前面，然后按名字
  const rank = { available: 0, untested: 1, failed: 2, blocked: 3 };
  rows.sort(function (a, b) {
    const d = (rank[a.state] == null ? 9 : rank[a.state]) - (rank[b.state] == null ? 9 : rank[b.state]);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  return rows;
}

export function readProbe(file) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return j && j.results ? j : null; } catch (e) { return null; }
}
export function writeProbe(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (e) { return false; }
}

// 真机检测：用大脑同一条 CLI 路径挨个试（每个模型一次最小请求）
// 注意：一次要好几秒，所以只在用户点「检测可用模型」时跑，结果落盘，平时直接读缓存。
export async function probeModels(opts) {
  const o = opts || {};
  const dshHome = o.dshHome;
  const profile = o.profile || "qq-brain";
  const candidates = (o.candidates && o.candidates.length ? o.candidates : OFM_DEFAULT_CANDIDATES).slice(0, o.max || 6);
  const brain = o.brain || await import("./brain.js");
  const launch = o.launch || brain.resolveDshLaunch(brain.resolveDshCli());
  if (!launch) return { ok: false, error: "找不到 DSH 启动器", results: {} };
  const patchPath = path.join(dshHome, "profiles", profile, "cordis.patch.yml");
  let backup = null;
  try { backup = fs.readFileSync(patchPath, "utf8"); } catch (e) {}
  const results = {};
  const log = o.log || function () {};
  for (const id of candidates) {
    const t0 = Date.now();
    try {
      const prof = brain.ensureBrainProfile({ dshHome: dshHome, profile: profile, personaText: o.personaText || "", model: { provider: OFM_PROVIDER, model: id }, timeoutMs: 60000 });
      if (!prof || !prof.ok) throw new Error((prof && prof.error) || "建 profile 失败");
      const files = [prof.patch];
      if (prof.tiers && prof.tiers.mid) files.push(prof.tiers.mid);
      const r = await brain.runBrain({ launch: launch, profile: profile, appName: brain.APP_NAME, promptText: "只回两个字：在的", patchFiles: files, timeoutMs: o.timeoutMs || 90000, json: true });
      results[id] = r && r.ok
        ? { ok: true, ms: Date.now() - t0, text: String(r.text || "").slice(0, 40), tokens: (r.usage && r.usage.totalTokens) || null }
        : { ok: false, ms: Date.now() - t0, error: String((r && r.error) || "失败").slice(0, 160) };
    } catch (e) {
      results[id] = { ok: false, ms: Date.now() - t0, error: String(e && e.message).slice(0, 160) };
    }
    log(id + " → " + (results[id].ok ? "可用 " + results[id].ms + "ms" : "不可用 " + results[id].error));
  }
  if (backup != null) { try { fs.writeFileSync(patchPath, backup, "utf8"); } catch (e) {} }
  const okCount = Object.keys(results).filter(function (k) { return results[k].ok; }).length;
  return { ok: true, at: Date.now(), results: results, okCount: okCount, total: candidates.length, restored: backup != null };
}
