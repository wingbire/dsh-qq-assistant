// 一键登录 B 站：弹一个 Edge → 用户自己扫码/输密码 → 程序从浏览器里取走 SESSDATA / bili_jct。
// 为什么不做"填账号密码"：B 站登录接口必须过行为验证码，程序替用户过不了，硬来还会触发风控。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { findBrowser } from "./chart.js";

export const BILI_LOGIN_PORT = 9333;

export function createBiliLogin(opts) {
  const o = opts || {};
  const profileDir = o.profileDir;
  const port = o.port || BILI_LOGIN_PORT;
  let child = null;

  function alive() { return !!(child && !child.killed); }

  async function start() {
    if (alive()) return { ok: true, already: true, port: port };
    const b = findBrowser(o.env);
    if (!b) return { ok: false, error: "没找到 Edge/Chrome" };
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) { }
    try {
      child = spawn(b, [
        "--remote-debugging-port=" + port,
        "--user-data-dir=" + profileDir,
        "--no-first-run", "--no-default-browser-check",
        "--new-window", "https://passport.bilibili.com/login"
      ], { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
    } catch (e) { return { ok: false, error: String(e && e.message) }; }
    return { ok: true, port: port };
  }

  // 从浏览器里读 cookie：优先用 CDP 的 Network.getCookies
  async function readCookies() {
    let targets = [];
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(4000) });
      targets = await r.json();
    } catch (e) { return { ok: false, error: "浏览器还没就绪" }; }
    const page = targets.filter(function (t) { return t.type === "page" && /bilibili/.test(String(t.url)); })[0]
      || targets.filter(function (t) { return t.type === "page"; })[0];
    if (!page || !page.webSocketDebuggerUrl) return { ok: false, error: "没有可用的浏览器页面" };
    return await new Promise(function (resolve) {
      let done = false;
      const finish = function (v) { if (done) return; done = true; try { ws.close(); } catch (e) { } resolve(v); };
      let ws = null;
      const timer = setTimeout(function () { finish({ ok: false, error: "读取 cookie 超时" }); }, 6000);
      try { ws = new WebSocket(page.webSocketDebuggerUrl); } catch (e) { clearTimeout(timer); return finish({ ok: false, error: String(e && e.message) }); }
      ws.onopen = function () {
        ws.send(JSON.stringify({ id: 1, method: "Network.getCookies", params: { urls: ["https://www.bilibili.com", "https://passport.bilibili.com"] } }));
      };
      ws.onmessage = function (m) {
        try {
          const j = JSON.parse(String(m.data));
          if (j.id !== 1) return;
          clearTimeout(timer);
          const list = (j.result && j.result.cookies) || [];
          const map = {};
          for (const c of list) map[c.name] = c.value;
          finish({ ok: true, sessdata: map.SESSDATA || "", jct: map.bili_jct || "", count: list.length });
        } catch (e) { }
      };
      ws.onerror = function () { clearTimeout(timer); finish({ ok: false, error: "CDP 连接失败" }); };
    });
  }

  function close() {
    try { if (child && !child.killed) child.kill(); } catch (e) { }
    child = null;
  }

  return { start: start, readCookies: readCookies, close: close, alive: alive, port: port };
}
