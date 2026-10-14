/* DSH-QQ 群小助手 · 配置端前端（零依赖，原生 JS） */
(function () {
  "use strict";

  var COLORS = ["#2f7ff0", "#12a37a", "#d9922b", "#e2564f", "#8b5cf6", "#0aa2c0", "#c9a227", "#7c8ea3"];

  var S = {
    table: null, values: null, runtime: null, defaults: null,
    dirty: false, page: "status",
    gid: null, groups: [], onebot: null, status: null, labels: null, memes: null
  };

  var PAGES = [
    { id: "status", name: "状态", icon: "◎" },
    { id: "persona", name: "人设", icon: "☺", group: "人设" },
    { id: "tune", name: "调整", icon: "⚙" },
    { id: "napcat", name: "接入", icon: "⇄", group: "接入" },
    { id: "profile", name: "群档案", icon: "▤" },
    { id: "extra", name: "额外功能", icon: "✦" },
    { id: "labels", name: "标注", icon: "✎" },
    { id: "memes", name: "图库", icon: "▣" },
    { id: "settings", name: "设置", icon: "⚒" }
  ];

  /* 「调整」页：把判定 / 主动与节流 / 运行时三组按逻辑重新分类 */
  var TUNE_CARDS = [
    { name: "开口与深度", desc: "决定「说不说」的开口线，和「说多深」的三档线；权重是六因子公式里的 w1~w4", keys: [
      "gates.utilitySpeakAt", "gates.utilityTerseAt", "gates.utilityDetailedAt", "gates.depthChars", "gates.utilityLambda", "gates.weights"] },
    { name: "灰区与上下文", desc: "灰色地带的下界与上界（自适应），以及每次送进大脑的群消息条数", keys: [
      "gates.greyLo", "gates.greyHi", "runtime.contextWindow"] },
    { name: "开口阶段", desc: "新群先只观察不发言，攒够条数转半自动，再转全自动", keys: [
      "runtime.stageMode", "runtime.observeUntilMessages", "runtime.semiAutoDays"] },
    { name: "节流与合并", desc: "同一个人连着发几条算一轮、回复最多拆几条、主动搭话多频", keys: [
      "runtime.coalesceWindowMs", "runtime.coalesceMaxBatch", "runtime.maxSegments", "autojoin.rate", "autojoin.minGapSec"] },
    { name: "预算与熔断", desc: "每天最多花多少 token；超 80% 关主动，超 100% 只回被点名的", keys: [
      "runtime.budget.dailyTokens", "runtime.budget.groupHourlyLimit"] },
    { name: "搜索", desc: "要不要在认真回答前先搜一次", keys: [
      "runtime.search.mode"] },
    { name: "权限与配置端", desc: "谁能发指令，以及配置端自己跑在哪", keys: [
      "admin.whitelist", "runtime.webui.enabled", "runtime.webui.port", "runtime.napcatWebui"] }
  ];

  /* 「额外功能」页：语音 / 图片（识图 + 表情包）—— 开关会直接改写人设 */
  var EXTRA_GROUPS = [
    { name: "语音", icon: "♪", desc: "用 Windows 自带 SAPI 把文字念成 wav，走 OneBot 的 record 段发出",
      master: "runtime.voice.enabled", keys: ["runtime.voice.enabled", "runtime.voice.voice", "runtime.voice.maxChars"],
      persona: "打开后会写进人设：允许在正文末尾写 [语音: 内容]" },
    { name: "识图", icon: "▨", desc: "收到图片时额外调一次多模态模型，把画面内容描述拼进上下文",
      master: "runtime.vision.enabled", keys: ["runtime.vision.enabled", "runtime.vision.mode", "runtime.vision.endpoint", "runtime.vision.apiKey", "runtime.vision.model"],
      persona: "打开后会写进人设：你看得到群里的图" },
    { name: "表情包", icon: "☺", desc: "配图频率（详细回答与管理指令一律不配图）",
      master: "persona.memeFreq", masterOff: "关", keys: ["persona.memeFreq"],
      persona: "设为「关」后人设里不再提配图，模型也就不会发 [表情: …]" }
  ];

  /* 【社区插件兼容】四张卡 */
  var PLUGIN_CARDS = [
    { id: "ourFreeModel", role: "二判通道",
      desc: "免费模型池。二判（外审）是独立通道，走它不占你付费额度。",
      installNote: "装进 app/dsh-home/profiles/qq-audit 并挂进 bundles",
      keys: ["plugins.ourFreeModel", "plugins.ourFreeModelId"] },
    { id: "ourFreeModel", role: "大脑通道",
      desc: "回复本体也走免费模型池。注意：免费池模型大多不认三档 effort，开了之后三档 overlay 会自动去掉 reasoningEffort。",
      installNote: "同一个插件，装在 app/dsh-home/profiles/qq-audit 即可复用",
      keys: ["plugins.ourFreeModelBrain", "plugins.ourFreeModelBrainId"] },
    { id: "freeSearch", role: "搜索通道",
      desc: "24 个搜索引擎 + 智能路由与故障回退。开着就用它的引擎，关掉用本程序内置的直搜（Bing/DDG）。",
      installNote: "装进 app/vendor，程序直接 import 它的引擎函数",
      keys: ["plugins.freeSearch", "plugins.freeSearchEngine"] },
    { id: "archify", role: "图表绘制",
      desc: "把结构/流程画成图（SVG→PNG）。大脑画好之后由程序把成品发进群。",
      installNote: "装完把 skills/archify 放进 app/dsh-home/skills",
      keys: ["plugins.archify", "plugins.archifyCleanup"] },
    { id: "meme", role: "表情包图库",
      desc: "本地表情包图库（按情绪标签 + 关键词检索）。",
      installNote: "在 DSH 桌面端装 dsh-meme，或自己攒一套图后用 meme.packDir 指过去",
      keys: ["plugins.meme", "meme.packDir", "persona.memeFreq"] }
  ];

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function getPath(o, d) {
    var cur = o, parts = String(d).split(".");
    for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  function setPath(o, d, v) {
    var parts = String(d).split("."), cur = o;
    for (var i = 0; i < parts.length - 1; i++) { if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = v;
    return o;
  }
  function api(p, body) {
    return fetch(p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)
      .then(function (r) { return r.json(); });
  }
  function toast(msg, bad) {
    var el = $("#toast");
    el.textContent = msg;
    el.style.borderLeftColor = bad ? "var(--bad)" : "var(--accent)";
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove("show"); }, 2400);
  }
  function markDirty() { S.dirty = true; $("#save-btn").disabled = false; $("#save-btn").textContent = "保存 *"; }
  function hhmmss(t) { var d = new Date(t); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2); }
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
    if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
    return String(n);
  }
  function shortText(t, max) {
    var s = String(t == null ? "" : t).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max) + "…" : s;
  }

  /* ---------- 字段渲染 ---------- */
  function fieldByKey(key) {
    var groups = (S.table && S.table.分组) || [];
    for (var i = 0; i < groups.length; i++) for (var j = 0; j < (groups[i].字段 || []).length; j++) {
      if (groups[i].字段[j].键 === key) return groups[i].字段[j];
    }
    return null;
  }

  function fieldRow(f) {
    var key = f.键, type = f.类型, value = getPath(S.values, key);
    var hint = f.说明 ? '<div class="hint">' + esc(f.说明) + '</div>' : '';
    var ctrl = "";
    if (type === "string[]") {
      var arr = Array.isArray(value) ? value : [];
      ctrl = '<div class="chips" data-chips="' + key + '">' + arr.map(function (t) {
        return '<span class="chip">' + esc(t) + '<b data-del="' + key + '" data-val="' + esc(t) + '">×</b></span>';
      }).join("") + '<input type="text" data-add="' + key + '" placeholder="+ 回车添加" style="min-width:130px;width:130px"></div>';
    } else if (type === "enum" || type === "bool") {
      var opts = f.取值 || (type === "bool" ? ["true", "false"] : []);
      var lbl = type === "bool" ? { "true": "开", "false": "关" } : null;
      ctrl = '<div class="seg" data-seg="' + key + '">' + opts.map(function (o) {
        return '<button data-val="' + esc(o) + '" class="' + (String(value) === String(o) ? "on" : "") + '">' + esc(lbl ? lbl[o] : o) + '</button>';
      }).join("") + '</div>';
    } else if (type === "secret") {
      ctrl = '<input type="password" data-key="' + key + '" value="" placeholder="' + (value ? "已配置（留空不改）" : "尚未配置") + '" autocomplete="new-password">';
    } else if (type === "int" || type === "number") {
      var rng = f.范围 || null;
      if (rng) {
        var step = type === "int" ? (rng[1] - rng[0] > 100000 ? 100000 : 1) : (rng[1] - rng[0] <= 2 ? 0.01 : 0.05);
        ctrl = '<input type="range" data-range="' + key + '" min="' + rng[0] + '" max="' + rng[1] + '" step="' + step + '" value="' + value + '">' +
          '<span class="val" data-val-for="' + key + '">' + value + '</span>';
      } else {
        ctrl = '<input type="number" data-key="' + key + '" value="' + value + '">';
      }
    } else if (type === "int[3]" || type === "number[4]") {
      var n = type === "int[3]" ? 3 : 4;
      var vals = Array.isArray(value) ? value.slice() : [];
      while (vals.length < n) vals.push(0);
      var names = type === "int[3]" ? ["短评", "总结", "详细"] : ["w1 p_say", "w2 语义", "w3 连续性", "w4 需求"];
      ctrl = '<div style="display:flex;gap:12px;flex-wrap:wrap">' + vals.map(function (v, i) {
        return '<div style="text-align:center"><input type="range" style="width:96px" data-arr="' + key + '" data-idx="' + i + '" min="0" max="' + (type === "int[3]" ? 400 : 1) +
          '" step="' + (type === "int[3]" ? 5 : 0.05) + '" value="' + v + '"><div style="font-size:11px;color:var(--dim)">' + names[i] + '</div>' +
          '<div class="val" data-arr-for="' + key + '-' + i + '">' + v + '</div></div>';
      }).join("") + '</div>';
    } else if (type === "text") {
      ctrl = '<textarea data-key="' + key + '" rows="4" placeholder="留空 = 用字段自动拼装">' + esc(value == null ? "" : value) + '</textarea>';
    } else {
      ctrl = '<input type="text" data-key="' + key + '" value="' + esc(value == null ? "" : value) + '">';
    }
    return '<div class="field"><div class="label">' + esc(f.标签 || key) + '</div>' + hint + '<div class="ctrl">' + ctrl + '</div></div>';
  }

  function renderGroupFields(groupName) {
    var g = ((S.table && S.table.分组) || []).filter(function (x) { return x.名 === groupName; })[0];
    if (!g) return '<div class="muted">没有这一组</div>';
    return (g.字段 || []).map(fieldRow).join("");
  }

  function renderTune() {
    var used = {};
    var cards = TUNE_CARDS.map(function (c) {
      var rows = "";
      for (var i = 0; i < c.keys.length; i++) {
        var f = fieldByKey(c.keys[i]);
        if (!f) continue;
        used[c.keys[i]] = true;
        rows += fieldRow(f);
      }
      if (!rows) return "";
      return '<details class="card" open><summary>' + esc(c.name) +
        '<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">' + c.keys.length + ' 项</span></summary>' +
        '<div class="body"><div class="hint" style="margin:-4px 0 2px">' + esc(c.desc) + '</div>' + rows + '</div></details>';
    }).join("");
    // 三张表里没被分类收进去的，兜底放「其它」
    // 兜底：这三张表里没被分类收进去的，放「其它」。
    // 人设与接入有自己的页面，这里不重复放（只有 persona.memeFreq 被「表情包」卡收走了）。
    var left = "";
    ["判定", "主动与节流", "运行时"].forEach(function (gn) {
      var g = ((S.table && S.table.分组) || []).filter(function (x) { return x.名 === gn; })[0];
      if (!g) return;
      (g.字段 || []).forEach(function (f) { if (!used[f.键]) left += fieldRow(f); });
    });
    if (left) cards += '<details class="card"><summary>其它' + '</summary><div class="body">' + left + '</div></details>';
    return cards;
  }

  /* ---------- 状态页 ---------- */
  function stageText(st) {
    if (!st) return "未知";
    if (st.forced) return st.stage === "observe" ? "强制观察" : "强制实际发送";
    var m = { observe: "观察中", semi: "半自动", full: "全自动" };
    var t = m[st.stage] || st.stage;
    if (st.stage === "observe") t += "（已收 " + (st.observed || 0) + " 条）";
    return t;
  }

  function statusHtml() {
    var st = S.status;
    if (!st) return '<div class="card"><div class="body"><div class="muted">加载中…</div></div></div>';
    var c = st.cost || {}, b = st.budget || {}, ob = S.onebot || {};
    var gs = st.group || {};
    var budgetMax = 20000000;
    var limit = b.limit != null ? b.limit : 5000000;

    // 群选择 + 快捷按钮
    var opts = '<option value="">全部群</option>' + S.groups.map(function (g) {
      var name = g.group_name ? (g.group_name + "（" + g.group_id + "）") : ("群 " + g.group_id);
      return '<option value="' + esc(g.group_id) + '"' + (String(S.gid) === String(g.group_id) ? " selected" : "") + '>' + esc(name) + '</option>';
    }).join("");
    var enabled = S.gid ? (st.brakes && !(st.brakes.groups && st.brakes.groups[String(S.gid)]) && !st.brakes.stopFile && !st.brakes.configPaused) : null;
    var stageNow = (st.stage && st.stage.stage) || "";

    var bar = '<div class="card"><div class="head"><span>控制台</span>' +
      '<span class="muted" style="font-size:12px">' + esc(ob.state === "open" ? "OneBot 已连接" : "OneBot " + (ob.state || "未知")) + '</span></div><div class="body">' +
      '<div class="ctl-row">' +
      '<button class="btn-sm" id="btn-refresh">刷新</button>' +
      (S.gid ? (stageNow === "observe"
        ? '<button class="btn-sm good" id="btn-skip-observe" title="不再等 80 条，本群直接进全自动">跳过观察期</button>'
        : '<button class="btn-sm" id="btn-back-observe" title="交回阶段机，重新按观察期来">回到观察</button>') : "") +
      '<button class="btn-sm good" id="btn-enable"' + (S.gid ? "" : " disabled") + '>启用本群</button>' +
      '<button class="btn-sm bad" id="btn-disable"' + (S.gid ? "" : " disabled") + '>停用本群</button>' +
      '<button class="btn-sm bad" id="btn-global-stop">全局停用</button>' +
      '<button class="btn-sm good" id="btn-global-resume">恢复全局</button>' +
      '<button class="btn-sm" id="btn-napcat">NapCat 配置</button>' +
      '</div>' +
      (S.gid ? '<div class="hint" style="margin-top:8px">本群当前：<b>' + (enabled ? "服务中" : "已停用") + '</b>　开口阶段：<b>' + esc(stageText(st.stage)) + '</b>' + (st.stage && st.stage.skippedStage ? '　<span style="color:var(--warn)">（管理员手动跳过，点「回到观察」可恢复）</span>' : '') + '</div>' : '<div class="hint" style="margin-top:8px">当前显示<b>全部群</b>的汇总；选一个群可以单独看它的消息与判定过程</div>') +
      '</div></div>';

    // 成本卡片（预算卡片带调节杆）
    var cost = '<div class="grid">' +
      '<div class="stat"><div class="k">今日用量（token 单位）</div><div class="v">' + fmtTokens(c.units) + '</div>' +
        '<div class="s">预算 ' + fmtTokens(limit) + '　已用 ' + Math.round((b.ratio || 0) * 100) + '%　' + esc(b.mode || "normal") + '</div></div>' +
      '<div class="stat"><div class="k">缓存命中率</div><div class="v">' + (c.cacheHitRate == null ? "—" : Math.round(c.cacheHitRate * 100) + "%") + '</div>' +
        '<div class="s">人设常驻 personaPrefix 吃到的前缀命中</div></div>' +
      '<div class="stat"><div class="k">今日回复</div><div class="v">' + (c.replies || 0) + '</div>' +
        '<div class="s">收 ' + (c.messages || 0) + " 条　搜 " + (c.searches || 0) + " 次　配图 " + (c.memes || 0) + " 张</div></div>" +
      '<div class="stat"><div class="k">平均每条回复</div><div class="v">' + fmtTokens(c.avgUnitsPerReply) + '</div>' +
        '<div class="s">输入 ' + fmtTokens(c.inTokens) + "　输出 " + fmtTokens(c.outTokens) + '</div></div>' +
      '</div>';

    var budgetCard = '<div class="card"><div class="head">日预算调节' +
      '<span class="muted" style="font-size:12px">管理员随手调，立即生效</span></div><div class="body">' +
      '<div class="ctl-row"><input type="range" id="budget-range" min="0" max="' + budgetMax + '" step="100000" value="' + limit + '" style="width:320px">' +
      '<span class="val" id="budget-val" style="min-width:96px">' + fmtTokens(limit) + '</span>' +
      '<button class="btn-sm good" id="btn-budget">应用</button>' +
      '<span class="hint" style="margin:0">超 80% 关主动，超 100% 只回被点名的</span></div>' +
      '</div></div>';

    // 消息 + 判定过程
    var rows = (st.messages || []).map(function (m) {
      var v = m.verdict || "?";
      var cls = v === "yes" ? "yes" : v === "no" ? "no" : "grey";
      var reason = Array.isArray(m.reason) ? m.reason.join("；") : "";
      return '<tr><td style="white-space:nowrap">' + hhmmss(m.at) + '</td>' +
        '<td style="white-space:nowrap">' + esc(m.speaker || m.uid || "") + '</td>' +
        '<td>' + esc(shortText(m.text, 70)) + (m.hasImage ? ' <span class="tag">图×' + (m.images || 1) + '</span>' : '') + '</td>' +
        '<td><span class="tag ' + cls + '">' + esc(v) + '</span></td>' +
        '<td>' + esc(m.action || "-") + '</td>' +
        '<td>' + (m.pSay == null ? "-" : Number(m.pSay).toFixed(2)) + '</td>' +
        '<td>' + esc(m.tier || "-") + '</td>' +
        '<td class="muted" style="max-width:280px">' + esc(shortText(reason, 60)) + '</td></tr>';
    }).join("");
    var msgCard = '<div class="card"><div class="head">收到的消息与判定过程' +
      '<span class="muted" style="font-size:12px">最近 ' + (st.messages || []).length + ' 条（内存缓冲，重启即清）</span></div><div class="body">' +
      '<table><thead><tr><th>时间</th><th>谁</th><th>消息</th><th>判定</th><th>动作</th><th>p_say</th><th>档位</th><th>依据</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8" class="muted">还没有收到消息</td></tr>') + '</tbody></table></div></div>';

    var groupCard = S.gid ? ('<div class="card"><div class="head">本群累计（本次运行）</div><div class="body">' +
      '<div class="grid">' +
      '<div class="stat"><div class="k">收到消息</div><div class="v">' + (gs.messages || 0) + '</div><div class="s">含合并</div></div>' +
      '<div class="stat"><div class="k">发出回复</div><div class="v">' + (gs.replies || 0) + '</div><div class="s">进大脑 ' + (gs.brainCalls || 0) + ' 次</div></div>' +
      '<div class="stat"><div class="k">本群用量</div><div class="v">' + fmtTokens(gs.tokens) + '</div><div class="s">搜索 ' + (gs.searches || 0) + '　配图 ' + (gs.memes || 0) + '</div></div>' +
      '<div class="stat"><div class="k">最近活动</div><div class="v" style="font-size:18px">' + (gs.lastAt ? hhmmss(gs.lastAt) : "—") + '</div><div class="s">本群最后一条</div></div>' +
      '</div></div></div>') : "";

    // 分组用量
    var per = (c.perGroup || []).filter(function (x) { return x.units > 0; });
    var perCard = per.length ? ('<div class="card"><div class="head">今日各群用量</div><div class="body"><table><thead><tr><th>群</th><th>用量</th><th>回复</th><th>消息</th></tr></thead><tbody>' +
      per.map(function (x) {
        return '<tr><td>' + esc(x.gid) + '</td><td>' + fmtTokens(x.units) + '</td><td>' + x.replies + '</td><td>' + x.messages + '</td></tr>';
      }).join("") + '</tbody></table></div></div>') : "";

    return bar + cost + budgetCard + groupCard + msgCard + perCard;
  }

  /* ---------- 标注 / 图库 ---------- */
  function pageLabels() {
    return api("/api/labels?limit=60").then(function (d) {
      S.labels = d;
      var st = d.stats || {};
      var rows = (d.pending || []).map(function (r) {
        return '<tr><td style="max-width:340px">' + esc(r.text || "") + '</td>' +
          '<td><span class="tag ' + esc(r.localVerdict) + '">' + esc(r.localVerdict || "") + '</span></td>' +
          '<td>' + esc(r.localAction || "") + '</td>' +
          '<td>' + (r.pSay == null ? "" : Number(r.pSay).toFixed(3)) + '</td>' +
          '<td style="white-space:nowrap"><button class="btn-sm good" data-label="' + esc(r.id) + '" data-human="该回">该回</button> ' +
          '<button class="btn-sm bad" data-label="' + esc(r.id) + '" data-human="不该回">不该回</button></td></tr>';
      }).join("");
      return '<div class="grid">' +
        card("待标注", (d.pending || []).length, "满 30 条自动回流标定") +
        card("已标注", (d.labeled || []).length, "") +
        card("一致率", Math.round((st.agreement || 0) * 100) + "%", "") +
        card("漏接率", Math.round((st.missedRate || 0) * 100) + "%", "该回却被判否") +
        '</div>' +
        '<div class="card"><div class="head">待标注队列</div><div class="body"><table><thead><tr><th>消息</th><th>本地判定</th><th>动作</th><th>p_say</th><th>标注</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5" class="muted">队列是空的 —— 新群观察期会自动攒</td></tr>') + '</tbody></table></div></div>';
    });
  }

  function pageMemes() {
    return api("/api/memes").then(function (d) {
      S.memes = d;
      if (!d.ready) return '<div class="card"><div class="body"><div class="muted">没找到 dsh-meme 图库。</div></div></div>';
      var tags = (d.tags || []).map(function (t) { return '<button class="btn-sm" data-tag="' + esc(t) + '">' + esc(t) + '</button>'; }).join(" ");
      var items = (d.items || []).map(function (it) {
        return '<div class="meme"><img loading="lazy" src="' + it.url + '" alt="' + esc(it.caption) + '"><div class="cap"><b>' + esc(it.tag) + '</b><br>' + esc(it.caption || it.file) + '</div></div>';
      }).join("");
      return '<div class="card"><div class="head">图库<span class="muted" style="font-size:12px">' + esc(d.pack || "") + '</span></div><div class="body">' +
        '<div>' + tags + '</div><div class="gallery">' + items + '</div></div></div>';
    });
  }

  /* 人设页：全局人设（进系统提示词）+ 本群专属人设（只进这个群的消息体） */
  function pagePersona() {
    var head = '<details class="card" open><summary>全局人设' +
      '<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">进大脑系统提示词</span></summary><div class="body">' +
      '<div class="hint" style="margin:-2px 0 6px">这一整段会写进大脑 profile 的 <code>personaPrefix</code>（排在所有工具说明之前，吃满前缀缓存）。**留空**则用下面的字段自动拼装。</div>' +
      renderGroupFields("人设") +
      '</div></details>';
    var groupCardHtml = '<details class="card" open><summary>群聊专属人设' +
      '<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">只对这个群生效</span></summary><div class="body" id="group-persona-body">' +
      '<div class="muted">加载中…</div></div></details>';
    if (!S.gid) {
      return Promise.resolve(head + '<div class="card"><div class="body"><div class="muted">想写「某个群专属的人设」？先在右上角选一个群。</div>' +
        '<div class="hint" style="margin-top:6px">说明：全局人设走系统提示词（可缓存）；每群专属人设只能走消息体 —— 否则每个群都要一份 profile，一改就打散缓存。</div></div></div>');
    }
    return api("/api/profile?gid=" + encodeURIComponent(S.gid)).then(function (d) {
      var pt = (d.profile && d.profile.personaText) || "";
      return head + '<details class="card" open><summary>群聊专属人设' +
        '<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">群 ' + esc(S.gid) + ' 只对这个群生效</span></summary><div class="body">' +
        '<textarea id="persona-group" rows="5" placeholder="在这个群里额外要遵守的（语气/称呼/忌讳），留空则不额外加">' + esc(pt) + '</textarea>' +
        '<div class="ctl-row"><button class="btn-sm good" id="btn-save-group-persona">保存本群人设</button>' +
        '<span class="hint" style="margin:0">保存后立刻生效：它会作为【本群专属人设】拼进这个群每一轮的消息体</span></div>' +
        '</div></details>';
    });
  }

  /* 群档案页：管理员可以直接改提炼结果 */
  function linesOf(v) {
    return String(v || "").split(/[\n,，、;；]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function pageProfile() {
    if (!S.gid) return Promise.resolve('<div class="card"><div class="body"><div class="muted">先在右上角选一个群，才能看它的群档案。</div></div></div>');
    return api("/api/profile?gid=" + encodeURIComponent(S.gid)).then(function (d) {
      var p = d.profile || {};
      if (!d.profile) {
        return '<div class="card"><div class="body"><div class="muted">群 ' + esc(S.gid) + ' 还没有群档案。</div>' +
          '<div class="hint" style="margin-top:6px">群档案由大脑每 20 次回复（refN）自动重炼一次；你也可以直接在这里手写一份。</div>' +
          '<div class="ctl-row" style="margin-top:10px"><button class="btn-sm good" id="btn-create-profile">现在就建一份</button></div></div></div>';
      }
      var meta = '<div class="hint" style="margin:-2px 0 8px">重炼 ' + (p.rounds || 0) + ' 轮　最后更新 ' + esc(p.updatedAt || "—") + '　' + esc(p.updatedBy === "admin" ? "（管理员手改过）" : "（大脑自动提炼）") + '</div>';
      return '<div class="card"><div class="head">群 ' + esc(S.gid) + ' 的群档案' +
        '<span class="muted" style="font-size:12px">保存后立刻生效</span></div><div class="body">' + meta +
        '<div class="field"><div class="label">常聊、容易接话的话题</div><div class="hint">一行一个（也可用逗号/顿号分隔）</div>' +
          '<div class="ctrl"><textarea id="pf-interests" rows="4" style="width:420px">' + esc((p.interests || []).join("\n")) + '</textarea></div></div>' +
        '<div class="field"><div class="label">容易冷场或反感的话题</div><div class="hint">一行一个</div>' +
          '<div class="ctrl"><textarea id="pf-dislikes" rows="3" style="width:420px">' + esc((p.dislikes || []).join("\n")) + '</textarea></div></div>' +
        '<div class="field"><div class="label">说话习惯</div><div class="ctrl"><input type="text" id="pf-habits" value="' + esc(p.habits || "") + '"></div></div>' +
        '<div class="field"><div class="label">其它注意</div><div class="ctrl"><input type="text" id="pf-notes" value="' + esc(p.notes || "") + '"></div></div>' +
        '<div class="field"><div class="label">本群节奏</div><div class="ctrl"><input type="text" id="pf-pace" value="' + esc(p.pace || "") + '"></div></div>' +
        '<div class="field"><div class="label">活跃时段</div><div class="ctrl"><input type="text" id="pf-active" value="' + esc(p.activeHours || "") + '"></div></div>' +
        '<div class="ctl-row"><button class="btn-sm good" id="btn-save-profile">保存群档案</button>' +
        '<button class="btn-sm bad" id="btn-clear-profile">清空（让大脑重新提炼）</button></div>' +
        '</div></div>' +
        '<details class="card"><summary>这一份档案实际拼进 prompt 的样子</summary><div class="body"><pre class="pre">' + esc(d.prompt || "（空）") + '</pre></div></details>';
    });
  }

  /* 额外功能页 */
  function renderExtra() {
    var intro = '<div class="card"><div class="body"><div class="hint" style="margin:0">' +
      '这里的开关不只控制程序行为，<b>还会重新生成人设</b>：关掉的功能不会出现在人设里，模型就不会去用它；打开才写进去。保存后下一轮大脑调用生效。</div></div></div>';

    var builtin = EXTRA_GROUPS.map(function (g) {
      var masterVal = getPath(S.values, g.master);
      var on = g.masterOff ? String(masterVal) !== g.masterOff : masterVal === true;
      var rows = g.keys.map(function (k) { var f = fieldByKey(k); return f ? fieldRow(f) : ""; }).join("");
      return '<details class="card" open><summary>' + g.icon + ' ' + esc(g.name) +
        '<span class="pill ' + (on ? "ok" : "warn") + '" style="margin-left:auto;font-weight:400">' + (on ? "已开启" : "已关闭") + '</span></summary>' +
        '<div class="body"><div class="hint" style="margin:-2px 0 4px">' + esc(g.desc) + '</div>' +
        '<div class="hint" style="margin:0 0 8px;color:var(--accent-deep)">人设影响：' + esc(g.persona) + '</div>' +
        rows + '</div></details>';
    }).join("");

    return api("/api/plugins").then(function (d) {
      S.plugins = d;
      var byId = {};
      (d.items || []).forEach(function (x) { byId[x.id] = x; });
      var seen = {};
      var community = PLUGIN_CARDS.map(function (c) {
        var it = byId[c.id] || { id: c.id, name: c.id, ready: false, installed: false, detail: "没有探测结果" };
        // 同一个插件被两张卡复用（二判 / 大脑）时，名字后面标一下是哪一路
        var title = seen[c.id] ? (it.name + "（" + esc(c.role) + "）") : it.name;
        seen[c.id] = true;
        var pill = it.ready ? '<span class="pill ok">已就绪</span>'
          : (it.installed ? '<span class="pill warn">装了没生效</span>' : '<span class="pill bad">未安装</span>');
        var rows = c.keys.map(function (k) { var f = fieldByKey(k); return f ? fieldRow(f) : ""; }).join("");
        var meta = '<div class="hint" style="margin:-2px 0 6px">' +
          (it.version ? ('版本 ' + esc(it.version) + '　') : "") +
          (it.count ? (esc(it.count) + ' 张图　') : "") +
          (it.engine ? ('引擎 ' + esc(it.engine) + '　') : "") +
          (it.model ? ('模型 ' + esc(it.model) + '　') : "") +
          esc(it.detail || "") + '</div>';
        var btn = it.ready ? "" : '<div class="ctl-row" style="margin-top:8px"><button class="btn-sm good" data-pluginfix="' + esc(c.id) + '">一键安装</button>' +
          '<span class="hint" style="margin:0">' + esc(c.installNote || "") + '</span></div>';
        return '<details class="card" open><summary>' + title +
          '<span class="pill" style="margin-left:auto;font-weight:400">' + esc(c.role) + '</span>' + pill + '</summary>' +
          '<div class="body"><div class="hint" style="margin:-2px 0 6px">' + esc(c.desc) + '</div>' + meta + rows + btn + '</div></details>';
      }).join("");

      var logBox = S.pluginLog ? '<pre class="pre">' + esc(S.pluginLog) + '</pre>' : "";
      return intro +
        '<div class="sec-title">内置额外功能</div>' + builtin +
        '<div class="sec-title">社区插件兼容</div>' +
        '<div class="card"><div class="body"><div class="hint" style="margin:0">下面是社区做的 DSH 插件。本程序<b>不打包</b>它们（体积、许可证，而且本该由 DSH 那边管），只做兼容与接线：没装的点「一键安装」，装好就能用；没装或关掉就退回内置实现。<b>任何开关改动保存后都会重新生成全局人设</b>——关掉的能力不会写进人设，模型也就不会去用。</div>' + logBox + '</div></div>' +
        community;
    });
  }

  /* 设置页：git 更新 + 依赖体检 */
  function pageSettings() {
    S.update = S.update || null;
    S.deps = S.deps || null;
    function updHtml() {
      var u = S.update;
      if (!u) return '<div class="muted">点「检查更新」看看仓库里有没有新版。</div>';
      if (!u.ok && !u.isRepo) return '<div class="bad">' + esc(u.error || "不是 git 仓库") + '</div>';
      if (!u.ok) return '<div class="bad">' + esc(u.error || "检查失败") + (u.detail ? '<pre class="pre" style="margin-top:8px">' + esc(u.detail) + '</pre>' : "") + '</div>';
      var badge = u.upToDate ? '<span class="pill ok">已是最新</span>' : '<span class="pill warn">落后 ' + u.behind + ' 个提交</span>';
      var list = (u.incoming || []).length ? '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12.5px;color:var(--dim)">看看这 ' + u.incoming.length + ' 个提交是什么</summary><pre class="pre" style="margin-top:6px">' + esc(u.incoming.join("\n")) + '</pre></details>' : "";
      var warn = u.info.dirty ? '<div class="hint" style="color:var(--warn);margin-top:8px">本地有未提交改动（' + (u.info.dirtyFiles || []).length + ' 个文件），一键更新会被拒绝。先处理干净再更新。</div>' : "";
      return '<div class="ctl-row"><span style="font-weight:600">' + esc(u.info.branch) + ' @ ' + esc(u.info.head) + '</span>' + badge +
        '<span class="muted" style="font-size:12px">' + esc(u.info.subject) + '</span></div>' +
        '<div class="hint" style="margin-top:6px">远端 ' + esc(u.remote + "/" + u.branch) + ' @ ' + esc(u.remoteHead || "?") + '（本地领先 ' + u.ahead + '）</div>' + warn + list;
    }
    function depsHtml() {
      var d = S.deps;
      if (!d) return '<div class="muted">点「重新检测」看看缺什么。</div>';
      var rows = (d.items || []).map(function (it) {
        var cls = it.ok ? "yes" : (it.required ? "no" : "grey");
        var label = it.ok ? "就绪" : (it.required ? "缺（必需）" : "缺（可选）");
        var btn = it.ok ? "" : '<button class="btn-sm good" data-depfix="' + esc(it.id) + '">' +
          (it.fix && it.fix.kind === "winget" ? "一键安装" : it.fix && it.fix.kind === "url" ? "打开下载页" : "看怎么装") + '</button>';
        return '<tr><td><b>' + esc(it.name) + '</b>' + (it.required ? ' <span class="tag no">必需</span>' : ' <span class="tag">可选</span>') + '</td>' +
          '<td><span class="tag ' + cls + '">' + label + '</span></td>' +
          '<td class="muted">' + esc(it.version || "—") + '</td>' +
          '<td>' + esc(it.detail || "") + (it.fix && it.fix.note && !it.ok ? '<div class="hint" style="margin:3px 0 0">' + esc(it.fix.note) + '</div>' : "") + '</td>' +
          '<td style="white-space:nowrap">' + btn + '</td></tr>';
      }).join("");
      var miss = (d.missingRequired || []).length;
      return (miss ? '<div class="hint" style="color:var(--bad);margin-bottom:8px">还有 ' + miss + ' 项必需的没就绪，小助手现在还不能正常干活。</div>' : '<div class="hint" style="color:var(--ok);margin-bottom:8px">必需的都齐了。</div>') +
        '<table><thead><tr><th>依赖</th><th>状态</th><th>版本</th><th>说明</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        (S.depLog ? '<pre class="pre" style="margin-top:10px">' + esc(S.depLog) + '</pre>' : "");
    }
    return '<details class="card" open><summary>从 git 仓库更新<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">' +
      (S.update && S.update.ok && !S.update.upToDate ? "有新版可以拉" : "一键拉取最新代码") + '</span></summary><div class="body">' +
      '<div class="ctl-row"><button class="btn-sm" id="btn-update-check">检查更新</button>' +
      '<button class="btn-sm good" id="btn-update-apply">一键更新</button>' +
      '<span class="hint" style="margin:0">更新成功后要重启程序（或点托盘里的「重启」）</span></div>' +
      '<div id="update-body" style="margin-top:10px">' + updHtml() + '</div></div></details>' +
      '<details class="card" open><summary>依赖体检<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">运行这台机器需要什么</span></summary><div class="body">' +
      '<div class="ctl-row"><button class="btn-sm" id="btn-deps-check">重新检测</button></div>' +
      '<div id="deps-body" style="margin-top:10px">' + depsHtml() + '</div></div></details>' +
      '<div class="card"><div class="body"><div class="hint" style="margin:0">说明：程序本体只依赖 Node 自带模块（零 npm 依赖）；上面列的是<b>外部</b>依赖。' +
      '「一键安装」只走白名单动作（打开官方下载页 / winget 装 ffmpeg），不会执行任意命令。</div></div></div>';
  }

  /* 接入页：先看连接状态，再改参数 */
  function pageNapcat() {
    var ob = S.onebot || {};
    var stText = { idle: "未连接", connecting: "连接中", open: "已连接", closed: "已断开", reconnecting: "重连中", error: "连接出错", rejected: "被服务端拒绝", stopped: "已停止", unknown: "未知" };
    var cls = ob.state === "open" ? "ok" : (ob.state === "connecting" || ob.state === "reconnecting" ? "warn" : "bad");
    var mismatch = !!(ob.url && ob.savedUrl && ob.url !== ob.savedUrl);
    var tokenMismatch = !!(ob.tokenSet !== ob.savedTokenSet);
    var status = '<div class="card"><div class="head">OneBot / NapCat 连接' +
      '<span class="pill ' + cls + '" style="font-weight:400">' + esc(stText[ob.state] || ob.state || "未知") + '</span></div><div class="body">' +
      '<div class="field"><div class="label">正在连的地址</div><div class="ctrl"><code>' + esc(ob.url || "（还没连）") + '</code></div></div>' +
      '<div class="field"><div class="label">配置里保存的地址</div><div class="ctrl"><code>' + esc(ob.savedUrl || "—") + '</code></div></div>' +
      '<div class="field"><div class="label">Token</div><div class="hint">NapCat 的 WebSocket 服务端那一栏</div><div class="ctrl">' +
        '<span class="tag ' + (ob.tokenSet ? "yes" : "grey") + '">' + (ob.tokenSet ? "运行中：已带 token" : "运行中：无 token") + '</span>' +
        '<span class="tag ' + (ob.savedTokenSet ? "yes" : "grey") + '">' + (ob.savedTokenSet ? "配置：已设置" : "配置：空") + '</span></div></div>' +
      (ob.error ? '<div class="hint" style="color:var(--bad)">服务端回话：' + esc(ob.error) + '</div>' : "") +
      ((mismatch || tokenMismatch) ? '<div class="hint" style="color:var(--warn)">运行中的客户端还在用旧设置 —— 点下面的「重连」立刻生效，不用重启程序</div>' : "") +
      (ob.state === "open" ? '<div class="hint" style="color:var(--ok)">已连上' + (ob.nickname ? "：" + esc(ob.nickname) + "(" + esc(ob.selfId) + ")" : "") + (ob.version ? "　" + esc(ob.version) : "") + '</div>' : "") +
      (!ob.url ? '<div class="hint">还没连接过 —— 先填好下面的地址，再点「重连」。</div>' : "") +
      '<div class="ctl-row" style="margin-top:10px"><button class="btn-sm good" id="btn-reconnect">重连 OneBot</button>' +
      '<button class="btn-sm" id="btn-napcat">打开 NapCat 配置页</button>' +
      '<span class="hint" style="margin:0">NapCat 的 OneBot 端口常见是 <code>3001</code>；<code>6099</code> 是它的网页控制台，不是这个</span></div>' +
      '</div></div>';
    return status + '<details class="card" open><summary>接入参数<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">改完点保存（接入类会自动重连）</span></summary><div class="body">' +
      renderGroupFields("接入") + '</div></details>';
  }

  function card(k, v, s) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div><div class="s">' + esc(s || "") + '</div></div>';
  }

  /* ---------- 渲染 ---------- */
  function render() {
    renderGroupSelect();
    $("#nav").innerHTML = PAGES.map(function (p) {
      return '<a href="#" data-page="' + esc(p.id) + '" class="' + (S.page === p.id ? "active" : "") + '">' +
        '<span style="width:16px;text-align:center;opacity:.85">' + p.icon + '</span>' + esc(p.name) + '</a>';
    }).join("");
    var meta = PAGES.filter(function (p) { return p.id === S.page; })[0] || PAGES[0];
    $("#page-title").textContent = meta.name;
    var job;
    if (S.page === "status") job = api("/api/status" + (S.gid ? "?gid=" + encodeURIComponent(S.gid) : "")).then(function (st) { S.status = st; return statusHtml(); });
    else if (S.page === "tune") job = Promise.resolve(renderTune());
    else if (S.page === "persona") job = pagePersona();
    else if (S.page === "profile") job = pageProfile();
    else if (S.page === "extra") job = Promise.resolve(renderExtra());
    else if (S.page === "settings") job = Promise.resolve(pageSettings());
    else if (S.page === "napcat") job = Promise.resolve(pageNapcat());
    else if (S.page === "labels") job = pageLabels();
    else if (S.page === "memes") job = pageMemes();
    else job = Promise.resolve(renderGroupFields(meta.group));
    job.then(function (html) {
      $("#page").innerHTML = html;
      if (S.page === "settings") loadSettings();
    }).catch(function (e) {
      $("#page").innerHTML = '<div class="card"><div class="body">加载失败：' + esc(e.message) + '</div></div>';
    });
  }

  function badges() {
    var out = [];
    var ob = S.onebot || {};
    var st = S.status || {};
    var stText = { idle: "未连接", connecting: "连接中", open: "已连接", closed: "已断开", reconnecting: "重连中", error: "连接出错", stopped: "已停止", unknown: "未知" };
    var stCls = ob.state === "open" ? "ok" : (ob.state === "error" || ob.state === "closed" ? "bad" : "warn");
    out.push('<span class="pill ' + stCls + '">OneBot ' + esc(stText[ob.state] || ob.state || "未知") + '</span>');
    if (ob.state === "open") {
      out.push('<span class="pill">登录 ' + esc(ob.nickname || "?") + '(' + esc(ob.selfId || "?") + ')</span>');
      out.push('<span class="pill ' + (ob.version ? "ok" : "warn") + '">' + esc(ob.version || "NapCat 版本未知") + '</span>');
      out.push('<span class="pill ' + (ob.online ? "ok" : "warn") + '">' + (ob.online ? "在线" : "离线") + '</span>');
    }
    var modeText = st.mode === "observe" ? "观察模式" : st.mode === "auto" ? "自动分阶段" : st.mode === "live" ? "实际发送" : "—";
    out.push('<span class="pill ' + (st.mode === "live" ? "ok" : "warn") + '">' + modeText + '</span>');
    if (st.budget) out.push('<span class="pill">今日 ' + fmtTokens(st.budget.used) + ' / ' + fmtTokens(st.budget.limit) + '</span>');
    out.push('<span class="pill" id="pill-napcat" style="cursor:pointer" title="打开 NapCat 配置页">NapCat 配置 ↗</span>');
    return out.join("");
  }

  function loadSettings() {
    if (!S.update && !S.updateLoading) {
      S.updateLoading = true;
      api("/api/update").then(function (r) { S.update = r; S.updateLoading = false; if (S.page === "settings") render(); });
    }
    if (!S.deps && !S.depsLoading) {
      S.depsLoading = true;
      api("/api/deps").then(function (r) { S.deps = r; S.depsLoading = false; if (S.page === "settings") render(); });
    }
  }

  function refreshTop() {
    return Promise.all([
      api("/api/onebot").catch(function () { return {}; }),
      api("/api/status" + (S.gid ? "?gid=" + encodeURIComponent(S.gid) : "")).catch(function () { return {}; })
    ]).then(function (r) {
      S.onebot = r[0] || {};
      if (r[1] && r[1].ok) S.status = r[1];
      renderGroupSelect();
      $("#badges").innerHTML = badges();
      $("#brand-sub").textContent = S.onebot.state === "open" ? ("已连接 · 运行 " + Math.round((S.status.uptimeMs || 0) / 1000) + "s") : ("OneBot " + (S.onebot.state || "未连接"));
      $("#live-dot").classList.toggle("on", S.onebot.state === "open");
    });
  }

  function loadGroups() {
    return api("/api/groups").then(function (d) { S.groups = (d && d.groups) || []; return S.groups; });
  }

  function renderGroupSelect() {
    var sel = $("#group-select");
    if (!sel) return;
    sel.innerHTML = '<option value="">全部群</option>' + S.groups.map(function (g) {
      var name = g.group_name ? (g.group_name + "（" + g.group_id + "）") : ("群 " + g.group_id);
      return '<option value="' + esc(g.group_id) + '"' + (String(S.gid) === String(g.group_id) ? " selected" : "") + '>' + esc(name) + '</option>';
    }).join("");
  }

  function openNapcat() {
    var url = getPath(S.values, "runtime.napcatWebui") || "http://127.0.0.1:6099";
    window.open(url, "_blank");
  }

  function doAction(body, okMsg) {
    return api("/api/action", body).then(function (r) {
      toast(r.ok ? (okMsg || "已执行") : ("失败：" + (r.error || "")), !r.ok);
      return loadGroups().then(refreshTop).then(function () { if (S.page === "status") render(); });
    });
  }

  /* ---------- 事件 ---------- */
  function bind() {
    document.addEventListener("click", function (e) {
      var nav = e.target.closest("[data-page]");
      if (nav) {
        e.preventDefault();
        S.page = nav.getAttribute("data-page");
        try { location.hash = S.page === "status" ? "" : S.page; } catch (err) {}
        render();
        return;
      }

      if (e.target.closest("#pill-napcat") || e.target.closest("#btn-napcat")) { openNapcat(); return; }
      if (e.target.closest("#btn-reconnect")) {
        toast("正在重连…");
        return api("/api/action", { action: "reconnect" }).then(function (r) {
          return loadGroups().then(refreshTop).then(function () { render(); toast(r.ok ? ("已重连 " + (r.url || "")) : "重连失败", !r.ok); });
        });
      }
      if (e.target.closest("#btn-refresh")) { loadGroups().then(refreshTop).then(function () { render(); }); toast("已刷新"); return; }
      if (e.target.closest("#btn-enable")) { if (!S.gid) return toast("先选一个群", true); return doAction({ action: "groupEnable", gid: S.gid }, "本群已启用"); }
      if (e.target.closest("#btn-disable")) { if (!S.gid) return toast("先选一个群", true); return doAction({ action: "groupDisable", gid: S.gid }, "本群已停用"); }
      if (e.target.closest("#btn-skip-observe")) {
        if (!S.gid) return toast("先选一个群", true);
        return api("/api/action", { action: "setStage", gid: S.gid, stage: "full" }).then(function (r) {
          toast(r.ok ? "已跳过观察期 —— 本群直接进全自动" : ("失败：" + (r.error || "")), !r.ok);
          return refreshTop().then(render);
        });
      }
      if (e.target.closest("#btn-back-observe")) {
        if (!S.gid) return toast("先选一个群", true);
        return api("/api/action", { action: "setStage", gid: S.gid, stage: "auto" }).then(function (r) {
          toast(r.ok ? "已交回阶段机（重新从观察期算起）" : ("失败：" + (r.error || "")), !r.ok);
          return refreshTop().then(render);
        });
      }
      if (e.target.closest("#btn-global-stop")) return doAction({ action: "globalStop" }, "已全局停用（配置里 paused=true）");
      if (e.target.closest("#btn-global-resume")) return doAction({ action: "globalResume" }, "已恢复");
      if (e.target.closest("#btn-budget")) {
        var rng = $("#budget-range");
        return doAction({ action: "setBudget", value: Number(rng.value) }, "日预算已改为 " + fmtTokens(rng.value));
      }

      if (e.target.closest("#btn-update-check")) {
        toast("正在检查…");
        return api("/api/update").then(function (r) {
          S.update = r; render();
          toast(r.ok ? (r.upToDate ? "已是最新" : "有 " + r.behind + " 个新提交") : (r.error || "检查失败"), !r.ok);
        });
      }
      if (e.target.closest("#btn-update-apply")) {
        if (!window.confirm("确定从远端拉取最新代码吗？\n\n更新完需要重启程序才会生效（托盘右键「重启」）。")) return;
        toast("正在拉取…");
        return api("/api/update", {}).then(function (r) {
          S.update = null; S.depLog = r.log || r.error || "";
          if (r.ok) toast(r.changed ? ("已更新到 " + r.after + "，请重启程序") : "本来就已经是最新");
          else toast("更新失败：" + (r.error || ""), true);
          render();
        });
      }
      if (e.target.closest("#btn-deps-check")) {
        S.deps = null; S.depLog = null; toast("正在检测…");
        return api("/api/deps").then(function (r) { S.deps = r; render(); toast("检测完成"); });
      }
      var pf = e.target.closest("[data-pluginfix]");
      if (pf) {
        var pid = pf.getAttribute("data-pluginfix");
        if (!window.confirm("要现在安装这个社区插件吗？\n\n会联网跑 npm install，可能要一两分钟。")) return;
        toast("正在安装 " + pid + "…");
        return api("/api/plugins/install", { id: pid }).then(function (r) {
          S.pluginLog = (r.output || "") + (r.error ? ("\n" + r.error) : "");
          S.plugins = null;
          toast(r.ok ? "安装完成" : ("安装失败：" + (r.error || "")), !r.ok);
          render();
        });
      }

      var df = e.target.closest("[data-depfix]");
      if (df) {
        var did = df.getAttribute("data-depfix");
        toast("正在处理…");
        return api("/api/deps/install", { id: did }).then(function (r) {
          if (r.open) { window.open(r.open, "_blank"); S.depLog = "已打开下载页：" + r.open + (r.note ? "\n" + r.note : ""); }
          else S.depLog = r.output || r.error || r.note || "（没有输出）";
          S.deps = null;
          return api("/api/deps").then(function (d) { S.deps = d; render(); toast(r.ok ? "处理完成" : "需要手动处理", !r.ok); });
        });
      }

      if (e.target.closest("#btn-save-profile") || e.target.closest("#btn-create-profile")) {
        if (!S.gid) return toast("先选一个群", true);
        var body = {
          gid: S.gid,
          interests: linesOf($("#pf-interests") ? $("#pf-interests").value : ""),
          dislikes: linesOf($("#pf-dislikes") ? $("#pf-dislikes").value : ""),
          habits: ($("#pf-habits") || {}).value || "",
          notes: ($("#pf-notes") || {}).value || "",
          pace: ($("#pf-pace") || {}).value || "",
          activeHours: ($("#pf-active") || {}).value || ""
        };
        return api("/api/profile", body).then(function (r) {
          toast(r.ok ? "群档案已保存 —— 下一轮生效" : ("失败：" + (r.error || "")), !r.ok);
          render();
        });
      }
      if (e.target.closest("#btn-clear-profile")) {
        if (!S.gid) return toast("先选一个群", true);
        return fetch("/api/profile?gid=" + encodeURIComponent(S.gid), { method: "DELETE" })
          .then(function (r) { return r.json(); })
          .then(function (r) { toast(r.ok ? "已清空，下次重炼会重新长出来" : "清空失败", !r.ok); render(); });
      }
      if (e.target.closest("#btn-save-group-persona")) {
        if (!S.gid) return toast("先选一个群", true);
        var ta = $("#persona-group");
        return api("/api/profile", { gid: S.gid, personaText: ta ? ta.value : "" }).then(function (r) {
          toast(r.ok ? "本群专属人设已保存 —— 立刻生效" : ("失败：" + (r.error || "")), !r.ok);
        });
      }

      var seg = e.target.closest(".seg button");
      if (seg) {
        var box = seg.parentElement, key = box.getAttribute("data-seg");
        setPath(S.values, key, seg.getAttribute("data-val"));
        Array.prototype.forEach.call(box.children, function (b) { b.classList.remove("on"); });
        seg.classList.add("on"); markDirty(); return;
      }
      var del = e.target.closest("[data-del]");
      if (del) {
        var dk = del.getAttribute("data-del"), dv = del.getAttribute("data-val");
        setPath(S.values, dk, (getPath(S.values, dk) || []).filter(function (x) { return x !== dv; }));
        markDirty(); render(); return;
      }
      var lab = e.target.closest("[data-label]");
      if (lab) {
        api("/api/labels", { id: lab.getAttribute("data-label"), human: lab.getAttribute("data-human") }).then(function (r) {
          toast(r.ok ? "已标注" : "标注失败", !r.ok); render();
        });
        return;
      }
      var tg = e.target.closest("[data-tag]");
      if (tg) {
        api("/api/memes?tag=" + encodeURIComponent(tg.getAttribute("data-tag"))).then(function (d) {
          var items = (d.items || []).map(function (it) {
            return '<div class="meme"><img loading="lazy" src="' + it.url + '"><div class="cap"><b>' + esc(it.tag) + '</b><br>' + esc(it.caption || it.file) + '</div></div>';
          }).join("");
          $("#page").querySelector(".gallery").innerHTML = items;
        });
        return;
      }
    });

    document.addEventListener("change", function (e) {
      if (e.target && e.target.id === "group-select") {
        S.gid = e.target.value || null;
        try { localStorage.setItem("dshqq-gid", S.gid || ""); } catch (err) {}
        render();
      }
    });

    document.addEventListener("input", function (e) {
      var t = e.target;
      if (t.id === "budget-range") { $("#budget-val").textContent = fmtTokens(t.value); return; }
      if (t.matches("[data-range]")) {
        var k = t.getAttribute("data-range");
        var v = t.step.indexOf(".") >= 0 ? parseFloat(t.value) : parseInt(t.value, 10);
        setPath(S.values, k, v);
        var out = document.querySelector('[data-val-for="' + k + '"]');
        if (out) out.textContent = v;
        markDirty();
      } else if (t.matches("[data-arr]")) {
        var ak = t.getAttribute("data-arr"), idx = parseInt(t.getAttribute("data-idx"), 10);
        var arr = (getPath(S.values, ak) || []).slice();
        arr[idx] = t.step.indexOf(".") >= 0 ? parseFloat(t.value) : parseInt(t.value, 10);
        setPath(S.values, ak, arr);
        var o2 = document.querySelector('[data-arr-for="' + ak + '-' + idx + '"]');
        if (o2) o2.textContent = arr[idx];
        markDirty();
      } else if (t.matches("[data-key]")) {
        setPath(S.values, t.getAttribute("data-key"), t.value); markDirty();
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target.matches("[data-add]")) {
        var k = e.target.getAttribute("data-add"), v = e.target.value.trim();
        if (!v) return;
        var arr = (getPath(S.values, k) || []).slice(); arr.push(v); setPath(S.values, k, arr);
        markDirty(); render();
      }
    });

    $("#save-btn").addEventListener("click", function () {
      api("/api/config", { patch: S.values }).then(function (r) {
        if (r.ok) {
          S.values = r.values; S.dirty = false;
          $("#save-btn").disabled = true; $("#save-btn").textContent = "保存";
          toast("已保存 —— 判定/人设类改动即时生效，接入类需重启程序");
        } else { toast("保存失败：" + (r.error || ""), true); }
      });
    });
    $("#theme-btn").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
      try { localStorage.setItem("dshqq-theme", cur === "dark" ? "light" : "dark"); } catch (e) {}
    });
  }

  function boot() {
    try {
      var saved = localStorage.getItem("dshqq-theme");
      document.documentElement.setAttribute("data-theme", saved === "dark" ? "dark" : "light");
      var g = localStorage.getItem("dshqq-gid");
      if (g) S.gid = g;
      // ?gid=100000001 可以直接落到某个群（分享链接 / 截图用）
      try {
        var qg = new URLSearchParams(location.search).get("gid");
        if (qg) S.gid = qg;
      } catch (err) {}
      // 支持 #状态 这种深链（分享某一页用）
      var h = String(location.hash || "").replace(/^#\/?/, "");
      if (h && PAGES.some(function (p) { return p.id === h; })) S.page = h;
    } catch (e) {}
    bind();
    api("/api/config").then(function (c) {
      S.table = c.table; S.values = c.values; S.runtime = c.runtime; S.defaults = c.defaults;
      return loadGroups();
    }).then(refreshTop).then(render);
    setInterval(function () {
      refreshTop().then(function () { if (S.page === "status") render(); });
    }, 5000);
    setInterval(loadGroups, 30000);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
