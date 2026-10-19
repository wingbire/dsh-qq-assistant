import { maskUntrusted, normalizeName, isInstructionLike } from "./untrusted.js";
import { classify } from "./classify.js";
import { createAddressee } from "./addressee.js";
import { isGreeting } from "./localreply.js";
import { utilityScore, UTILITY_WEIGHTS, TIERS, gateFactor, clamp01 } from "./utility.js";
import { valve, depthTier, searchPlan, clampBounds, DEFAULT_BOUNDS } from "./gatescore.js";
import { bucketOf } from "./bandit.js";
import { audit } from "./audit.js";

export const DEFAULT_COST_SCALE = 900;

const DETAIL_WORDS = ["详细", "解释", "原因", "原理", "文档", "步骤", "教程", "为什么", "写"];
const QUESTION_WORDS = ["怎么", "如何", "为什么", "是什么", "在哪", "有没有", "吗", "咋"];

export function hardTrigger(evt, names) {
  const t = evt.text || "";
  const hits = [];
  if (evt.atBot) hits.push("at");
  if (evt.replyToBot) hits.push("reply");
  for (const n of (names || [])) if (n && t.includes(n)) { hits.push("nick"); break; }
  let strength = 0;
  if (hits.includes("at")) strength = 1;
  else if (hits.includes("reply")) strength = 0.9;
  else if (hits.includes("nick")) strength = 0.7;
  return { hits: hits, strength: strength };
}

function hasAny(text, words) {
  for (const w of words) if (text.includes(w)) return true;
  return false;
}

function signalOf(signals, key) {
  for (const s of signals) if (s.k === key) return s;
  return { v: 0, w: 0 };
}

export function createGates(opts) {
  const o = opts || {};
  const addressee = createAddressee({ weights: o.weights });
  const banditRef = o.bandit || null;
  let bounds = clampBounds(o.bounds || DEFAULT_BOUNDS);
  const tiers = Object.assign({}, TIERS, o.tiers || {});
  const W = Object.assign({}, UTILITY_WEIGHTS, o.utilityWeights || {});
  const nowFn = o.now || function () { return Date.now(); };
  // 语义补救：本地判否、但看起来是个"没点名的真问题"时，先抬成灰区（关 / 短句 / 中档）
  const rescueAsk = String(o.rescueAsk == null ? "中档" : o.rescueAsk);
  const blockInjected = o.blockInjected !== false;         // 疑似注入指令：直接不回（默认开）
  // 外审复核：scope = 只审高档 / 高档+复核救回（默认）/ 灰区也审
  const auditFn = (typeof o.auditFn === "function") ? o.auditFn : audit;   // 注入点：测试用，避免动全局通道
  const auditCfg = o.audit || {};
  // 默认「灰区也审」：灰区（本地拿不准）本来就该复核"是否进大脑"，这是用户的诉求
  const auditScope = String(auditCfg.scope || "灰区也审");
  const auditRescue = auditScope !== "只审高档";
  const auditGrey = auditScope === "灰区也审";
  const auditTimeoutMode = String(auditCfg.onTimeout || "降档");
  const auditMaxPerHour = Number(auditCfg.maxPerHour) || 0;   // 0 = 不限
  // 未点名、但本地准备进大脑的（"你/他/她"到底指谁，本地规则分不清）→ 交给外审定夺
  const auditUnaddressed = auditCfg.auditUnaddressed !== false;
  const auditTimes = [];
  // 「边界判否」补救的独立限流（跟外审总限流分开算）
  const noAuditTimes = [];
  const noAuditMaxPerHour = Number(auditCfg.noMaxPerHour) || 6;
  function noAuditAllow(nowMs) {
    if (!noAuditMaxPerHour) return true;
    const t = Number(nowMs == null ? Date.now() : nowMs);
    while (noAuditTimes.length && t - noAuditTimes[0] > 3600000) noAuditTimes.shift();
    return noAuditTimes.length < noAuditMaxPerHour;
  }
  function auditAllow(nowMs) {
    if (!auditMaxPerHour) return true;
    const t = nowMs == null ? nowFn() : nowMs;
    while (auditTimes.length && t - auditTimes[0] > 3600000) auditTimes.shift();
    return auditTimes.length < auditMaxPerHour;
  }
  function mcOf(i) {
    const mc = (tiers && Array.isArray(tiers.maxChars) && tiers.maxChars.length >= 3) ? tiers.maxChars : [20, 60, 200];
    return mc[i];
  }

  async function decide(evt, ctx) {
    // 【两人对话硬闸·收窄版】别人在一来一往、她没在局里 → 不插嘴。
    // 放行条件（任一）：点她名字 / @她 / 回复她 / 面向全群的问题（你们·大家·有人·谁·各位·在吗）。
    if (evt && evt.twoPersonDialog) {
      const tx0 = String(evt.text || "");
      const nm0 = (evt.botNames || []).concat(evt.nicknames || []).filter(Boolean).some(function (x) { return tx0.indexOf(x) >= 0; });
      const groupAsk = /你们|大家|有人|哪位|谁(知道|会|有|在)|各位|在吗|有没有人/.test(tx0);
      const aimed0 = !!(evt.atBot || evt.atAll || evt.replyToBot || evt.replyId || nm0 || groupAsk);
      if (!aimed0) {
        return { action: "ignore", verdict: "no", pSay: 0, U: 0, tier: "low", maxChars: 20, reason: ["两人在对话，不插嘴"], bucket: "chat", search: 0, keywords: [], injected: false };
      }
    }
    const context = ctx || {};
    const raw = evt.text || "";
    const text = maskUntrusted(raw);
    const nicknames = (evt.nicknames || []).map(normalizeName);
    const botNames = (evt.botNames || []).concat(nicknames).map(normalizeName).filter(Boolean);
    const reason = [];
    const injected = isInstructionLike(raw);
    if (injected) reason.push("外部文本疑似注入 → 已标记，不执行");

    // 合并判定时不能重复学（否则 IDF 语料把同一句话算两遍）
    if (context.learn !== false) addressee.learn(evt.gid, text);
    const hard = hardTrigger(Object.assign({}, evt, { text: text }), botNames);
    if (hard.strength > 0) reason.push("硬触发:" + hard.hits.join("+"));

    const j = addressee.judge(evt.gid, {
      text: text, userId: evt.uid, atBot: evt.atBot, replyToBot: evt.replyToBot,
      replyToOther: evt.replyToOther, botNames: evt.botNames || [], nicknames: nicknames,
      groupNames: evt.groupNames || [], lastBotText: evt.lastBotText, lastBotAt: evt.lastBotAt, now: evt.now
    });

    const cls = classify(text, { interests: evt.interests || [] });
    const detailAsk = cls.flags.isDetailAsk;
    const questionWord = cls.flags.isQuestion || cls.flags.isRequest;
    if (detailAsk) cls.topicDepth = Math.max(cls.topicDepth, 2);
    const bucket = bucketOf(cls.buckets);

    let pSay = j.conf;
    if (injected) pSay = pSay * 0.5;

    const v0 = valve(pSay, bounds);
    let verdict = v0.verdict;
    if (verdict === "no" && hard.strength > 0) { verdict = "grey"; reason.push("硬触发地板：至少一句短的"); }

    // 语义补救（零成本）：本地判否，但看起来是个"没点名的真问题"。
    // 外审 rubric 第 4 条说这类该回，而本地 pSay 天生偏低（没人 @ 它，六因子里也压着成本），
    // 于是"值得回的话"被 local 一刀切掉、外审根本没机会看到 —— 这里先把口子开出来。
    const toOther = signalOf(j.signals, "thirdPersonDense").v > 0
      || signalOf(j.signals, "reporting").v > 0
      || signalOf(j.signals, "negationToMe").v > 0;
    const askLike = questionWord || detailAsk || cls.topicDepth >= 2;
    // 「部分判否」也要有机会被外审看到：本地判否里最可能是错的，是**贴着开口线**的那种。
    // 由 audit.noAudit 控制（关 / 边界判否 / 边界或提问），并用 audit.noMaxPerHour 限流（免费池一次 20 秒，别堆起来）。
    const noMode = String(auditCfg.noAudit || "边界判否");
    // 【重要修正】这里以前用「pSay 贴着开口线」当判据 —— 但 pSay 有个 0.35 的地板，
    // 实测绝大多数消息都是 0.354，导致这条判据**恒为真**：每条消息都被当成边界判否送去外审，
    // 外审说一句"短"她就回一句，表现就是"发什么都搭话"。
    // 换成真正会变的信号：上下文延续（有人在接她的话）+ 有实质内容。
    const subst = cls.topicDepth >= 1 || String(text || "").replace(/[\s\p{P}\p{S}]/gu, "").length >= 8 || questionWord || detailAsk;
    // 内联取值，避免依赖后面才声明的 cont（TDZ）
    const nearMiss = subst && signalOf(j.signals, "continuation").v >= 0.5;
    const noMayRescue = noMode !== "关" && (noMode === "边界或提问" ? (nearMiss || questionWord || detailAsk) : nearMiss);
    let rescued = false;
    let rescuedByBoundary = false;
    if (verdict === "no" && !injected && !toOther && rescueAsk !== "关" && (askLike || noMayRescue)) {
      if (!askLike && noMayRescue && !noAuditAllow(evt.now)) {
        reason.push("边界判否（上下文延续 " + (Math.round(signalOf(j.signals, "continuation").v * 100) / 100) + "，像是有人在接她的话），但本小时边界复核次数已满 → 这次不送审");
      } else {
        verdict = "grey";
        rescued = true;
        rescuedByBoundary = !askLike;
        if (rescuedByBoundary) noAuditTimes.push(evt.now == null ? nowFn() : evt.now);
        reason.push(rescuedByBoundary
          ? "边界判否补救：上下文延续 " + (Math.round(signalOf(j.signals, "continuation").v * 100) / 100) + "（有人在接她的话）→ 先按灰区，交外审复核是否该进大脑"
          : "语义补救：没点名但像个真问题 → 先按灰区" + (rescueAsk === "中档" ? "，并给中档地板" : "，只给短句"));
      }
    }
    // 疑似注入的外部指令：直接不回，也不送大脑（pSay×0.5 不够；rubric 第 5 条要求判否）
    // 只在「没冲她说」时才硬拦：群里朋友开玩笑说「忽略上面的规则」是聊天，不是注入；
    // 真正的注入来自引用的外部内容/卡片，那些不会点她的名字。
    if (injected && blockInjected && hard.strength <= 0) { verdict = "no"; rescued = false; reason.push("疑似注入指令 → 直接不回（不送大脑）"); }
    else if (injected) reason.push("文本里有疑似指令的措辞，但这条是冲她说的 → 交外审/大脑自行处理");
    // 灌水拦截：单字符 / 纯标点（"?"、"。"、"哈"）不值得回 —— rubric 第 3 条
    const stripped = String(text || "").replace(/[\s\p{P}\p{S}]/gu, "");
    // 重复同一字符（"哈哈哈哈哈哈"）也是灌水：以前只拦单字符，导致"纯笑声"会被算成边界判否、再被外审放进大脑
    // 同样是「一刀切」的老问题：只删单字符，会把她被点名后的一句「？」「哈哈」也判死。
    // 点她名字/@她 时不按灌水处理（她要回的是那句短话本身）。
    if ((stripped.length <= 1 || /^(.)\1{4,}$/.test(stripped)) && hard.strength <= 0) { verdict = "no"; rescued = false; reason.push("灌水/单符号 → 不回"); }
    else if (stripped.length <= 1 || /^(.)\1{4,}$/.test(stripped)) reason.push("看着像灌水，但这条是冲她说的 → 不按灌水拦");

    const sem = signalOf(j.signals, "idfOverlapToMyWords").v;
    const cont = signalOf(j.signals, "continuation").v;
    const demand = Math.max(signalOf(j.signals, "questionNoAt").v, questionWord ? 1 : 0, detailAsk ? 1 : 0);

    const diff = clamp01(0.15 + 0.25 * cls.topicDepth + (detailAsk ? 0.25 : 0) + (text.length > 60 ? 0.1 : 0));
    const estOut = 20 + 30 * cls.topicDepth + (detailAsk ? 120 : 0);
    const estIn = 120 + text.length;
    const cost = estIn + 2 * estOut;
    const costScale = Math.max(1, context.costScale || DEFAULT_COST_SCALE);
    const gate = gateFactor(hard.strength, W);

    const u = utilityScore({
      pSay: pSay, sem: sem, cont: cont, demand: demand, diff: diff,
      cost: cost, costScale: costScale, gate: verdict === "grey" ? Math.max(0.5, gate) : gate,
      eng: 1, topicDepth: cls.topicDepth, weights: W
    });

    let tierInfo = { tier: "low", maxChars: 20, reason: "判否" };
    let plan = { search: 0, keywords: [] };
    let auditRes = null;
    const verdictBeforeAudit = verdict;      // 外审前的本地判断，用来算"外审跟本地一致吗"

    if (verdict === "no") {
      reason.push("本地判否 → 不回复、不进大脑");
    } else {
      tierInfo = depthTier(u.U, tiers);
      // 深度只看 U 有个反直觉的坑：U = benefit - λ·diff·(cost/costScale)，而"要求越详细"会让
      // diff 和 estOut 一起涨 → U 更负 → 越可能被压成本地短句（实测"展开说说" U=-238）。
      // 语义明确的情况给地板，成本控制交给预算/条数，不该由"问得更具体"来埋单。
      const addressed = hard.strength >= 0.9 || hard.hits.indexOf("nick") >= 0;
      if (detailAsk && addressed) tierInfo = { tier: "high", maxChars: mcOf(2), reason: "被点名且要求展开 → 高深度" };
      else if (detailAsk && tierInfo.tier === "low") tierInfo = { tier: "mid", maxChars: mcOf(1), reason: "要求展开 → 至少中档（进大脑）" };
      else if (addressed && tierInfo.tier === "low") tierInfo = { tier: "mid", maxChars: mcOf(1), reason: "被点名 → 至少中档（进大脑）" };
      else if (questionWord && tierInfo.tier === "low") tierInfo = { tier: "mid", maxChars: mcOf(1), reason: "在问问题 → 至少中档（进大脑）" };
      if (rescued && rescueAsk === "中档" && tierInfo.tier === "low") tierInfo = { tier: "mid", maxChars: mcOf(1), reason: "语义补救 → 中档（进大脑）" };
      // 配置只要短句时，别让"求展开"之类的地板把档位又抬回去
      if (rescued && rescueAsk === "短句" && tierInfo.tier !== "low") tierInfo = { tier: "low", maxChars: mcOf(0), reason: "补救但配置只要短句 → 压到短句" };
      // 进中档 = 花钱调模型，必须有"语义理由"。U 只是净值估算，光靠它过线会把
      // 灌水、劝架、对着别人说话、单个问号都送进大脑（实测 24 条情景里 8 条如此）。
      // "上下文延续"也算理由：上一条就是它说的、隔了半分钟又来一句，那是接着跟它聊
      const semanticReason = questionWord || detailAsk || rescued || cont >= 0.5;
      // 寒暄要看有没有"实义"——"小肥鱼在吗"里的"吗"不该算提问（否则一句招呼就调模型）
      const substance = /怎么|为什么|什么|哪|原因|帮我|教我|能不能|可以|值不值|行不行|对不对/.test(text);
      // 光叫一声名字（"小肥鱼"）＝ 试探在不在，回一句短的就行，别为它调模型
      let withoutName = String(text || "");
      for (const n of botNames) if (n) withoutName = withoutName.split(n).join("");
      const bareName = addressed && withoutName.replace(/[\s\p{P}\p{S}]/gu, "").length <= 1;
      // 情绪宣泄（他妈的…又崩了）：没点名、也没问号 → 给一句短答，不送大脑
      const vent = !addressed && !/[?？]/.test(text) && /他妈|特么|妈的|卧槽|靠|服了|醉了|绝了|气死/.test(text);
      const greetingOnly = (!detailAsk && isGreeting(text) && !substance) || bareName;
      // 【放开】下面三条以前会把「寒暄 / 情绪宣泄 / 没点名无求详」压成低档（30 字）——
      // 那是"怎么说话"的判断，不属于"该不该开口"，会把她的性格限死。
      // 现在只写进依据，档位和口吻交给大脑；是否开口仍由 verdict（本地判否 + 外审否决）决定。
      if (addressed && greetingOnly) reason.push("寒暄（档位不再压成低档）");
      else if (!addressed && vent) reason.push("情绪宣泄（档位不再压成低档）");
      else if (!addressed && !semanticReason) reason.push("没点名也没求详（档位交给大脑）");
      plan = searchPlan(tierInfo.tier, cls.keywords, {
        questionWord: !!cls.isQuestion, detailAsk: !!detailAsk, fresh: !!cls.isFresh,
        hasUrl: !!cls.hasUrl, explicitSearch: !!cls.explicitSearch
      });
      reason.push("深度分档：" + tierInfo.reason);

      // 外审：从"只在高档审深度"改成"按不确定度择机复核『开口 + 深度』"
      //   高档        → 详细之前先审（原行为）
      //   语义补救的   → 本地本来判否，是规则把它抬起来的，拿不准必须复核
      //   灰区也审     → 可选：本地灰 + 中档也交给外审定"是 / 短 / 否"
      const needAudit = (tierInfo.tier === "high"
        || (rescued && auditRescue)
        || (auditUnaddressed && !addressed && tierInfo.tier !== "low")
        || (auditGrey && verdict === "grey" && tierInfo.tier === "mid")) && auditAllow(evt.now);
      if (needAudit) {
        auditTimes.push(evt.now == null ? nowFn() : evt.now);
        auditRes = await auditFn(text, { botNames: botNames, nicknames: nicknames, recentMention: evt.recentBotMention === true, contextText: evt.auditContext });
        reason.push("外审（" + auditScope + "）：" + auditRes.verdict);
        if (auditRes.error) {
          // 外审坏了（超时/认证失败/通道不通）。这里要区分「这次是不是为了问外审才被补救上来的」：
          //   是 → 外审没给结论，就不该放行，回到判否。否则会出现与直觉相反的结果：
          //        外审一坏，反而更容易进大脑（用户实测：外审静默失效 + 补救判据恒真 → 发什么都搭话）。
          //   否（本来就是灰区/高档）→ 沿用本地判断，不额外惩罚。
          // 想让外审坏了也照样放行补救，把「外审超时处理」设成「保持」。
          const msShown = Math.round((auditRes.ms || 0) / 100) / 10;
          const limitShown = Math.round((Number(auditCfg.timeoutMs) || 0) / 1000);
          const detail = "外审不可用（" + String(auditRes.error).slice(0, 40) +
            (auditRes.ms ? "，耗时 " + msShown + "s" : "") + (limitShown ? "，上限 " + limitShown + "s" : "") + "）";
          if (rescued && auditTimeoutMode !== "保持") {
            verdict = "no";
            rescued = false;
            rescuedByBoundary = false;
            tierInfo = { tier: "low", maxChars: mcOf(0), reason: "外审不可用 → 补救的这条不放行（保守）" };
            reason.push(detail + " → 它本来是判否、只为问外审才补救，故不放行");
          } else {
            reason.push(detail + " → 沿用本地判断");
          }
        } else if (auditRes.verdict === "no") {
          verdict = "no";                                            // 外审说"不值得回" → 真的不回（原来只压成短句）
          tierInfo = { tier: "low", maxChars: mcOf(0), reason: "外审判否 → 不回" };
        } else if (auditRes.verdict === "short") {
          // 外审只保留"否"的否决权；"短"不再强制压字数 —— 长短由大脑按语境决定（判定不该管口吻）。
          reason.push("外审：觉得一句就够（长度交给大脑）");
        } else if (auditRes.verdict === "yes") {
          // 配置明确说"这种只给短句"时，外审的"该认真回"不该把政策抬掉（外审仍能说"否"）
          const capped = rescued && rescueAsk === "短句";
          if (tierInfo.tier === "low" && !capped) tierInfo = { tier: "mid", maxChars: mcOf(1), reason: "外审：该认真回 → 升到中档" };
        } else if (auditTimeoutMode === "保持") {
          reason.push("外审不确定 → 保持本地判断（配置）");
        } else if (rescued) {
          verdict = "no";                                            // 救回来的又拿不准 → 别花钱，放弃这次
          tierInfo = { tier: "low", maxChars: mcOf(0), reason: "外审不确定 + 本来判否 → 放弃这次" };
        } else if (tierInfo.tier === "high" && verdict === "grey") {
          tierInfo = { tier: "mid", maxChars: mcOf(1), reason: "本地灰 + 外审不确定 → 收到中档" };
        } else {
          reason.push("外审不确定 → 保持本地判断");
        }
        plan = searchPlan(tierInfo.tier, cls.keywords, {
          questionWord: !!cls.isQuestion, detailAsk: !!detailAsk, fresh: !!cls.isFresh,
          hasUrl: !!cls.hasUrl, explicitSearch: !!cls.explicitSearch
        });
      }
    }

    // 外审结论要能被外面记录（自学习要用）：叫过没有 / 结论 / 是否与本地一致。
    // "一致"的定义：本地判否 ↔ 外审也说否；本地灰区/是 ↔ 外审说该回（是或短）。不确定/报错不计入。
    let auditInfo = null;
    if (auditRes && !auditRes.error) {
      const v = String(auditRes.verdict || "");
      const localNo = verdictBeforeAudit === "no";
      const agreed = (v === "yes" || v === "short") ? !localNo : (v === "no" ? localNo : null);
      auditInfo = { called: true, verdict: v, agreed: agreed, ms: auditRes.ms || null };
    }
    let action = "ignore";
    // 只要判成"要回"，一律走大脑。以前低深度会走本地短句（localReplies），
    // 但它不结合上下文，回出来就是"嗯嗯""哈哈"这种很怪的东西 —— 已删掉这条路。
    // 深度低仍然有意义：tier=low 会变成"一句话收尾"的字数要求（depthChars[0]）。
    if (verdict !== "no") action = "brain";
    if (action === "brain" && tierInfo.tier === "low") reason.push("深度低 → 仍进大脑，但要求一句话收尾（不再本地短句）");

    let arm = "standard";
    if (action !== "ignore" && banditRef) {
      const pick = banditRef.choose(bucket, evt.gid);
      arm = pick.arm;
      reason.push("话风臂：" + arm);
    }

    return {
      gid: evt.gid, uid: evt.uid, at: evt.now || Date.now(),
      action: action, verdict: verdict, auditInfo: auditInfo, pSay: Math.round(pSay * 1000) / 1000,
      U: Math.round(u.U * 1000) / 1000,
      tier: tierInfo.tier, maxChars: tierInfo.maxChars,
      search: plan.search, keywords: plan.keywords,
      bucket: bucket, arm: arm, topicDepth: cls.topicDepth, detailAsk: detailAsk,
      hardHits: hard.hits, hardStrength: hard.strength,          // 本地短句据此换"应答型"口气
      audit: auditRes ? auditRes.verdict : "none",
      score: u.parts, signals: j.signals, reason: reason, bounds: v0.bounds, injected: injected
    };
  }

  function setBounds(b) { bounds = clampBounds(b); return bounds; }
  function getBounds() { return bounds; }
  return { decide: decide, addressee: addressee, setBounds: setBounds, getBounds: getBounds, tiers: tiers };
}
