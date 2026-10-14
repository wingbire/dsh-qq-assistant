import fs from "node:fs";
import path from "node:path";

// 配置端"收到的消息与判定过程"的缓冲区。
// 以前它只活在内存里（每群 80 条，重启即清），消息一密、群一多就没人管得住。
// 现在：落盘 + 每群一个默认上限 + 满了按时间丢最旧的（组之间也按"最久没消息"淘汰）。
export const UIMSG_DEFAULT = {
  perGroup: 30,      // 每群保留多少条（超出丢最旧的）—— 配置端那张卡片一屏就够看
  maxGroups: 30      // 最多保留多少个群（超出丢"最久没消息"的群）
};

// 纯函数：按时间留最新 per 条（乱序也能救回来）。单独导出是为了能直接测。
export function trimRecords(arr, per) {
  const a = (Array.isArray(arr) ? arr : []).slice();
  a.sort(function (x, y) { return (Number(x && x.at) || 0) - (Number(y && y.at) || 0); });
  if (per > 0 && a.length > per) return a.slice(a.length - per);
  return a;
}

export function createUiMessages(opts) {
  const o = opts || {};
  const file = o.file || null;
  const perGroup = Number(o.perGroup) > 0 ? Number(o.perGroup) : UIMSG_DEFAULT.perGroup;
  const maxGroups = Number(o.maxGroups) > 0 ? Number(o.maxGroups) : UIMSG_DEFAULT.maxGroups;
  const byGroup = new Map();
  const stats = { added: 0, evictedInGroup: 0, evictedGroups: 0, groups: 0 };
  let saveTimer = null;

  function lastAtOf(arr) { return arr && arr.length ? (Number(arr[arr.length - 1].at) || 0) : 0; }

  function trimGroups() {
    if (byGroup.size <= maxGroups) return;
    const list = [];
    for (const [k, arr] of byGroup) list.push({ k: k, last: lastAtOf(arr) });
    list.sort(function (a, b) { return a.last - b.last; });          // 最久没消息的先丢
    while (byGroup.size > maxGroups && list.length) {
      const victim = list.shift();
      byGroup.delete(victim.k);
      stats.evictedGroups += 1;
    }
  }

  function add(gid, rec) {
    const k = String(gid);
    let a = (byGroup.get(k) || []).slice();
    a.push(rec);
    const before = a.length;
    a = trimRecords(a, perGroup);
    stats.evictedInGroup += Math.max(0, before - a.length);
    byGroup.set(k, a);
    stats.added += 1;
    stats.groups = byGroup.size;
    trimGroups();
    stats.groups = byGroup.size;
    save(false);
    return a.length;
  }

  // 回填：判定是后一步才算出来的，把同一条消息的判定补上
  function update(gid, match, patch) {
    const a = byGroup.get(String(gid));
    if (!a) return false;
    for (let i = a.length - 1; i >= 0; i--) {
      if (match(a[i])) { Object.assign(a[i], patch); save(false); return true; }
    }
    return false;
  }

  function list(gid, limit) {
    const a = (byGroup.get(String(gid)) || []).slice();
    if (!limit) return a;
    return a.slice(-limit);
  }

  function all(limit) {
    const out = [];
    for (const [gid, arr] of byGroup) for (const r of arr) out.push(Object.assign({ gid: gid }, r));
    out.sort(function (a, b) { return (Number(a.at) || 0) - (Number(b.at) || 0); });
    return limit ? out.slice(-limit) : out;
  }

  function snapshot() {
    const out = {};
    for (const [k, arr] of byGroup) if (arr.length) out[k] = arr;
    return out;
  }
  function save(immediate) {
    if (!file) return;
    if (!immediate) {
      if (saveTimer) return;
      saveTimer = setTimeout(function () { saveTimer = null; save(true); }, 1500);
      if (saveTimer.unref) saveTimer.unref();
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(snapshot()), "utf8");
    } catch (e) {}
  }
  function load() {
    if (!file) return false;
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!v || typeof v !== "object") return false;
      for (const k of Object.keys(v)) {
        const a = trimRecords(v[k], perGroup);
        if (a.length) byGroup.set(String(k), a);
      }
      trimGroups();
      stats.groups = byGroup.size;
      return true;
    } catch (e) { return false; }
  }
  function flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } save(true); }

  load();
  return {
    add: add, update: update, list: list, all: all,
    groups: function () { return Array.from(byGroup.keys()); },
    perGroup: perGroup, maxGroups: maxGroups,
    flush: flush,
    stats: function () { return Object.assign({}, stats, { groups: byGroup.size }); }
  };
}
