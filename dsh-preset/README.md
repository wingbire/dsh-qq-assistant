# 三档 preset（已被取代，留作历史）

> **结论：这里的三个 `*.preset.yml` 不能被 `dsh --patch` 使用，也不要再用它们。**

## 为什么

DSH 的 `--patch` 只接受**顶层是 loader patch 数组**的 YAML：

    [ { "id": "system-prompt", "config": { "personaPrefix": "…" } } ]

而这三个文件是「agent preset 形状」（顶层是 `id/name/systemPrompt/agent/tools/invocation` 的映射），
还带了 `personaPrefixFile` / `invocation` / `tools.enabled` 这些 **DSH 根本不认识的键**（是当时设计装配器时设想出来的）。
实测直接报错：

    $ dsh --profile qq-brain --patch dsh-preset/qq-brain-low.preset.yml --dump-config
    Error: dsh: overlay … must be a top-level YAML array of loader patch entries

## 现在实际怎么做的

程序启动时会自己往**工作区内的 DSH_HOME** 里写 profile 与三档 overlay（见 `app/src/dshprofile.js`）：

    app/dsh-home/profiles/qq-brain/
      cordis.patch.yml      ← 人设（personaPrefix），三档共用、字节完全一致 → 前缀缓存跨档共享
      tier-low.patch.yml    ← agent-default-model.config.reasoningEffort = off
      tier-mid.patch.yml    ← low
      tier-high.patch.yml   ← high

调用形状：

    dsh --profile qq-brain --patch tier-mid.patch.yml headless --json "<本轮任务>"

这样做的好处是**人设前缀在三个档之间逐字节相同**，缓存能跨档命中；用三个独立 profile 反而会各自一份脚手架、各自一份会话状态。

## 实测（2026-10-14）

- `reasoningEffort` 会被 `dsh-agent-default-model` 接受并出现在合成配置里，真实调用 EXIT=0
- 同一 profile 连打两次，前缀缓存命中率 **96.1% / 94.0%**
