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
  // 今日用量必须活过重启：托盘是 taskkill /F 收尾，SIGINT 那套"退出时才存"根本不会执行，
  // 结果日预算（超 80% 关主动 / 超 100% 只回点名）每次重启都从头开始 —— 等于没有熔断。
  const file = o.file || null;
  let saveTimer = null;

  function roll(nowMs) {
    const k = dayKeyOf(nowMs);
    // 只清"今日用量"；每群的小时计数由 hk 自己判过期，别在这里清
    // （roll 会被各种时间戳调用，混合时钟会让日期来回翻 → 小时计数被反复清空、上限失效）
    if (k !== day) { day = k; used = 0; }
  }

  function record(tokens, nowMs) {
    roll(nowMs == null ? nowFn() : nowMs);
    used += Math.max(0, Number(tokens) || 0);
    scheduleSave();
    return used;
  }

  function scheduleSave() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = null; save(file); }, 1500);
    if (saveTimer.unref) saveTimer.unref();
  }

  function flush(nowMs) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    return save(file, nowMs);
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

  if (file) load(file);                   // 起来先把今天的用量接上

  return {
    limits: lim, record: record, ratio: ratio, mode: mode,
    allowProactive: allowProactive, allowReply: allowReply,
    groupAllow: groupAllow, countGroup: countGroup,
    status: status, load: load, save: save, flush: flush, file: file
  };
}
