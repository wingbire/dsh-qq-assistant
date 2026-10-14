import net from "node:net";
import { oneLine, normalizeName } from "./untrusted.js";

// OneBot v11 群消息接入。P1：只用群消息；私聊/通知/请求一律忽略。
// 传输层可注入（transport），所以单测不需要真开 WebSocket。
// Node 24 自带全局 WebSocket，不引入任何依赖。

export const ONEBOT_DEFAULT = {
  reconnectMs: 3000,
  maxBackoffMs: 60000,
  dedupeWindowMs: 180000,
  maxTextLen: 300
};

// 连接失败要能一眼看懂。undici 的 WebSocket 触发的是 ErrorEvent：
// 直接 String(e) 出来是 "[object ErrorEvent]" —— 排查时等于什么都没说。
// 真正有用的（ECONNREFUSED / 端口没开 / 握手被拒）在 e.error / e.code 里。
export function errorText(e) {
  if (!e) return "未知错误";
  const inner = (e && e.error) || null;
  const code = (e && e.code) || (inner && inner.code) || "";
  const msg = String((e && e.message) || (inner && inner.message) || "").trim();
  if (msg) return (code && msg.indexOf(String(code)) < 0) ? msg + "（" + code + "）" : msg;
  if (inner && inner.message) return String(inner.message);
  if (code) return String(code);
  try {
    const s = String(e);
    return (s === "[object Object]" || s === "[object ErrorEvent]") ? "连接失败（拿不到原因）" : s;
  } catch (err) { return "连接失败（拿不到原因）"; }
}

// Node 自带的 WebSocket（undici）连不上时只丢一个"消息为空的 TypeError"：
// 实测 e.error.message === ""、cause === undefined —— 光靠它排查等于抓瞎。
// 所以自己再戳一下 TCP 端口，把「端口没开」和「端口通了但握手被拒」分开说清楚。
export function probePort(url, timeoutMs) {
  return new Promise(function (resolve) {
    let host = "127.0.0.1", port = 0;
    try {
      const u = new URL(String(url || "").replace(/^wss:/, "https:").replace(/^ws:/, "http:"));
      host = u.hostname || host;
      port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    } catch (e) { return resolve({ ok: false, host: host, port: port, error: "地址不合法" }); }
    if (!port) return resolve({ ok: false, host: host, port: port, error: "地址里没有端口" });
    const sock = net.connect({ host: host, port: port });
    let done = false;
    function finish(r) { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(r); }
    let timer = setTimeout(function () { finish({ ok: false, host: host, port: port, error: "连接超时" }); }, timeoutMs || 1200);
    if (timer.unref) timer.unref();
    sock.on("connect", function () { clearTimeout(timer); finish({ ok: true, host: host, port: port }); });
    sock.on("error", function (e) { clearTimeout(timer); finish({ ok: false, host: host, port: port, error: String((e && e.message) || e) }); });
  });
}

export function withToken(url, token) {
  const u = String(url || "");
  if (!token) return u;
  if (/[?&]access_token=/.test(u)) return u;
  return u + (u.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(String(token));
}

// OneBot v11 原始事件 → 内部事件。返回 null 表示「不该处理的」。
export function normalizeEvent(raw, ctx) {
  const c = ctx || {};
  if (!raw || typeof raw !== "object") return null;
  if (raw.post_type === "meta_event") {
    if (raw.meta_event_type === "lifecycle" && raw.self_id != null && c.onSelfId) c.onSelfId(String(raw.self_id));
    return null;
  }
  if (raw.post_type !== "message") return null;
  if (raw.message_type !== "group") return null;
  const selfId = String(c.selfId != null ? c.selfId : raw.self_id != null ? raw.self_id : "");
  const uid = String(raw.user_id != null ? raw.user_id : "");
  if (selfId && uid === selfId) return null;                  // 自己的消息不回

  const segs = Array.isArray(raw.message) ? raw.message : [];
  let atBot = false, atAll = false, replyToBot = false, replyToOther = false, replyId = null, replyQuote = "";
  const texts = [];
  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    const d = s.data || {};
    if (s.type === "text") texts.push(String(d.text || ""));
    else if (s.type === "at") {
      const qq = String(d.qq);
      if (qq === "all") atAll = true;
      else if (qq === selfId) atBot = true;
    } else if (s.type === "reply") {
      const id = String(d.id);
      replyId = id;
      // 有些实现（含 NapCat 的部分版本）会顺手把被引用的原文塞在 data 里；没有就得靠 get_msg 补
      const q = (d.text != null ? d.text : (d.content != null ? d.content : (d.message != null ? d.message : "")));
      if (q) replyQuote = String(q).slice(0, 300);
      if (c.sentIds && c.sentIds.has(id)) replyToBot = true; else replyToOther = true;
    }
  }
  // 图片 / 语音 / 视频也算「有内容」—— 纯图片消息不能因为没文字就被丢掉（N18 识图要用）
  const images = [];
  let hasRich = false;
  let hasVoice = false;
  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    if (s.type === "image") { hasRich = true; images.push({ file: String((s.data || {}).file || ""), url: String((s.data || {}).url || "") }); }
    else if (s.type === "record") { hasRich = true; hasVoice = true; }
    else if (s.type === "video" || s.type === "face" || s.type === "file") hasRich = true;
  }
  let text = texts.join("").trim();
  if (!text && typeof raw.raw_message === "string") text = raw.raw_message.replace(/\[CQ:(at|image|record|face),[^\]]*\]/g, "").trim();
  if (!text && !hasRich) return null;
  // 纯媒体消息给个标记：模型看到的不是"一条空消息"。
  // 图片有识图时会换成画面描述；语音本程序不做转写，人设里也写了"听不到内容"。
  if (!text) {
    if (images.length) text = "[图片]";
    else if (hasVoice) text = "[语音]";
    else text = "[多媒体]";
  }

  const sender = raw.sender || {};
  const speaker = normalizeName(sender.card || sender.nickname || uid);
  return {
    gid: String(raw.group_id),
    uid: uid,
    selfId: selfId,
    speaker: speaker,
    text: oneLine(text, c.maxTextLen || ONEBOT_DEFAULT.maxTextLen),
    raw: text,
    atBot: atBot,
    atAll: atAll,
    replyToBot: replyToBot,
    replyToOther: replyToOther,
    replyId: replyId,                 // 被引用消息的 id（要用 get_msg 取原文，或直接用于引用回复）
    replyQuote: replyQuote || null,   // 事件里自带的引用原文（有就不用再调 get_msg）
    messageId: raw.message_id != null ? String(raw.message_id) : null,
    role: String(sender.role || ""),
    segments: segs,
    images: images,
    hasImage: images.length > 0,
    hasVoice: hasVoice,
    now: c.now != null ? c.now : Date.now()
  };
}

// 通知类事件（戳一戳等）→ 内部事件。目前只认"戳"，其它通知返回 null。
// 兼容两种形状：{"notice_type":"notify","sub_type":"poke"}（go-cqhttp / NapCat）与 {"notice_type":"poke"}。
export function normalizeNotice(raw, ctx) {
  const c = ctx || {};
  if (!raw || typeof raw !== "object") return null;
  if (raw.post_type !== "notice") return null;
  if (raw.message_type && raw.message_type !== "group") return null;
  const isPoke = (raw.notice_type === "notify" && raw.sub_type === "poke") || raw.notice_type === "poke";
  if (!isPoke) return null;
  const selfId = String(c.selfId != null ? c.selfId : raw.self_id != null ? raw.self_id : "");
  const from = String(raw.user_id != null ? raw.user_id : "");
  const target = String(raw.target_id != null ? raw.target_id : (raw.user_id != null ? raw.user_id : ""));
  const gid = raw.group_id != null ? String(raw.group_id) : null;
  if (!gid) return null;
  if (selfId && from === selfId) return null;            // 自己戳的不理
  return {
    kind: "poke", gid: gid, uid: from, targetId: target, selfId: selfId,
    pokeMe: !!selfId && target === selfId,               // 戳的是不是她
    now: c.now != null ? c.now : Date.now()
  };
}

export function createOneBot(opts) {
  const o = opts || {};
  const cfg = Object.assign({}, ONEBOT_DEFAULT, o.config || {});
  const nowFn = o.now || function () { return Date.now(); };
  const transport = o.transport || function (url, t) {
    const W = typeof globalThis.WebSocket !== "undefined" ? globalThis.WebSocket : null;
    if (!W) throw new Error("运行时不带 WebSocket，请注入 transport");
    return new W(url, t);
  };
  const sentIds = new Set();
  const seen = new Map();
  const pendingActions = new Map();      // echo -> { resolve, timer }  —— 异步动作（get_status / get_group_list …）
  let selfId = o.selfId ? String(o.selfId) : null;
  let ws = null, stopped = false, retry = 0, timer = null;
  let state = "idle";
  let lastIncoming = null;      // 服务端最近一次回话（token 验证失败这类会走这里）

  function setState(s, extra) {
    state = s;
    if (o.onStatus) { try { o.onStatus(Object.assign({ state: s, selfId: selfId }, extra || {})); } catch (e) {} }
  }

  function remember(id) {
    if (id == null) return;
    sentIds.add(String(id));
    if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value);
  }

  function dedupe(messageId) {
    if (messageId == null) return false;
    const key = String(messageId);
    const t = nowFn();
    const prev = seen.has(key);          // 注意：时间戳可能是 0，不能用取值真假来判断
    seen.set(key, t);
    for (const [k, v] of Array.from(seen.entries())) if (t - v > cfg.dedupeWindowMs) seen.delete(k);
    return prev;
  }

  function handlePayload(payload) {
    const data = typeof payload === "string" ? safeJson(payload) : payload;
    if (!data) return;
    // 服务端的错误回包（比如 NapCat 的 token 验证失败：retcode 1403）没有 echo，单独记下来
    if (data.retcode != null && data.retcode !== 0 && data.echo == null) {
      lastIncoming = { retcode: data.retcode, message: data.message || data.wording || "", at: nowFn() };
      setState("rejected", { retcode: data.retcode, message: lastIncoming.message });
      if (o.onRejected) { try { o.onRejected(lastIncoming); } catch (e) {} }
      return;
    }
    if (data.echo != null && data.retcode != null) {          // 动作回执
      const p = pendingActions.get(String(data.echo));
      if (p) {
        clearTimeout(p.timer);
        pendingActions.delete(String(data.echo));
        p.resolve({ ok: data.status === "ok" || data.retcode === 0, status: data.status, retcode: data.retcode, data: data.data, echo: data.echo });
      }
      if (o.onAction) { try { o.onAction(data); } catch (e) {} }
      if (data.data && data.data.message_id != null) remember(data.data.message_id);
      return;
    }
    if (data.post_type === "notice") {
      const pe = normalizeNotice(data, { selfId: selfId, now: nowFn() });
      if (pe && o.onEvent) { try { o.onEvent(pe); } catch (e) {} }
      return;
    }
    if (data.post_type) {
      const evt = normalizeEvent(data, {
        selfId: selfId, sentIds: sentIds, now: nowFn(), maxTextLen: cfg.maxTextLen,
        onSelfId: function (id) { selfId = id; }
      });
      if (!evt) return;
      if (evt.messageId && dedupe(evt.messageId)) return;
      if (o.onEvent) { try { o.onEvent(evt); } catch (e) {} }
    }
  }

  function connect() {
    if (stopped) return;
    setState(retry === 0 ? "connecting" : "reconnecting", { retry: retry });
    let sock = null;
    try { sock = transport(withToken(o.url, o.token), o.transportOptions || {}); } catch (e) {
      setState("error", { error: errorText(e) });
      return scheduleRetry();
    }
    ws = sock;
    sock.onopen = function () { retry = 0; setState("open"); if (o.onOpen) { try { o.onOpen(); } catch (e) {} } };
    sock.onmessage = function (m) { handlePayload(m && m.data !== undefined ? m.data : m); };
    sock.onclose = function (ev) {
      if (stopped) return;
      // 被服务端拒绝（例如 token 不符）不是普通的断开：保留 rejected，别让重连把它盖成一句"closed"
      if (state !== "rejected") {
        const code = ev && ev.code;
        const reason = (ev && ev.reason) || "";
        if (reason || code !== 1006) {
          setState("closed", { code: code, reason: reason });
        } else {
          // 1006 = 没拿到正常关闭帧。自己戳一下端口，把原因说成人话（别让用户对着 1006 猜）
          setState("closed", { code: code, reason: "连接异常中断" });
          probePort(o.url).then(function (p) {
            if (stopped || state === "rejected" || state === "open") return;
            setState("closed", {
              code: code,
              reason: p.ok
                ? ("端口 " + p.host + ":" + p.port + " 是通的，但 WebSocket 握手没过（多半是令牌或路径不对）")
                : ("连不上 " + p.host + ":" + p.port + " —— " + (p.error || "端口没开") + "（NapCat 没起来，或它的 WebSocket 服务端没开）")
            });
          });
        }
      }
      scheduleRetry();
    };
    // 被拒之后紧跟着的异常关闭（undici 会先 onerror 再 onclose）不能把 rejected 盖掉，
    // 否则用户看到的永远是"断开"，查不出是 token 不对。
    sock.onerror = function (e) {
      if (state === "rejected") return;
      setState("error", { error: errorText(e) });
    };
    return sock;
  }

  function scheduleRetry() {
    if (stopped) return null;
    retry += 1;
    const wait = Math.min(cfg.maxBackoffMs, cfg.reconnectMs * Math.pow(2, Math.min(retry - 1, 6)));
    timer = setTimeout(function () { connect(); }, wait);
    if (timer && timer.unref) timer.unref();
    return wait;
  }

  function send(payload) {
    if (!ws || typeof ws.send !== "function") return false;
    try { ws.send(typeof payload === "string" ? payload : JSON.stringify(payload)); return true; } catch (e) { return false; }
  }

  // 发送正文；N6 的多条发送由上层 split 后逐条调用本函数。
  // text 直发；opts.replyTo 有值时改成"引用回复"（reply 段必须排在 text 段前面）
  function sendGroupMsg(gid, text, opts) {
    const echo = "dshqq-" + nowFn() + "-" + Math.floor(Math.random() * 1e6);
    const rid = opts && opts.replyTo != null ? String(opts.replyTo) : "";
    const message = rid
      ? [{ type: "reply", data: { id: rid } }, { type: "text", data: { text: String(text) } }]
      : String(text);
    return send({ action: "send_group_msg", params: { group_id: Number(gid), message: message }, echo: echo });
  }

  // 回戳：不同实现动作名不一样，先 group_poke 再退到 send_poke
  function sendPoke(gid, uid) {
    const echo = "dshqq-poke-" + nowFn() + "-" + Math.floor(Math.random() * 1e6);
    return send({ action: "group_poke", params: { group_id: Number(gid), user_id: Number(uid) }, echo: echo })
      || send({ action: "send_poke", params: { group_id: Number(gid), user_id: Number(uid) }, echo: echo });
  }

  // 发图：OneBot v11 的 image 段。NapCat 认绝对路径（统一成正斜杠更稳）
  function sendGroupImage(gid, file) {
    if (!file) return false;
    const echo = "dshqq-img-" + nowFn() + "-" + Math.floor(Math.random() * 1e6);
    const p = String(file).replace(/\\/g, "/");
    return send({ action: "send_group_msg", params: { group_id: Number(gid), message: [{ type: "image", data: { file: p } }] }, echo: echo });
  }

  // 发语音（OneBot v11 的 record 段）。NapCat 认本地绝对路径或 base64://
  function sendGroupRecord(gid, file) {
    if (!file) return false;
    const echo = "dshqq-rec-" + nowFn() + "-" + Math.floor(Math.random() * 1e6);
    const p = String(file).replace(/\\/g, "/");
    return send({ action: "send_group_msg", params: { group_id: Number(gid), message: [{ type: "record", data: { file: p } }] }, echo: echo });
  }

  // 通用动作调用（不等回执，取图片、取群成员等）
  function callAction(action, params) {
    const echo = "dshqq-act-" + nowFn() + "-" + Math.floor(Math.random() * 1e6);
    send({ action: action, params: params || {}, echo: echo });
    return echo;
  }

  // 等回执的动作调用 —— 配置端读 OneBot/NapCat 状态、群列表都靠它
  function callActionAsync(action, params, timeoutMs) {
    return new Promise(function (resolve) {
      if (!ws || typeof ws.send !== "function") return resolve({ ok: false, error: "未连接 OneBot" });
      const echo = "dshqq-rq-" + nowFn() + "-" + Math.floor(Math.random() * 1e6);
      const timer = setTimeout(function () {
        pendingActions.delete(echo);
        resolve({ ok: false, error: "动作超时：" + action, timeout: true });
      }, timeoutMs || 8000);
      pendingActions.set(echo, { resolve: resolve, timer: timer });
      const sentOk = send({ action: action, params: params || {}, echo: echo });
      if (!sentOk) { clearTimeout(timer); pendingActions.delete(echo); resolve({ ok: false, error: "发送失败" }); }
    });
  }

  function close() {
    stopped = true;
    for (const [echo, p] of Array.from(pendingActions.entries())) { clearTimeout(p.timer); p.resolve({ ok: false, error: "连接已关闭" }); pendingActions.delete(echo); }
    if (timer) clearTimeout(timer);
    setState("stopped");
    try { if (ws && ws.close) ws.close(); } catch (e) {}
  }

  return {
    connect: connect, close: close, send: send, sendGroupMsg: sendGroupMsg, sendGroupImage: sendGroupImage,
    sendGroupRecord: sendGroupRecord, sendPoke: sendPoke, callAction: callAction, callActionAsync: callActionAsync,
    pendingActions: function () { return pendingActions.size; },
    state: function () { return state; }, selfId: function () { return selfId; },
    url: function () { return o.url; }, tokenSet: function () { return !!o.token; },
    lastMessage: function () { return lastIncoming; },
    sentIds: sentIds, seenCount: function () { return seen.size; },
    config: cfg
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
