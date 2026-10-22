// 画图：大脑只给一句"画什么"，这里负责变成 archify 的 workflow JSON、渲染成 HTML、再转 PNG。
// 之前的问题：人设让大脑写"HTML 的绝对路径"，但大脑是一次问答，根本没法先跑 archify —— 于是从来没画出来过。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

// 找 archify 技能（DSH 插件装在各 profile 的 node_modules 里）
export function findArchify(env) {
  const e = env || process.env;
  const out = [];
  if (e.DSHQQ_ARCHIFY_DIR) out.push(e.DSHQQ_ARCHIFY_DIR);
  const home = path.join(os.homedir(), ".dsh");
  const dirs = [path.join(home, "profiles"), path.join(home, "profiles", "desktop")];
  for (const root of dirs) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (err) { continue; }
    for (const n of names) out.push(path.join(root, n, "node_modules", "@tt-a1i", "archify-dsh", "skills", "archify"));
  }
  out.push(path.join(home, "profiles", "desktop", "node_modules", "@tt-a1i", "archify-dsh", "skills", "archify"));
  for (const d of out) {
    try { if (d && fs.existsSync(path.join(d, "bin", "archify.mjs"))) return d; } catch (e2) { }
  }
  return null;
}

// 让大脑把"画什么"变成 archify workflow JSON（只输出 JSON）
export function buildSpecPrompt(desc) {
  return [
    "把下面这件事变成一张 archify workflow 流程图。只输出 JSON，不要解释，不要代码块围栏。",
    "结构要求：",
    '{"schema_version":2,"diagram_type":"workflow",' +
    '"meta":{"title":"标题","animation":"trace","visual_preset":"signal-flow","quality_profile":"standard"},' +
    '"lanes":[{"id":"main","label":"主要角色"}],' +
    '"phases":[{"id":"p1","label":"阶段名","fromCol":0,"toCol":1}],' +
    '"nodes":[{"id":"n1","lane":"main","col":0,"type":"frontend","label":"短标题","sublabel":"短说明"}],' +
    '"edges":[{"from":"n1","to":"n2"}],"mainPath":["n1","n2"]}',
    "硬约束（违反会渲染失败）：",
    "1) 最多 6 个节点，每个节点的 col 各不相同，取值 0~5；",
    "2) label 不超过 6 个字，sublabel 不超过 8 个字（太长会被排版拒绝）；",
    "3) nodes[].type 只能是 frontend/backend/database/cloud/security/messagebus/external 之一；",
    "4) edges 必须首尾相连、mainPath 与节点顺序一致；phases 的 fromCol/toCol 也要落在 0~5。",
    "风格：给群友看的，说人话、步骤清楚，别堆术语。",
    "",
    "要画的内容：" + String(desc || "")
  ].join(String.fromCharCode(10));
}

export function createDiagram(opts) {
  const o = opts || {};
  const dir = o.skillDir || findArchify(o.env);
  const outDir = o.outDir;
  const askBrain = o.askBrain || null;

  function cli(args) {
    return new Promise(function (resolve) {
      const bin = path.join(dir, "bin", "archify.mjs");
      try {
        execFile(process.execPath, [bin].concat(args), { cwd: dir, timeout: 90000, windowsHide: true }, function (err, stdout, stderr) {
          resolve({ ok: !err, error: err ? String(stderr || err.message || "").slice(0, 400) : "", out: String(stdout || "").slice(0, 400) });
        });
      } catch (e) { resolve({ ok: false, error: String(e && e.message) }); }
    });
  }

  function extractJson(text) {
    const s = String(text || "").trim().replace(/^```(json)?/i, "").replace(/```\s*$/, "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }

  // 画一张图：desc → （大脑）spec → archify render → HTML 路径（转 PNG 交给调用方）
  async function draw(desc) {
    if (!dir) return { ok: false, error: "没找到 archify 技能目录" };
    if (!askBrain) return { ok: false, error: "没有可用的大脑" };
    const r1 = await askBrain({ promptText: buildSpecPrompt(desc), tier: "low" });
    if (!r1 || !r1.ok) return { ok: false, error: "生成图表规格失败：" + String((r1 && r1.error) || "无输出").slice(0, 120) };
    let spec = extractJson(r1.text);
    if (!spec) return { ok: false, error: "大脑没有给出合法 JSON" };
    const outAbs = path.resolve(outDir);          // 必须是绝对路径：archify 在自己的目录里跑
    fs.mkdirSync(outAbs, { recursive: true });
    const stamp = Date.now() + "-" + Math.floor(Math.random() * 1e4);
    const specFile = path.join(outAbs, "chart-" + stamp + ".json");
    const htmlFile = path.join(outAbs, "chart-" + stamp + ".html");
    spec.meta = Object.assign({}, spec.meta || {}, { output: path.basename(htmlFile) });
    let rendered = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 2 && !rendered; attempt++) {
      fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), "utf8");
      const r = await cli(["render", "workflow", specFile, htmlFile]);
      if (r.ok) { rendered = htmlFile; break; }
      lastErr = r.error || "";
      // 第一次失败：把报错喂回大脑修一版
      if (attempt === 0) {
        const fix = await askBrain({ promptText: buildSpecPrompt(desc) + String.fromCharCode(10) + "上一次渲染报错（请修正后重新输出完整 JSON）：" + r.error, tier: "low" });
        const s2 = fix && fix.ok ? extractJson(fix.text) : null;
        if (s2) spec = s2; else break;
      }
    }
    try { fs.unlinkSync(specFile); } catch (e) { }
    if (!rendered) return { ok: false, error: "archify 渲染失败" + (lastErr ? "：" + lastErr : "") };
    return { ok: true, html: rendered, spec: spec };
  }

  return { ready: !!dir, skillDir: dir, draw: draw };
}
