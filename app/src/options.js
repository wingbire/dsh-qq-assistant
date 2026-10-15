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

// 依赖式候选（通用）：当 A 字段决定 B 字段能选什么时，用 { by, when, fallback } 描述 ——
// 配置端渲染时会按 A 的当前值挑对应那份列表，A 一变（选中即生效）列表立刻跟着变。
export function dependentOptions(by, when, fallback) {
  return { by: by, when: when || {}, fallback: fallback || [] };
}

// 按「控制字段」的当前值解析出真正该显示的候选（纯函数，便于测试）
export function resolveSelect(list, values) {
  if (Array.isArray(list)) return list;                       // 无依赖：老结构，直接就是列表
  if (!list || !list.by) return [];
  const v = values && values[list.by];
  const key = v == null ? '' : String(v);
  const hit = list.when && list.when[key];
  return (hit || list.fallback || []).slice();
}
// 只认已知 provider（目录里还有 .credentials.yaml、channel-pack、attachments 这类噪音，
// 靠"猜目录名"会把它们一起列进来）。未知 provider 请直接手填 —— 不编造候选。
// 免费池候选要按最近一次探测结果过滤：OpenCode 那批 *-free 会拒绝第三方调用
// （"can only be used from within OpenCode"），以前下拉里照列，选了就等于外审静默失效。
export function availableOfmIds(availability, ids) {
  const res = (availability && availability.results) || {};
  return (ids || []).filter(function (id) {
    const r = res[id];
    if (!r) return true;                       // 没测过的不砍（不能因为没数据就全删）
    return r.state === "available";
  });
}

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
  // 大脑模型：跟着 provider 走（deepseek-official → v4 命名；our-free-model → 免费池目录）
  if (models.length) {
    opts["brain.model"] = dependentOptions("brain.provider", {
      "deepseek-official": COMMON_MODELS,
      "our-free-model": ofmIds,
      "openai-gateway": []
    }, COMMON_MODELS);
  }
  // 外审模型：跟着外审通道走（免费池 → OFM 目录；DSH 默认 → deepseek-v4-*）
  opts["audit.model"] = dependentOptions("audit.channel", {
    "免费池": ofmIds,
    "DSH 默认": DSH_AUDIT_MODELS
  }, DSH_AUDIT_MODELS);
  // 识图：dsh 只能选「同大脑」；http 交给「多模态接口自检」那个下拉（这里不出通用下拉）
  opts["runtime.vision.model"] = dependentOptions("runtime.vision.mode", { "dsh": ["同大脑"], "http": [] }, []);
  opts["runtime.vision.provider"] = dependentOptions("runtime.vision.mode", { "dsh": providers, "http": [""] }, [""]);
  if (voices.length) opts["runtime.voice.voice"] = voices;
  opts["runtime.stt.lang"] = STT_LANGS.slice();
  return opts;
}
