import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./paths.js";

// N23 决策：取消每群每小时条数上限，改为「短时连续消息合并」（见 coalesce.js）。
// 日 token 预算保留：超 80% 关主动，超 100% 只回被点名的。
export const BUDGET_DEFAULT = {
  dailyTokens: 5000000,
  softRatio: 0.8,
  hardRatio: 1.0,
  groupHourlyLimit: 0            // 0 = 关闭（N23）
};

export function dayKeyOf(nowMs) {
  const d = new Date(Number(nowMs) || Date.now());
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export function hourKeyOf(nowMs) {
  const d = new Date(Number(nowMs) || Date.now());
  return dayKeyOf(nowMs) + "T" + String(d.getHours()).padStart(2, "0");
}

export function createBudget(opts) {
  const o = opts || {};
  const lim = Object.assign({}, BUDGET_DEFAULT, o.limits || {});
  const nowFn = o.now || function () { return Date.now(); };
  let day = dayKeyOf(nowFn());
  let used = 0;
  const groupCounters = new Map();
  let hardStops = 0;

  function roll(nowMs) {
    const k = dayKeyOf(nowMs);
    if (k !== day) { day = k; used = 0; groupCounters.clear(); }
  }

  function record(tokens, nowMs) {
    roll(nowMs == null ? nowFn() : nowMs);
    used += Math.max(0, Number(tokens) || 0);
    return used;
  }

  function ratio() { roll(nowFn()); return lim.dailyTokens > 0 ? used / lim.dailyTokens : 0; }

  function mode() {
    const r = ratio();
    if (r >= lim.hardRatio) return "mentionOnly";
    if (r >= lim.softRatio) return "noProactive";
    return "normal";
  }

  function allowProactive() { return mode() === "normal"; }

  function allowReply(isHardTrigger) {
    const m = mode();
    if (m === "mentionOnly") {
      const okGo = !!isHardTrigger;
      if (!okGo) hardStops += 1;
      return okGo;
    }
    return true;
  }

  function groupAllow(gid, nowMs) {
    if (!lim.groupHourlyLimit) return true;              // N23：默认关闭
    const hk = hourKeyOf(nowMs == null ? nowFn() : nowMs);
    const cur = groupCounters.get(String(gid));
    if (!cur || cur.hk !== hk) { groupCounters.set(String(gid), { hk: hk, n: 0 }); return true; }
    return cur.n < lim.groupHourlyLimit;
  }

  function countGroup(gid, nowMs) {
    if (!lim.groupHourlyLimit) return 0;
    const hk = hourKeyOf(nowMs == null ? nowFn() : nowMs);
    const cur = groupCounters.get(String(gid));
    if (!cur || cur.hk !== hk) { groupCounters.set(String(gid), { hk: hk, n: 1 }); return 1; }
    cur.n += 1;
    return cur.n;
  }

  function load(file) {
    if (!file) return false;
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      if (v && v.day === dayKeyOf(nowFn())) { used = Number(v.used) || 0; return true; }
      return false;
    } catch (e) { return false; }
  }

  function save(file, nowMs) {
    if (!file) return null;
    roll(nowMs == null ? nowFn() : nowMs);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ day: day, used: used, at: new Date().toISOString() }, null, 2), "utf8");
    return file;
  }

  function status() {
    return { day: day, used: used, limit: lim.dailyTokens, ratio: Math.round(ratio() * 1000) / 1000, mode: mode(), hardStops: hardStops };
  }

  return {
    limits: lim, record: record, ratio: ratio, mode: mode,
    allowProactive: allowProactive, allowReply: allowReply,
    groupAllow: groupAllow, countGroup: countGroup,
    status: status, load: load, save: save
  };
}
