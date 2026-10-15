// 可下拉选择的字段：把"能列出来的候选"集中在这里算，配置端只负责渲染。
// 原则：列得出来的就给下拉（选中即生效），列不出来的保持手填 —— 绝不编造候选。
export const STT_LANGS = ["auto", "zh", "en", "ja", "ko", "yue"];

// DSH 里 provider 名和它落盘目录的对应（目录名不等于 provider 名，这里统一）
export const PROVIDER_DIR_MAP = {
  "llm-deepseek": "deepseek-official",
  "our-free-model": "our-free-model",
  "openai-gateway": "openai-gateway"
};

// 常见但不保证：只在"列不出真实清单"时当提示，标注为「常见」，用户仍可手填别的
export const COMMON_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4.1-flash"];   // DSH 里实际的 v4 命名
export const DSH_AUDIT_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4.1-flash"];

// 只认已知 provider（目录里还有 .credentials.yaml、channel-pack、attachments 这类噪音，
// 靠"猜目录名"会把它们一起列进来）。未知 provider 请直接手填 —— 不编造候选。
export function providerIdsOf(dirs) {
  const have = {};
  for (const d of (dirs || [])) have[String(d || "").trim()] = true;
  const out = [];
  for (const name of Object.keys(PROVIDER_DIR_MAP)) {
    if (have[name]) out.push(PROVIDER_DIR_MAP[name]);
  }
  return out;
}

// 组装"哪些字段可以下拉 + 各自候选"
export function buildSelectOptions(o) {
  const op = o || {};
  const providers = (op.providers || []).filter(Boolean);
  const ofmIds = (op.ofmIds || []).filter(Boolean);
  const voices = (op.voices || []).filter(Boolean);
  const models = [];
  for (const x of COMMON_MODELS.concat(ofmIds)) if (models.indexOf(x) < 0) models.push(x);
  const opts = {};
  if (providers.length) {
    opts["brain.provider"] = providers;
    opts["runtime.vision.provider"] = [""].concat(providers);   // dsh 模式才用，允许留空
  }
  if (models.length) opts["brain.model"] = models;
  // 外审用的模型：免费池就选 OFM 的，走 DSH 就选 deepseek-v4-*（下拉里两类都列，字段说明写清了怎么选）
  const am = [];
  for (const x of DSH_AUDIT_MODELS.concat(ofmIds)) if (x && am.indexOf(x) < 0) am.push(x);
  if (am.length) opts["audit.model"] = am;
  if (voices.length) opts["runtime.voice.voice"] = voices;
  opts["runtime.stt.lang"] = STT_LANGS.slice();
  return opts;
}
