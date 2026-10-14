import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT } from "./paths.js";

// N10 决策：三路刹车都要。
//   1) 工作区根目录落下 STOP 文件（或 STOP.txt）→ 全局停
//   2) 配置里 paused === true → 全局停（配置端按钮写这个）
//   3) 群内管理员指令「/停 [分钟]」「/开」「/状态」→ 按群停，默认 60 分钟
export const STOP_FILES = ["STOP", "STOP.txt", "stop.txt"];
export const DEFAULT_STOP_MINUTES = 60;

export function isAdmin(evt, cfg) {
  const c = cfg || {};
  const owners = new Set((c.owners || []).map(String));
  const admins = new Set((c.admins || []).map(String));
  const whitelist = new Set((c.whitelist || []).map(String));
  const uid = String((evt && evt.uid) || "");
  const role = (evt && evt.role) || "";
  if (whitelist.has(uid)) return true;
  if (role === "owner" && (owners.size === 0 || owners.has(uid))) return true;
  if (role === "admin" && (admins.size === 0 || admins.has(uid))) return true;
  if (owners.has(uid) || admins.has(uid)) return true;
  return false;
}

// 只认整条消息就是指令，避免误伤「/停」出现在正常聊天里。
export function parseAdminCommand(text) {
  const t = String(text || "").trim();
  let m = t.match(/^[/／]\s*(停|暂停|stop)\s*(\d+)?\s*$/i);
  if (m) return { cmd: "stop", minutes: m[2] ? Number(m[2]) : DEFAULT_STOP_MINUTES };
  m = t.match(/^[/／]\s*(开|启动|恢复|start|resume|go)\s*$/i);
  if (m) return { cmd: "resume" };
  m = t.match(/^[/／]\s*(状态|status)\s*$/i);
  if (m) return { cmd: "status" };
  return null;
}

export function createBrakes(opts) {
  const o = opts || {};
  const nowFn = o.now || function () { return Date.now(); };
  const root = o.workspaceRoot || WORKSPACE_ROOT;
  const stopFiles = (o.stopFiles || STOP_FILES).map(function (f) { return path.join(root, f); });
  let cfgPaused = !!(o.config && o.config.paused);
  const groupUntil = new Map();     // gid -> 到期毫秒

  function fileStopped() {
    for (const f of stopFiles) { try { if (fs.existsSync(f)) return f; } catch (e) {} }
    return null;
  }

  function state(gid, nowMs) {
    const t = nowMs == null ? nowFn() : nowMs;
    const f = fileStopped();
    if (f) return { stopped: true, reason: "STOP 文件", detail: f };
    if (cfgPaused) return { stopped: true, reason: "配置暂停" };
    const until = groupUntil.get(String(gid));
    if (until && t < until) return { stopped: true, reason: "群内指令暂停", until: until };
    if (until && t >= until) groupUntil.delete(String(gid));
    return { stopped: false, reason: null };
  }

  function stopGroup(gid, minutes, nowMs) {
    const t = nowMs == null ? nowFn() : nowMs;
    const mins = Number(minutes) > 0 ? Number(minutes) : DEFAULT_STOP_MINUTES;
    const until = mins >= 999999 ? Number.MAX_SAFE_INTEGER : t + mins * 60000;
    groupUntil.set(String(gid), until);
    return until;
  }

  function resumeGroup(gid) { return groupUntil.delete(String(gid)); }
  function setConfigPaused(v) { cfgPaused = !!v; return cfgPaused; }
  function info() { return { stopFile: fileStopped(), configPaused: cfgPaused, groups: Object.fromEntries(groupUntil) }; }

  return { state: state, stopGroup: stopGroup, resumeGroup: resumeGroup, setConfigPaused: setConfigPaused, info: info };
}
