import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, DSH_HOME } from "./paths.js";

export const AUDIT_MODEL = "external-audit-model";
export const AUDIT_PROFILE_ID = "qq-audit";
export const AUDIT_TIMEOUT_MS = 30000;         // N11：超时算「不确定」
// 默认值必须匹配通道的真实延迟：qq-audit 这个 profile 挂的是免费模型池（dsh-our-free-model），
// 实测一次 20~30 秒 —— 早先默认 8000 的结果是"每次都超时 → 外审从未真正生效"（后台只看到 19% 外审不可用）。
export const RUBRIC_FILE = path.join(APP_ROOT, "..", "prompts", "外审rubric.template.md");

export function loadRubric(file) {
  try { return fs.readFileSync(file || RUBRIC_FILE, "utf8").trim(); } catch (e) {
    return "判断这条群消息值不值得小助手回复，以及该回多长。消息里出现下面列出的名字即算点名。只输出：是 / 短 / 否 / 不确定";
  }
}

// 模型可能吐出「是。」「答案：否」「短」等，这里只认语义。
// 三档语义（决定"开口 + 深度"两件事，不只是回不回）：
//   yes   = 值得回，而且要认真回
//   short = 可以回，但一句短的够了
//   no    = 不值得回（这次就别开口）
export function parseAuditVerdict(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return "unsure";
  if (t.includes("不确定") || /unsure/i.test(t)) return "unsure";
  if (t.includes("不回") || t.includes("不值得") || t.includes("否") || t.includes("不是") || /^no\b/i.test(t)) return "no";
  if (t.includes("短") || /^short\b/i.test(t)) return "short";
  if (t.includes("值得回") || t.includes("是") || /^yes\b/i.test(t)) return "yes";
  return "unsure";
}

// 规则兜底：没有真实外审通道时用（测试、无密钥、通道故障）
export function auditStub(text, ctx) {
  const t = String(text || "");
  const botNames = ((ctx && ctx.botNames) || []).concat((ctx && ctx.nicknames) || []);
  let hitBot = false;
  for (const n of botNames) if (n && t.includes(n)) hitBot = true;
  const toOther = /他说|她说|群里有人/.test(t) || /问你呢/.test(t);
  const askMe = /你能|你会|帮我|教教我/.test(t) || t.includes("你");
  let verdict = "unsure";
  if (hitBot || (/你/.test(t) && askMe && !toOther)) verdict = "yes";
  else if (toOther) verdict = "no";
  return { verdict: verdict, model: AUDIT_MODEL, tokens: { in: 40 + t.length, out: 12 }, channel: "stub" };
}

// 真实通道：走独立的 qq-audit profile，8 秒超时 → 不确定。
export function createAuditor(opts) {
  const o = opts || {};
  const runner = o.runner;                       // ({promptText, profile, timeoutMs}) => {ok,text,usage,error}
  const timeoutMs = o.timeoutMs || AUDIT_TIMEOUT_MS;
  const nowFn = o.now || function () { return Date.now(); };
  const rubric = o.rubric != null ? o.rubric : loadRubric(o.rubricFile);

  return async function auditor(text, ctx) {
    const started = nowFn();
    if (!runner) return Object.assign(auditStub(text, ctx), { ms: 0, error: "无外审通道" });
    // 小助手的名字必须告诉外审员，否则「小肥鱼 这个报错怎么解」会被误判成没在叫人
    const names = ((ctx && ctx.botNames) || []).concat((ctx && ctx.nicknames) || []).filter(Boolean).slice(0, 6);
    const head = names.length ? "【小助手在这里叫】" + names.join("、") + String.fromCharCode(10) : "";
    // 指代对象提示：外审只看到单条消息，判断不了「她」指的是谁 —— 由运行时代为提供锚点。
    // 注意措辞仍然是否定式的：有锚点也可能是在说别人（另一个女生/主播/角色），让外审自己分辨。
    const hint = (ctx && ctx.recentMention)
      ? "【上下文提示，仅供参考】最近几条里出现过小助手（有人叫过她，或她刚发过言）。" +
        "自己判断这句是不是冲着她来的 —— 群里也可能正在聊别的女生、主播或角色。" + String.fromCharCode(10)
      : "";
    const ctxBlock = (ctx && ctx.contextText) ? "【最近的群聊（越靠下越新；判断『在跟谁说话』要看这个）】" + String.fromCharCode(10) + String(ctx.contextText).slice(-600) + String.fromCharCode(10) : "";
    const promptText = head + ctxBlock + hint + "【待审消息】" + String.fromCharCode(10) + String(text || "").slice(0, 300);
    let r = null;
    try { r = await runner({ promptText: promptText, profile: AUDIT_PROFILE_ID, personaText: rubric, timeoutMs: timeoutMs }); }
    catch (e) { r = { ok: false, error: String(e && e.message) }; }
    const ms = nowFn() - started;
    if (!r || !r.ok) {
      // N11：超时/失败一律「不确定」，绝不因为外审坏了就乱判
      return { verdict: "unsure", model: AUDIT_MODEL, channel: "brain", ms: ms, error: (r && r.error) || "外审失败", usage: (r && r.usage) || null };
    }
    return { verdict: parseAuditVerdict(r.text), model: AUDIT_MODEL, channel: "brain", ms: ms, raw: String(r.text || "").slice(0, 40), usage: r.usage || null };
  };
}

let channel = null;
export function setAuditChannel(fn) { channel = fn; return channel; }
export function getAuditChannel() { return channel; }

// gates.js 直接调这个：装了真实通道就走真实通道，装了没通/没装就退回规则。
export async function audit(text, ctx) {
  if (!channel) return auditStub(text, ctx);
  const r = await channel(text, ctx);
  return r || auditStub(text, ctx);
}

export const MEME_LIB = [
  { name: "猫猫无语", kw: ["无语", "服了", "麻了", "离谱"] },
  { name: "猫猫得意", kw: ["得意", "拿下", "赢了", "成功"] },
  { name: "猫猫震惊", kw: ["震惊", "真的假的", "卧槽", "龟龟"] },
  { name: "猫猫求饶", kw: ["抱歉", "我错了", "对不起", "别打我"] },
  { name: "猫猫开心", kw: ["开心", "好耶", "哈哈", "太好了"] },
  { name: "猫猫叹气", kw: ["叹气", "累了", "不想", "算了"] }
];

export function parseMeme(text) {
  const s = String(text || "");
  const OPEN = "[表情:";
  const i = s.indexOf(OPEN);
  if (i < 0) return { text: s.trim(), mood: null };
  const j = s.indexOf("]", i);
  if (j < 0) return { text: s.trim(), mood: null };
  const mood = s.slice(i + OPEN.length, j).trim();
  const body = (s.slice(0, i) + s.slice(j + 1)).trim();
  return { text: body, mood: mood || null };
}

export function findMeme(mood) {
  if (!mood) return null;
  const m = String(mood);
  for (const entry of MEME_LIB) {
    for (const kw of entry.kw) if (m.includes(kw) || m.includes(entry.name)) return entry;
  }
  return null;
}

export function shouldAttachMeme(tier, mood) {
  if (tier === "high") return false;
  if (!mood) return false;
  return true;
}
