import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT, ensureDir } from "./paths.js";

export const SCHEMA_VERSION = 1;

export const STORE_LIMITS = {
  jsonlMaxLines: 5000,
  jsonlMaxBytes: 4 * 1024 * 1024,
  profileMaxGroups: 200,
  brainTempMaxAgeMin: 60,
  keepGenerations: 1
};

export function createStore(root, limits) {
  const base = root || DATA_ROOT;
  const lim = Object.assign({}, STORE_LIMITS, limits || {});
  const dataDir = path.join(base, "data");
  const cfgDir = path.join(base, "config");
  const brainDir = path.join(base, "brain");
  ensureDir(dataDir);
  ensureDir(cfgDir);

  const paths = {
    rules: path.join(dataDir, "rules.json"),
    feedback: path.join(dataDir, "interaction-feedback.jsonl"),
    labels: path.join(dataDir, "labels.jsonl"),
    profiles: path.join(dataDir, "profiles"),
    weights: path.join(dataDir, "addressee-weights.json"),
    bandit: path.join(dataDir, "bandit-state.json"),
    cache: path.join(dataDir, "reply-cache.json"),
    stages: path.join(dataDir, "stages.json"),        // 分群阶段（含"手动跳过观察期"）—— 要活过重启
    budget: path.join(dataDir, "budget.json"),        // 今日已用 token —— 不落盘的话日熔断重启即失效
    brakes: path.join(dataDir, "brakes.json"),        // 按群暂停（含配置端"关掉本群"）—— 重启后还得停着
    localreplies: path.join(dataDir, "localreplies.json"),  // 每群最近说过的本地短答 —— 重启后别又从头"嗯？啥事"
    uimessages: path.join(dataDir, "ui-messages.json"),      // 配置端"收到的消息"缓冲 —— 每群上限 30 条，满了丢最旧
    schema: path.join(dataDir, "schema.json"),
    observe: path.join(dataDir, "observation.jsonl"),
    brain: brainDir
  };

  function readJson(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return fallback; }
  }
  function writeJson(p, v) {
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
    return p;
  }
  function jsonlCount(p) {
    try { return fs.readFileSync(p, "utf8").split(String.fromCharCode(10)).filter(Boolean).length; } catch (e) { return 0; }
  }
  function jsonlBytes(p) {
    try { return fs.statSync(p).size; } catch (e) { return 0; }
  }
  function rotate(p) {
    if (!fs.existsSync(p)) return false;
    const bak = p + ".1";
    try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch (e) {}
    try { fs.renameSync(p, bak); return true; } catch (e) { return false; }
  }
  function appendJsonl(p, v, opts) {
    const o = opts || {};
    const maxLines = o.maxLines || lim.jsonlMaxLines;
    const maxBytes = o.maxBytes || lim.jsonlMaxBytes;
    ensureDir(path.dirname(p));
    if (jsonlCount(p) >= maxLines || jsonlBytes(p) >= maxBytes) rotate(p);
    fs.appendFileSync(p, JSON.stringify(v) + String.fromCharCode(10), "utf8");
    return p;
  }
  function readJsonl(p, limit) {
    const out = [];
    const limitFiles = [p, p + ".1"];
    for (const fp of limitFiles) {
      let raw = "";
      try { raw = fs.readFileSync(fp, "utf8"); } catch (e) { continue; }
      for (const line of raw.split(String.fromCharCode(10))) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (e) {}
      }
    }
    if (limit && out.length > limit) return out.slice(out.length - limit);
    return out;
  }
  function listProfiles() {
    try { return fs.readdirSync(paths.profiles).filter(function (f) { return f.endsWith(".json"); }); } catch (e) { return []; }
  }
  function pruneProfiles() {
    const all = listProfiles();
    if (all.length <= lim.profileMaxGroups) return 0;
    const rows = [];
    for (const f of all) {
      const fp = path.join(paths.profiles, f);
      let at = 0;
      try { at = fs.statSync(fp).mtimeMs; } catch (e) {}
      rows.push({ fp: fp, at: at });
    }
    rows.sort(function (a, b) { return b.at - a.at; });
    let removed = 0;
    for (const r of rows.slice(lim.profileMaxGroups)) { try { fs.unlinkSync(r.fp); removed += 1; } catch (e) {} }
    return removed;
  }
  function pruneBrainTemp(now) {
    const t = Number(now) || Date.now();
    let removed = 0;
    try {
      for (const f of fs.readdirSync(brainDir)) {
        const fp = path.join(brainDir, f);
        let st = null;
        try { st = fs.statSync(fp); } catch (e) { continue; }
        if (t - st.mtimeMs > lim.brainTempMaxAgeMin * 60000) { try { fs.unlinkSync(fp); removed += 1; } catch (e) {} }
      }
    } catch (e) {}
    return removed;
  }
  function writeSchema(info) {
    return writeJson(paths.schema, Object.assign({
      schemaVersion: SCHEMA_VERSION, limits: lim, updatedAt: new Date().toISOString()
    }, info || {}));
  }

  ensureDir(paths.profiles);
  ensureDir(brainDir);
  // 存储契约 §一：schema 快照在启动时写（此前只实现了函数、从没被调用）
  try { if (!fs.existsSync(paths.schema)) writeSchema({ writtenBy: "createStore" }); } catch (e) {}

  return {
    paths: paths, limits: lim, schemaVersion: SCHEMA_VERSION,
    readJson: readJson, writeJson: writeJson,
    appendJsonl: appendJsonl, readJsonl: readJsonl, rotate: rotate,
    jsonlCount: jsonlCount, jsonlBytes: jsonlBytes,
    loadProfile: function (gid) { return readJson(path.join(paths.profiles, "g-" + String(gid) + ".json"), null); },
    saveProfile: function (gid, prof) { return writeJson(path.join(paths.profiles, "g-" + String(gid) + ".json"), prof); },
    loadBandit: function () { return readJson(paths.bandit, null); },
    saveBandit: function (s) { return writeJson(paths.bandit, s); },
    loadStages: function () { return readJson(paths.stages, null); },
    saveStages: function (s) { return writeJson(paths.stages, s); },
    loadBrakes: function () { return readJson(paths.brakes, null); },
    saveBrakes: function (s) { return writeJson(paths.brakes, s); },
    addLabel: function (rec) { return appendJsonl(paths.labels, Object.assign({ at: new Date().toISOString() }, rec), { maxLines: 2000 }); },
    addObservation: function (rec) { return appendJsonl(paths.observe, Object.assign({ at: new Date().toISOString() }, rec)); },
    pruneProfiles: pruneProfiles, pruneBrainTemp: pruneBrainTemp, writeSchema: writeSchema
  };
}
