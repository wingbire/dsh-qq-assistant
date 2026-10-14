import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// 「社区插件兼容」：这些插件不是本程序的一部分，是社区做的 DSH 插件。
// 这里只做三件事：探测它们装没装、把配置翻译成程序能用的形式、给出安装通道。
// 本程序**不打包**它们（体积、许可证、以及它们本来就该由 DSH 那边管）。

export const COMMUNITY_PLUGINS = [
  {
    id: "ourFreeModel",
    name: "Our Free Model",
    pkg: "dsh-our-free-model",
    role: "外审通道",
    desc: "免费模型池（DeepSeek V4.1 Flash / Kimi K3 等）。外审是独立通道，走它不占你付费额度。",
    where: "qq-audit profile",
    install: { kind: "npm", value: "dsh-our-free-model", note: "装在 app/dsh-home/profiles/qq-audit，并把包名加进 dsh.profile.bundles" }
  },
  {
    id: "freeSearch",
    name: "dsh-free-search",
    pkg: "dsh-free-search",
    role: "搜索通道",
    desc: "24 个搜索引擎 + 智能路由与故障回退。开着就用它的引擎，关掉用本程序内置的直搜。",
    where: "app/vendor",
    install: { kind: "npm", value: "dsh-free-search", note: "装在 app/vendor，程序直接 import 它的引擎函数" }
  },
  {
    id: "archify",
    name: "archify",
    pkg: "@tt-a1i/archify-dsh",
    role: "图表绘制",
    desc: "把结构/流程画成图（SVG→PNG）。大脑画好之后由程序发进群，发完可以立刻删掉本地文件。",
    where: "dsh-home/skills/archify",
    install: { kind: "npm", value: "@tt-a1i/archify-dsh", note: "装完把它的 skills/archify 放进 app/dsh-home/skills" }
  },
  {
    id: "meme",
    name: "dsh-meme",
    pkg: "dsh-meme",
    role: "表情包图库",
    desc: "本地表情包图库（按情绪标签 + 关键词），唯一一个不用装就有默认路径的。",
    where: "~/.dsh/profiles/*/node_modules/dsh-meme",
    install: { kind: "manual", value: "在 DSH 桌面端装 dsh-meme 插件", note: "或者自己攒一套图放好，再用 meme.packDir 指过去" }
  }
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

export function createPluginProbe(opts) {
  const o = opts || {};
  const dshHome = o.dshHome;
  const vendorDir = o.vendorDir;
  const memeLib = o.memeLib || null;
  const cfgFn = o.config || function () { return {}; };

  function installedIn(profileName, pkgName) {
    const dir = path.join(dshHome, "profiles", profileName, "node_modules", pkgName);
    const p = readJson(path.join(dir, "package.json"));
    return p ? { version: p.version, dir: dir } : null;
  }

  function probe() {
    const cfg = cfgFn() || {};
    const plugins = cfg.plugins || {};
    const items = [];

    // ① Our Free Model —— 看外审 profile 装没装、bundles 里有没有它
    const auditPkgPath = path.join(dshHome, "profiles", "qq-audit", "package.json");
    const auditPkg = readJson(auditPkgPath) || {};
    const ofm = installedIn("qq-audit", "dsh-our-free-model");
    const bundles = ((auditPkg.dsh || {}).profile || {}).bundles || [];
    const ofmBundled = bundles.indexOf("dsh-our-free-model") >= 0;
    items.push({
      id: "ourFreeModel", name: "Our Free Model", role: "外审通道",
      installed: !!ofm, version: ofm ? ofm.version : null, bundled: ofmBundled,
      enabled: plugins.ourFreeModel !== false, ready: !!ofm && ofmBundled,
      detail: !ofm ? "还没装进外审 profile" : (ofmBundled ? "已装并已挂到 qq-audit" : "装了但没挂进 bundles"),
      model: plugins.ourFreeModelId || "（插件默认）"
    });

    // ② dsh-free-search —— 看 vendor 里能不能 import 到
    const fsPkg = readJson(path.join(vendorDir, "node_modules", "dsh-free-search", "package.json"));
    const fsEntry = path.join(vendorDir, "node_modules", "dsh-free-search", "lib", "index.js");
    const fsEntryOk = fs.existsSync(fsEntry);
    let fsDepsOk = true;
    const missingDeps = [];
    for (const dep of ["@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-settings", "@deepseek-ai/schemastery"]) {
      const ok = !!readJson(path.join(vendorDir, "node_modules", dep, "package.json"));
      if (!ok) { fsDepsOk = false; missingDeps.push(dep); }
    }
    items.push({
      id: "freeSearch", name: "dsh-free-search", role: "搜索通道",
      installed: !!fsPkg, version: fsPkg ? fsPkg.version : null, depsOk: fsDepsOk, missingDeps: missingDeps,
      enabled: plugins.freeSearch !== false, ready: !!fsPkg && fsEntryOk && fsDepsOk,
      engine: plugins.freeSearchEngine || "bing",
      detail: !fsPkg ? "还没装在 app/vendor" : (!fsEntryOk ? "装了但找不到 lib/index.js" : (fsDepsOk ? "可直接 import" : "缺依赖：" + missingDeps.join(", ")))
    });

    // ③ archify —— 技能装没装进工作区 DSH_HOME
    const skillDir = path.join(dshHome, "skills", "archify");
    const skillMd = path.join(skillDir, "SKILL.md");
    const hasSkill = fs.existsSync(skillMd);
    const hasCli = fs.existsSync(path.join(skillDir, "bin", "archify.mjs"));
    items.push({
      id: "archify", name: "archify", role: "图表绘制",
      installed: hasSkill, version: null, cliOk: hasCli,
      enabled: plugins.archify !== false, cleanup: plugins.archifyCleanup !== false,
      ready: hasSkill && hasCli,
      detail: !hasSkill ? "技能还没装进 app/dsh-home/skills/archify" : (hasCli ? "技能与 CLI 都在" : "有 SKILL.md 但没找到 bin/archify.mjs")
    });

    // ④ dsh-meme —— 图库能不能读出来
    const memeReady = !!(memeLib && memeLib.ready);
    items.push({
      id: "meme", name: "dsh-meme", role: "表情包图库",
      installed: memeReady, version: null,
      enabled: plugins.meme !== false && (cfg.persona || {}).memeFreq !== "关",
      ready: memeReady && plugins.meme !== false,
      pack: memeReady ? (memeLib.packDir || "") : null,
      count: memeReady ? (memeLib.rows || []).length : 0,
      detail: memeReady ? ("读到 " + (memeLib.rows || []).length + " 张图") : "没找到图库（可用 meme.packDir 指定）"
    });

    return { ok: true, items: items, dirs: { dshHome: dshHome, vendor: vendorDir } };
  }

  return { probe: probe };
}

function tail(s, n) {
  return String(s || "").trim().split(String.fromCharCode(10)).slice(-(n || 12)).join(String.fromCharCode(10));
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 一键安装：每种插件的动作都写死在这里，不接受任意命令
export function installPlugin(id, opts) {
  const o = opts || {};
  const run = o.run || function (args, runOpts) {
    return spawnSync(args[0], args.slice(1), Object.assign({ encoding: "utf8", windowsHide: true, shell: process.platform === "win32" }, runOpts || {}));
  };
  const dshHome = o.dshHome;
  const vendorDir = o.vendorDir;
  const npmCmd = o.npmCmd || "npm";
  const log = [];

  function npm(cwd, pkgs) {
    fs.mkdirSync(cwd, { recursive: true });
    const pkgFile = path.join(cwd, "package.json");
    if (!fs.existsSync(pkgFile)) fs.writeFileSync(pkgFile, JSON.stringify({ name: "dshqq-" + path.basename(cwd), private: true }, null, 2), "utf8");
    const r = run([npmCmd, "install", "--no-audit", "--no-fund"].concat(pkgs), { cwd: cwd, timeout: 600000 });
    log.push("$ npm install " + pkgs.join(" ") + "   (cwd=" + cwd + ")");
    log.push(tail((r && (r.stdout || r.stderr)) || "", 8));
    return !!(r && r.status === 0);
  }

  if (id === "ourFreeModel") {
    // 两个 profile 都要装：二判走 qq-audit，大脑走 qq-brain（只装一个会出现
    // "no adapter registered for provider our-free-model"）
    const profiles = ["qq-audit", "qq-brain"];
    for (const name of profiles) {
      const profileDir = path.join(dshHome, "profiles", name);
      if (!npm(profileDir, ["dsh-our-free-model"])) return { ok: false, error: "npm 安装失败（" + name + "）", output: log.join(String.fromCharCode(10)) };
      const pkgFile = path.join(profileDir, "package.json");
      const pkg = readJson(pkgFile) || {};
      pkg.dependencies = Object.assign({}, pkg.dependencies, { "dsh-our-free-model": "*" });
      const prof = ((pkg.dsh || {}).profile) || {};
      const bundles = prof.bundles || ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"];
      if (bundles.indexOf("dsh-our-free-model") < 0) bundles.push("dsh-our-free-model");
      pkg.dsh = Object.assign({}, pkg.dsh, { profile: Object.assign({}, prof, { bundles: bundles }) });
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + String.fromCharCode(10), "utf8");
      log.push("已把 dsh-our-free-model 挂进 " + name + " 的 bundles");
    }
    return { ok: true, output: log.join(String.fromCharCode(10)), note: "二判与大脑都能走它了（改完开关下一轮生效）" };
  }

  if (id === "freeSearch") {
    const ok = npm(vendorDir, ["dsh-free-search", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-settings", "@deepseek-ai/schemastery"]);
    return { ok: ok, output: log.join(String.fromCharCode(10)), error: ok ? null : "npm 安装失败" };
  }

  if (id === "archify") {
    if (!npm(vendorDir, ["@tt-a1i/archify-dsh"])) return { ok: false, error: "npm 安装失败", output: log.join(String.fromCharCode(10)) };
    const src = path.join(vendorDir, "node_modules", "@tt-a1i", "archify-dsh", "skills", "archify");
    const dst = path.join(dshHome, "skills", "archify");
    if (!fs.existsSync(src)) return { ok: false, error: "装完了但包里没有 skills/archify", output: log.join(String.fromCharCode(10)) };
    copyDir(src, dst);
    log.push("已把技能复制到 " + dst);
    return { ok: true, output: log.join(String.fromCharCode(10)), note: "大脑那边下一轮就能看到 archify 技能" };
  }

  if (id === "meme") {
    return { ok: false, manual: true, error: "dsh-meme 要在 DSH 桌面端装，或者自己攒一套图后用 meme.packDir 指过去" };
  }
  return { ok: false, error: "未知插件：" + id };
}
