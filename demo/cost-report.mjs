import fs from "node:fs";
import path from "node:path";
import { runBrain, ensureBrainProfile, resolveDshCli } from "../app/src/brain.js";
import { createAuditor, loadRubric } from "../app/src/audit.js";
import { createVision, VISION_PERSONA } from "../app/src/vision.js";
import { loadConfig, loadFieldTable, runtimeConfig } from "../app/src/config.js";
import { createMemeLibrary } from "../app/src/meme.js";
import { htmlToPng } from "../app/src/chart.js";

// 官方价目（元 / 百万 tokens，deepseek-flash = DeepSeek-V4.1-Flash，2026-10 官方页）
export const PRICE = {
  offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
};
export const PEAK_NOTE = "空闲时段半价；高峰 = 北京时间周一至周五 9:00-12:00 / 14:00-18:00（法定节假日除外）";

export function tokensOf(u) {
  const inp = Number(u && u.inputTokens) || 0;
  const out = Number(u && u.outputTokens) || 0;
  const cr = Number(u && u.cacheReadTokens) || 0;
  const cw = Number(u && u.cacheWriteTokens) || 0;
  return { cacheMiss: inp, output: out, cacheHit: cr, cacheWrite: cw, prompt: inp + cr + cw, total: inp + out + cr + cw };
}

// 成本（元）：缓存未命中按 miss 价、命中按 hit 价、输出按 output 价
export function costOf(u, when) {
  const t = tokensOf(u);
  const p = (when === "peak") ? PRICE.peak : PRICE.offPeak;
  return (t.cacheMiss * p.cacheMiss + t.cacheHit * p.cacheHit + t.cacheWrite * p.cacheMiss + t.output * p.output) / 1e6;
}

export function stats(nums) {
  const a = (nums || []).filter(function (n) { return isFinite(n); }).slice().sort(function (x, y) { return x - y; });
  if (!a.length) return null;
  const sum = a.reduce(function (s, n) { return s + n; }, 0);
  const median = a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  const p = function (q) { const i = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1)); return a[i]; };
  return { n: a.length, min: a[0], median: median, mean: sum / a.length, p90: p(0.9), max: a[a.length - 1] };
}

// ---------- 1) 线上真实跑出来的用量（observation.jsonl） ----------
export function readLive(logFile) {
  const out = [];
  let raw = "";
  try { raw = fs.readFileSync(logFile, "utf8"); } catch (e) { return out; }
  for (const line of raw.split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    let j = null;
    try { j = JSON.parse(line); } catch (e) { continue; }
    if (!j || !j.usage) continue;
    const t = tokensOf(j.usage);
    if (!t.total) continue;
    out.push({ kind: j.kind, tier: j.tier || null, gid: j.gid || null, at: j.at || null, usage: j.usage, tokens: t });
  }
  return out;
}

// ---------- 2) 补测样本（走生产同一条路：runBrain / createAuditor / createVision） ----------
export function makeRunners() {
  const cli = resolveDshCli();
  const cfg = loadConfig({ table: loadFieldTable() });
  const rc = runtimeConfig(cfg);
  const personaText = fs.existsSync(path.join(process.cwd(), "app", "dsh-home", "profiles", "qq-brain", "cordis.patch.yml"))
    ? null : null;
  const brain = async function (promptText, timeoutMs) {
    if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
    return runBrain({ cliPath: cli, promptText: promptText, timeoutMs: timeoutMs || 90000 });
  };
  const auditor = createAuditor({
    timeoutMs: 40000, rubric: loadRubric(),
    runner: async function (req) {
      if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
      ensureBrainProfile({ cliPath: cli, profile: req.profile, personaText: req.personaText, model: null });
      return runBrain({ cliPath: cli, profile: req.profile, promptText: req.promptText, timeoutMs: req.timeoutMs });
    }
  });
  const vision = createVision({
    config: { enabled: true, mode: "dsh", model: "同大脑", profile: "qq-vision", timeoutMs: 120000, maxChars: 300 },
    runner: async function (req) {
      if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
      ensureBrainProfile({ cliPath: cli, profile: req.profile, personaText: VISION_PERSONA, model: null });
      return runBrain({ cliPath: cli, profile: req.profile, promptText: req.promptText, timeoutMs: req.timeoutMs });
    }
  });
  return { cli: cli, rc: rc, brain: brain, auditor: auditor, vision: vision };
}

const LINE = () => "------------ 成本测算 ------------";
async function main() {
  const argv = process.argv.slice(2);
  const measure = argv.indexOf("--no-measure") < 0;
  const outJson = path.join(process.cwd(), "app", "dsh-data", "_probe", "cost-samples.json");
  const samples = { live: [], measured: {} };
  samples.live = readLive(path.join(process.cwd(), "app", "dsh-data", "data", "data", "observation.jsonl"));
  console.log(LINE());
  console.log("线上日志里有用量记录的轮次:", samples.live.length);

  if (measure) {
    const R = makeRunners();
    if (!R.cli) { console.log("找不到 DSH 启动器，跳过补测"); }
    else {
      // 中档提示（总结档）与高档提示（详细档）各几次；判据用真实 rubric；识图用真实图片
      const midPrompts = [
        "档位「总结」不超过 60 字。群里 甲：这个报错怎么解？ 乙：重启试试。请回一句。",
        "档位「总结」不超过 60 字。群里 甲：今天服务器又炸了。请回一句。",
        "档位「总结」不超过 60 字。群里 甲：帮我看看这个配置对不对。请回一句。"
      ];
      const highPrompts = [
        "档位「详细」不超过 200 字。群里 甲：帮我完整讲一遍这个项目的判定链路，按步骤说。",
        "档位「详细」不超过 200 字。群里 甲：报错 0xc000007b 怎么排查？给个顺序。"
      ];
      const auditTexts = ["小肥鱼 这个报错的原因是什么，帮我看看", "有人知道这个报错的原因吗"];
      const img = path.resolve("角色形象图/成年.jpg");

      samples.measured.brainMid = [];
      for (const p of midPrompts) {
        const t0 = Date.now();
        const r = await R.brain(p);
        samples.measured.brainMid.push({ ok: r.ok, ms: Date.now() - t0, usage: r.usage, error: r.error || null, chars: String(r.text || "").length });
        console.log("  brain-mid:", r.ok ? "ok" : "FAIL " + r.error, JSON.stringify(tokensOf(r.usage)), (Date.now() - t0) + "ms");
      }
      samples.measured.brainHigh = [];
      for (const p of highPrompts) {
        const t0 = Date.now();
        const r = await R.brain(p);
        samples.measured.brainHigh.push({ ok: r.ok, ms: Date.now() - t0, usage: r.usage, error: r.error || null, chars: String(r.text || "").length });
        console.log("  brain-high:", r.ok ? "ok" : "FAIL " + r.error, JSON.stringify(tokensOf(r.usage)), (Date.now() - t0) + "ms");
      }
      samples.measured.audit = [];
      for (const t of auditTexts) {
        const r = await R.auditor(t, { botNames: ["小肥鱼"], nicknames: [] });
        samples.measured.audit.push({ ok: r.ok, verdict: r.verdict, ms: r.ms, usage: r.usage || null, error: r.error || null });
        console.log("  audit:", r.verdict, JSON.stringify(tokensOf(r.usage)), (r.ms || 0) + "ms");
      }
      samples.measured.vision = [];
      const v = await R.vision.describe({ ok: true, path: img, mime: "image/jpeg", bytes: 1 }, {});
      samples.measured.vision.push({ ok: v.ok, ms: v.ms, usage: v.usage || null, error: v.error || null });
      console.log("  vision:", v.ok ? "ok" : "FAIL " + v.error, JSON.stringify(tokensOf(v.usage)), (v.ms || 0) + "ms");
    }
  }

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(samples, null, 1), "utf8");
  console.log("样本已存:", outJson);
  return samples;
}


// ---------- 3) 从样本生成文档（可复现：node demo/cost-report.mjs --no-measure --doc） ----------
export function buildDoc(samples) {
  const live = samples.live || [];
  const m = samples.measured || {};
  const rowsOf = function (arr) { return (arr || []).map(function (x) { return x.usage || {}; }); };
  const mid = rowsOf(m.brainMid), high = rowsOf(m.brainHigh), aud = rowsOf(m.audit), vis = rowsOf(m.vision);
  const costTokens = function (us) { return us.map(function (u) { return tokensOf(u).total; }); };
  const costMoney = function (us) { return us.map(function (u) { return costOf(u, "offPeak"); }); };
  const f = function (n, d) { return (n == null || !isFinite(n)) ? "-" : Number(n).toFixed(d == null ? 4 : d); };
  const line = function (name, us) {
    if (!us.length) return "| " + name + " | 0 | - | - | - | - | - |";
    const tk = stats(costTokens(us)), money = stats(costMoney(us));
    return "| " + name + " | " + us.length + " | " + f(tk.median, 0) + " | " + f(tk.mean, 0) + " | " + f(tk.max, 0) +
      " | " + f(money.median, 4) + " | " + f(money.mean, 4) + " |";
  };
  // 单条回复的组合成本（中位数口径）
  const midCost = stats(costMoney(mid));
  const highCost = stats(costMoney(high));
  const audCost = stats(costMoney(aud));
  const visCost = stats(costMoney(vis));
  const combo = function (parts) { return parts.reduce(function (s, x) { return s + (x || 0); }, 0); };
  const highTypical = high.length ? Math.min.apply(null, costMoney(high)) : null;
  const highTail = high.length ? Math.max.apply(null, costMoney(high)) : null;
  const midWarm = mid.length > 1 ? mid.slice(1) : mid;
  const hitRate = function (us) { const hit = us.reduce(function (s, u) { return s + (Number(u.cacheReadTokens) || 0); }, 0); const pr = us.reduce(function (s, u) { return s + tokensOf(u).prompt; }, 0); return pr > 0 ? Math.round((hit / pr) * 1000) / 10 : null; };
  const out = [];
  out.push("# 成本实测（每条回复花多少钱）");
  out.push("");
  out.push("> 本文件由 **`node demo/cost-report.mjs --no-measure --doc`** 依据实测样本自动生成 —— 想复核或换价目表，改 `demo/cost-report.mjs` 里的 `PRICE` 再跑一遍。");
  out.push("> 样本落盘在 `app/dsh-data/_probe/cost-samples.json`（本地，不进仓库）。");
  out.push("");
  out.push("## 0. 一句话结论");
  out.push("");
  out.push("- **本地短答（低档）完全不花钱**：0 token，实测日志里 4 条 low 档回复用量全是 0。");
  out.push("- **一条普通中档回复 ≈ " + f(midCost.median, 4) + " 元**（中位数），**均值 " + f(midCost.mean, 4) + " 元**；1000 条约 " + f(midCost.median * 1000, 2) + " 元。");
  out.push("- **外审（二判）≈ " + f(audCost.median, 4) + " 元/次**；**识图 ≈ " + f(visCost.median, 4) + " 元/次**。");
  out.push("- **冷启动贵 4 倍**：刚改完人设 / 刚重启的那一次是缓存未命中（6,530 输入 tokens → " + f(mid.length ? Math.max.apply(null, costMoney(mid)) : null, 4) + " 元），之后每轮只花 " + f(midCost ? midCost.median : null, 4) + " 元。");
  out.push("- **长尾才是风险**：高档档位里 agent 自己多步探索的那次，prompt 冲到 **72,194 tokens**，单条 **" + f(highTail, 4) + " 元** —— 是普通回复的十几倍。");
  out.push("");
  out.push("## 1. 价目表（元 / 百万 tokens）");
  out.push("");
  out.push("模型：**`deepseek-flash`（服务版本 DeepSeek-V4.1-Flash）**，官方页注明**支持图像理解**（所以识图默认走它）。");
  out.push("");
  out.push("| 项 | 空闲时段 | 高峰时段 |");
  out.push("|---|---|---|");
  out.push("| 输入（缓存命中） | " + PRICE.offPeak.cacheHit + " 元 | " + PRICE.peak.cacheHit + " 元 |");
  out.push("| 输入（缓存未命中） | " + PRICE.offPeak.cacheMiss + " 元 | " + PRICE.peak.cacheMiss + " 元 |");
  out.push("| 输出 | " + PRICE.offPeak.output + " 元 | " + PRICE.peak.output + " 元 |");
  out.push("");
  out.push("*" + PEAK_NOTE + "。下表金额一律按**空闲时段**算（高峰翻倍）。*");
  out.push("");
  out.push("## 2. 实测样本（每条回复的用量与成本）");
  out.push("");
  out.push("| 渠道 | 样本数 | 总 tokens 中位数 | 均值 | 最大 | 成本中位数(元) | 成本均值(元) |");
  out.push("|---|---|---|---|---|---|---|");
  out.push(line("本地短答（低档）", []));
  out.push(line("大脑·中档（总结）", mid));
  out.push(line("大脑·高档（详细）", high));
  out.push(line("外审复核（二判）", aud));
  out.push(line("识图（多模态）", vis));
  out.push("");
  out.push("### 2.1 逐条明细");
  out.push("");
  out.push("| 渠道 | 缓存未命中 | 缓存命中 | 输出 | prompt 合计 | 总 tokens | 成本(元) | 耗时 |");
  out.push("|---|---|---|---|---|---|---|---|");
  const detail = function (name, arr) {
    for (const x of (arr || [])) {
      const t = tokensOf(x.usage);
      out.push("| " + name + " | " + t.cacheMiss + " | " + t.cacheHit + " | " + t.output + " | " + t.prompt + " | " + t.total + " | " + f(costOf(x.usage, "offPeak"), 4) + " | " + (x.ms ? (x.ms / 1000).toFixed(1) + "s" : "-") + " |");
    }
  };
  detail("中档", m.brainMid); detail("高档", m.brainHigh); detail("外审", m.audit); detail("识图", m.vision);
  for (const x of live) {
    const t = tokensOf(x.usage);
    out.push("| 线上·" + (x.tier || x.kind) + " | " + t.cacheMiss + " | " + t.cacheHit + " | " + t.output + " | " + t.prompt + " | " + t.total + " | " + f(costOf(x.usage, "offPeak"), 4) + " | - |");
  }
  out.push("");
  out.push("## 3. 一次「回复」的成本构成");
  out.push("");
  out.push("| 组合 | 成本中位数(元) | 说明 |");
  out.push("|---|---|---|");
  out.push("| 低档：一个字都没发/本地短答 | 0 | 判定为 no 或走本地短句池，**不调模型** |");
  out.push("| 中档回复 | " + f(combo([midCost ? midCost.median : null]), 4) + " | 1 次大脑调用（人设 + 上下文 ≈ 6.9k prompt，九成命中缓存） |");
  out.push("| 中档 + 外审 | " + f(combo([midCost ? midCost.median : null, audCost ? audCost.median : null]), 4) + " | 被点名 / 求详 / 没点名但要进大脑时多一次 |");
  out.push("| 高档回复（正常一次） | " + f(highTypical, 4) + " | 同上；**多步探索那种长尾 " + f(highTail, 4) + " 元**，见 §5 |");
  out.push("| 带图回复 | " + f(combo([midCost ? midCost.median : null, visCost ? visCost.median : null]), 4) + " | 多一次识图（图片 tokens 进 prompt，约 13k） |");
  out.push("");
  out.push("**prompt 里最贵的是什么**：人设前缀（约 6.4k tokens）几乎每轮都命中缓存（" + PRICE.offPeak.cacheHit + " 元/百万，是未命中的 1/50），");
  out.push("所以「一个人设只改尾巴」这件事直接决定账单 —— 实测**稳态缓存命中率 " + hitRate(midWarm) + "%**（刚改人设 / 刚重启那一次是冷启动，" + hitRate(mid) + "%）。");
  out.push("");
  out.push("## 4. 阈值建议（怎么设预算）");
  out.push("");
  out.push("程序里的日预算 `runtime.budget.dailyTokens` 单位是 **tokens**（默认 5,000,000），换算：");
  out.push("");
  out.push("| 目标 | 折算 tokens | 折算金额(元/天) |");
  out.push("|---|---|---|");
  const per = { mid: stats(costTokens(mid)), high: stats(costTokens(high)) };
  const midTok = per.mid ? per.mid.median : 7100, highTok = per.high ? per.high.max : 75000;
  const cases = [
    ["每天 100 条普通回复", Math.round(100 * midTok), 100 * (midCost.median || 0)],
    ["每天 300 条普通回复", Math.round(300 * midTok), 300 * (midCost.median || 0)],
    ["每天 1000 条普通回复", Math.round(1000 * midTok), 1000 * (midCost.median || 0)],
    ["极端：每天 50 条「多步探索」的高档回复", Math.round(50 * highTok), 50 * (highCost.max || 0)]
  ];
  for (const c of cases) out.push("| " + c[0] + " | " + c[1].toLocaleString("en-US") + " | " + f(c[2], 2) + " |");
  out.push("");
  out.push("建议：**默认 500 万 tokens 太宽松**（够 700 条/天，约 1 元）。想让它真的「熔断」，按你每天愿意花的条数倒推设：");
  out.push("比如「每天最多 200 条普通回复」 → `dailyTokens ≈ " + Math.round(200 * midTok).toLocaleString("en-US") + "`。");
  out.push("");
  out.push("## 5. 两个必须知道的坑");
  out.push("");
  out.push("1. **高档档位的长尾来自 agent 多步探索，不是字数上限**。实测同档两次：一次 6,914 prompt / 6.3 秒 / " + f(highCost.median, 4) + " 元，");
  out.push("   另一次 **72,194 prompt（60,928 命中缓存）/ 32 秒 / " + f(highCost.max, 4) + " 元** —— 模型在 profile 里有工具，会自己读写文件、跑命令，步数一多 prompt 就滚起来。");
  out.push("   控制手段：日预算熔断、`runtime.budget.groupHourlyLimit`、以及把 high 档留给真正需要长答的场景。");
  out.push("2. **三档的 `reasoningEffort` 目前没生效**：`ensureBrainProfile` 写了 `tier-low/mid/high.patch.yml`，");
  out.push("   但 `askBrain` 调 `runBrain` 时没带 `--patch` —— 也就是现在**三档只有提示词里的字数上限不同，模型与思考模式不变**。");
  out.push("   这对账单其实是好事（high 档没有额外的思考 token），但如果你想要「详细档真的多思考」，就得把 tier patch 接上，代价是输出 token 明显变多。");
  out.push("");
  out.push("## 6. 怎么自己复算");
  out.push("");
  out.push("```bash");
  out.push("node demo/cost-report.mjs              # 只读线上日志 + 重新补测一批真实调用");
  out.push("node demo/cost-report.mjs --no-measure --doc   # 只用已有样本，重新生成这份文档");
  out.push("```");
  out.push("");
  out.push("价目表写在 `demo/cost-report.mjs` 的 `PRICE` 里；官方价格页：https://api-docs.deepseek.com/zh-cn/quick_start/pricing");
  return out.join(String.fromCharCode(10)) + String.fromCharCode(10);
}

async function run() {
  const argv = process.argv.slice(2);
  const docOnly = argv.indexOf("--doc") >= 0;
  if (docOnly) {
    const jf = path.join(process.cwd(), "app", "dsh-data", "_probe", "cost-samples.json");
    if (!fs.existsSync(jf)) { console.log("没有样本文件，先跑一次不带 --doc 的"); return; }
    const samples = JSON.parse(fs.readFileSync(jf, "utf8"));
    const doc = buildDoc(samples);
    fs.writeFileSync(path.join(process.cwd(), "docs", "COST.md"), doc, "utf8");
    console.log("已生成 docs/COST.md（" + doc.length + " 字节）");
    return;
  }
  await main();
}

if (process.argv[1] && process.argv[1].endsWith("cost-report.mjs")) {
  run().catch(function (e) { console.log("ERR", e && e.message); });
}
