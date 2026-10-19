import fs from "node:fs";
import path from "node:path";

// 回放语料：把真实群聊截下来，人工标注「她该不该回」，以后每次改动都先跑它 ——
// 这样"改一个崩一个"能当场抓到，而不是等群里出丑。
// 存 JSON 而不是 jsonl：条数少（几十条），要能原地改标注。
export const EXPECTS = ["该回", "该不回", "该短回"];

export function corpusFile(dataDir) { return path.join(dataDir, "corpus.json"); }

export function loadCorpus(file) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(j) ? j : []; }
  catch (e) { return []; }
}

export function saveCorpus(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(items, null, 2));
  return items;
}

export function corpusStats(items) {
  const all = items || [];
  const labeled = all.filter(function (i) { return i && i.expect; }).length;
  return { total: all.length, labeled: labeled, unlabeled: all.length - labeled };
}

// 标注一条（expect 传空 = 清掉）。只接受三个值，防止手滑写进奇怪的东西。
export function labelCorpus(items, id, expect) {
  const want = String(expect == null ? "" : expect).trim();
  if (want && EXPECTS.indexOf(want) < 0) throw new Error("标注只能是：该回 / 该不回 / 该短回");
  let hit = null;
  for (const it of (items || [])) { if (it && String(it.id) === String(id)) { it.expect = want; hit = it; } }
  if (!hit) throw new Error("没找到这条语料");
  return hit;
}

// 外审结论从判定依据里抠出来（"外审（灰区也审）：short" → short）
export function auditFromReason(reason) {
  const s = Array.isArray(reason) ? reason.join(" ") : String(reason || "");
  const m = s.match(/外审（[^）]*）：(yes|short|no|unsure)/);
  return m ? m[1] : "";
}

// 从判定记录生成语料；同一段文字+时间的老标注会保留下来（重复拉取不会丢标注）
export function fromDecisions(decisions, prev, limit) {
  const keep = new Map();
  for (const p of (prev || [])) if (p && p.text != null) keep.set(String(p.text) + "|" + String(p.at), p);
  const out = [];
  const seen = new Set();
  for (const d of (decisions || [])) {
    if (!d || !d.text) continue;
    const key = String(d.text) + "|" + String(d.at);
    if (seen.has(key)) continue;
    seen.add(key);
    const old = keep.get(key);
    out.push({
      id: String(new Date(d.at).getTime()) + "-" + out.length,
      at: d.at,
      speaker: d.speaker || "",
      text: d.text,
      decided: d.action || "",
      atBot: !!d.atBot,
      replyToBot: !!d.replyToBot,
      reason: Array.isArray(d.reason) ? d.reason : [],
      audit: auditFromReason(d.reason),
      expect: old ? (old.expect || "") : ""
    });
  }
  return out.slice(-(limit || 60));
}
