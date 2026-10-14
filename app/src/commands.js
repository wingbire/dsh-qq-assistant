// N17 决策：指令框架先建、清单留空，之后再加。
// 所以这里交付的是「注册表 + 权限 + 二次确认」三件套，内置只挂已有的 /停 /开 /状态 /帮助。
export const PERM_RANK = { any: 0, whitelist: 1, admin: 2, owner: 3 };

export function permLevelOf(evt, cfg) {
  const c = cfg || {};
  const uid = String((evt && evt.uid) || "");
  const role = String((evt && evt.role) || "");
  const has = function (list) { return Array.isArray(list) && list.map(String).includes(uid); };
  if (role === "owner" || has(c.owners)) return "owner";
  if (role === "admin" || has(c.admins)) return "admin";
  if (has(c.whitelist)) return "whitelist";
  return "any";
}

export function allow(evt, cfg, need) {
  const mine = PERM_RANK[permLevelOf(evt, cfg)] || 0;
  const want = PERM_RANK[need == null ? "any" : need] || 0;
  return mine >= want;
}

export const CONFIRM_WORDS = ["确认", "确认执行", "confirm", "yes"];

export function createCommands(opts) {
  const o = opts || {};
  const specs = new Map();
  const aliasMap = new Map();
  const log = [];

  function register(spec) {
    if (!spec || !spec.name) throw new Error("命令必须有 name");
    const s = Object.assign({ perm: "admin", dangerous: false, help: "" }, spec);
    specs.set(s.name, s);
    for (const a of (s.aliases || [])) aliasMap.set(a, s.name);
    return s;
  }

  function find(name) {
    const n = String(name || "").replace(/^[/／]/, "");
    if (specs.has(n)) return specs.get(n);
    const real = aliasMap.get(n);
    return real ? specs.get(real) : null;
  }

  // 只认整条消息就是指令（避免误伤正文里出现的 /停）
  function parse(text) {
    const t = String(text || "").trim();
    const m = t.match(/^[/／]\s*([A-Za-z\u4e00-\u9fa5_]+)\s*(.*)$/);
    if (!m) return null;
    return { name: m[1], args: m[2] ? m[2].trim() : "", raw: t };
  }

  function dispatch(evt, ctx) {
    const parsed = parse(evt && evt.text);
    if (!parsed) return { handled: false };
    const spec = find(parsed.name);
    if (!spec) return { handled: false, unknown: parsed.name };
    const cfg = (ctx && ctx.config) || {};
    if (!allow(evt, cfg, spec.perm)) {
      log.push({ at: (o.now ? o.now() : Date.now()), name: spec.name, uid: evt.uid, ok: false });
      return { handled: true, ok: false, action: "denied", name: spec.name, reply: spec.deniedReply || "这个你说了不算。" };
    }
    if (spec.dangerous) {
      const said = CONFIRM_WORDS.some(function (w) { return parsed.args.toLowerCase().includes(w); });
      if (!said) {
        log.push({ at: (o.now ? o.now() : Date.now()), name: spec.name, uid: evt.uid, ok: false, confirm: true });
        return { handled: true, ok: false, action: "confirm_required", name: spec.name, needsConfirm: true, reply: "危险操作，确认要执行就再发一次：" + parsed.raw.split(/\s+/)[0] + " 确认" };
      }
    }
    let out = null;
    try { out = spec.handler({ evt: evt, args: parsed.args, parsed: parsed, ctx: ctx || {} }); } catch (e) { out = { ok: false, error: String(e && e.message) }; }
    // handler 允许返回 Promise（例如要等 TTS 合成完）；dispatch 跟着返回 Promise
    if (out && typeof out.then === "function") {
      return out.then(function (v) {
        const res = Object.assign({ handled: true, ok: true, name: spec.name, action: spec.action || spec.name }, v || {});
        log.push({ at: (o.now ? o.now() : Date.now()), name: spec.name, uid: evt.uid, ok: !!res.ok });
        return res;
      }, function (e) {
        return { handled: true, ok: false, name: spec.name, action: spec.action || spec.name, error: String(e && e.message) };
      });
    }
    const res = Object.assign({ handled: true, ok: true, name: spec.name, action: spec.action || spec.name }, out || {});
    log.push({ at: (o.now ? o.now() : Date.now()), name: spec.name, uid: evt.uid, ok: !!res.ok });
    return res;
  }

  return {
    register: register, find: find, parse: parse, dispatch: dispatch,
    list: function () { return Array.from(specs.values()); },
    helps: function () { return Array.from(specs.values()).filter(function (s) { return s.help; }).map(function (s) { return "/" + s.name + " — " + s.help + (s.perm === "any" ? "" : "（需要" + s.perm + "）"); }); },
    log: log
  };
}

// 内置命令：把已有的三路刹车挂到注册表上（N10），再加一个 /帮助
export function createDefaultCommands(deps) {
  const d = deps || {};
  const cmds = createCommands({ now: d.now });
  const stopMinutes = d.stopMinutes || 60;

  cmds.register({
    name: "停", aliases: ["stop", "暂停"], perm: "admin", action: "admin_stop",
    help: "让小助手在这个群闭嘴，默认 " + stopMinutes + " 分钟，可跟分钟数",
    handler: function (a) {
      const mins = Number(a.args) > 0 ? Number(a.args) : stopMinutes;
      if (d.brakes) d.brakes.stopGroup(a.evt.gid, mins, a.evt.now);
      return { reply: "行，我先闭嘴 " + mins + " 分钟。", minutes: mins };
    }
  });
  cmds.register({
    name: "开", aliases: ["start", "恢复", "resume"], perm: "admin", action: "admin_resume",
    help: "解除本群暂停",
    handler: function (a) {
      if (d.brakes) d.brakes.resumeGroup(a.evt.gid);
      return { reply: "好，我回来了。" };
    }
  });
  cmds.register({
    name: "状态", aliases: ["status"], perm: "admin", action: "admin_status",
    help: "看今天的用量与运行模式",
    handler: function () {
      const s = d.budget ? d.budget.status() : {};
      return { reply: "今天用了 " + s.used + "/" + s.limit + "，" + s.mode, budget: s };
    }
  });
  cmds.register({
    name: "帮助", aliases: ["help", "?", "？"], perm: "any", action: "help",
    help: "看有哪些指令",
    handler: function () { return { reply: cmds.helps().join(String.fromCharCode(10)) }; }
  });
  return cmds;
}
