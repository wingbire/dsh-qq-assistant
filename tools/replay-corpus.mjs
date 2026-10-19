// 回归回放：用标注过的语料重跑判定，看她的动作是否符合你的标注。
// 外审用"当时记录的结论"做桩 —— 不联网、不花钱、结果确定，适合每次改动后跑。
import fs from "node:fs";
import path from "node:path";
import { createGates } from "../app/src/gates.js";
import { loadCorpus, corpusFile, corpusStats } from "../app/src/corpus.js";

const dataDir = path.resolve(process.argv[2] || "app/dsh-data/data/data");   // 语料与标注都在 数据/数据 下（store.paths.labels 的同级）
const file = corpusFile(dataDir);
const items = loadCorpus(file).filter(function (i) { return i && i.expect; });
const st = corpusStats(loadCorpus(file));
if (!items.length) {
  console.log("还没有标注过的语料。先在配置端「标注」页给语料打上「该回 / 该不回 / 该短回」。" );
  process.exit(0);
}

const gates = createGates({
  auditFn: async function (text, ctx) {
    const item = items.find(function (i) { return i.text === text; });
    const v = (item && item.audit) || "short";
    return { verdict: v, channel: "stub" };
  },
  audit: { scope: "灰区也审", noAudit: "边界或提问", maxPerHour: 999, timeoutMs: 1000, onTimeout: "降档" }
});

let ok = 0;
const bad = [];
for (const it of items) {
  const evt = {
    gid: "CORPUS", uid: "u1", speaker: it.speaker || "", text: it.text,
    now: new Date(it.at).getTime() || 0, atBot: !!it.atBot, replyToBot: !!it.replyToBot, botNames: ["小肥鱼"], nicknames: ["肥鱼", "鲸鲸"],
    recentBotMention: true
  };
  const d = await gates.decide(evt, {});
  const said = d.action === "brain";
  const want = it.expect === "该不回" ? false : true;
  if (said === want) ok += 1;
  else bad.push({ it: it, got: d.action });
}

console.log("语料 " + st.total + " 条 / 已标注 " + st.labeled + " 条");
console.log("符合标注： " + ok + " / " + items.length + "（" + Math.round((ok / items.length) * 100) + "%）");
for (const b of bad) {
  console.log("  ✗ 「" + String(b.it.text).slice(0, 34) + "」 标注=" + b.it.expect + " 实际=" + b.got);
}
process.exitCode = bad.length ? 1 : 0;
