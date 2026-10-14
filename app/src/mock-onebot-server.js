import http from "node:http";
import crypto from "node:crypto";

// 极简 WebSocket 服务端（RFC6455 文本帧），只为本地联调。
// 刻意不依赖 ws 包：分发版要能零 npm 安装跑起来。
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(payload, opcode) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const op = opcode == null ? 0x1 : opcode;
  const len = data.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | op;
  return Buffer.concat([header, data]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) === 0x80;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  let payload = buf.subarray(off + maskLen, off + maskLen + len);
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  return { opcode: opcode, payload: payload, rest: buf.subarray(off + maskLen + len) };
}

export function createMockOneBotServer(opts) {
  const o = opts || {};
  const token = o.token == null ? "" : String(o.token);
  const received = [];            // 机器人发来的 action
  const sockets = new Set();
  let nextMessageId = 1000;
  let onAction = o.onAction || null;

  const server = http.createServer(function (req, res) {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("upgrade required");
  });

  server.on("upgrade", function (req, socket) {
    let ok = true;
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const got = url.searchParams.get("access_token") || "";
      ok = !token || got === token;
    } catch (e) { ok = false; }
    if (!ok && o.rejectMode === "handshake") { socket.write("HTTP/1.1 401 Unauthorized" + "\r\n\r\n"); socket.destroy(); return; }
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(String(key) + GUID).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: " + accept,
      "", ""
    ].join("\r\n"));
    sockets.add(socket);
    if (!ok) {
      // 真 NapCat 的做派：握手照做，然后回一个 retcode 1403 再关掉连接。
      // 客户端能不能识别这个，决定了它到底是"哑巴重连"还是能告诉你"token 验证失败"。
      try { socket.write(encodeFrame(JSON.stringify({ status: "failed", retcode: 1403, data: null, message: "token验证失败", wording: "token验证失败", echo: null, stream: "normal-action" }), 0x1)); } catch (e) {}
      // 给客户端留足够时间收完帧再关：真 NapCat 也是"发完 1403 才断"
      setTimeout(function () { try { socket.end(); } catch (e) {} }, 250);
      return;
    }
    let buf = Buffer.alloc(0);
    socket.on("data", function (d) {
      buf = Buffer.concat([buf, d]);
      let out = null;
      while ((out = decodeFrame(buf))) {
        buf = out.rest;
        if (out.opcode === 0x1) {
          const text = out.payload.toString("utf8");
          let j = null;
          try { j = JSON.parse(text); } catch (e) { j = null; }
          received.push(j || text);
          if (j && j.action) {
            if (j.action === "send_group_msg") nextMessageId += 1;
            if (o.autoEcho !== false) {
              try { socket.write(encodeFrame(JSON.stringify({ status: "ok", retcode: 0, echo: j.echo, data: { message_id: nextMessageId } }), 0x1)); } catch (e) {}
            }
            if (onAction) { try { onAction(j, socket); } catch (e) {} }
          }
        } else if (out.opcode === 0x8) { try { socket.end(); } catch (e) {} }
        else if (out.opcode === 0x9) { try { socket.write(encodeFrame(out.payload, 0xa)); } catch (e) {} }
      }
    });
    socket.on("close", function () { sockets.delete(socket); });
    socket.on("error", function () { sockets.delete(socket); });
  });

  function sendTo(socket, text) { try { socket.write(encodeFrame(Buffer.from(String(text), "utf8"), 0x1)); return true; } catch (e) { return false; } }
  function broadcast(text) { let n = 0; for (const s of sockets) if (sendTo(s, text)) n += 1; return n; }
  function event(o2) { return broadcast(JSON.stringify(Object.assign({ time: Math.floor(Date.now() / 1000), self_id: o.selfId || 999 }, o2))); }
  function groupMessage(o2) {
    const uid = String(o2.user_id);
    return event({
      post_type: "message", message_type: "group", sub_type: "normal",
      group_id: Number(o2.group_id), user_id: Number(o2.user_id), message_id: o2.message_id || Math.floor(Math.random() * 1e6),
      raw_message: o2.text || "", sender: { user_id: Number(o2.user_id), nickname: o2.nickname || uid, card: o2.card || "", role: o2.role || "member" },
      message: o2.segments || [{ type: "text", data: { text: o2.text || "" } }]
    });
  }

  return {
    server: server,
    listen: function (port) {
      return new Promise(function (resolve) { server.listen(port || 0, "127.0.0.1", function () { resolve(server.address().port); }); });
    },
    close: function () { return new Promise(function (resolve) { for (const s of sockets) { try { s.destroy(); } catch (e) {} } sockets.clear(); server.close(function () { resolve(true); }); }); },
    received: received,
    sentTexts: function () { return received.filter(function (r) { return r && r.action === "send_group_msg"; }).map(function (r) { return r.params.message; }); },
    socketCount: function () { return sockets.size; },
    broadcast: broadcast,
    event: event,
    groupMessage: groupMessage,
    setOnAction: function (f) { onAction = f; }
  };
}
