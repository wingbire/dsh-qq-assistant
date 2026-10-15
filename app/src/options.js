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
export const COMMON_MODELS = ["deepseek-flash", "deepseek-chat", "deepseek-reasoner"];

export function providerIdsOf(dirs) {
  const out = [];
  for (const d of (dirs || [])) {
    const name = String(d || "").trim();
    if (!name) continue;
    if (["attachments", "profiles", "sessions", "skills", "storages", "profiles"].indexOf(name) >= 0) continue;
    const id = PROVIDER_DIR_MAP[name] || name;
    if (out.indexOf(id) < 0) out.push(id);
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
  if (voices.length) opts["runtime.voice.voice"] = voices;
  opts["runtime.stt.lang"] = STT_LANGS.slice();
  return opts;
}
