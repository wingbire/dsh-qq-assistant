# 架构

> 本文是**技术架构**：进程怎么起、模块怎么分工、数据落在哪、一轮消息怎么走。
> 为什么这么切见《设计理念》（DESIGN.md）；怎么运维见《维护手册-AI》。

## 1. 总览

一个**单进程 Node 应用** + 若干外部进程，零 npm 依赖（只用 Node 内置能力与系统里已有的 Electron）。

```
┌─────────────────────────────────────────────────────────────┐
│  app/main.js            组合根（依赖装配、生命周期、开机自检） │
├─────────────────────────────────────────────────────────────┤
│  runtime.js             编排：事件 → 判定 → 组 prompt → 大脑  │
│    ├── onebot.js        OneBot v11 WS 客户端（收/发/引用）    │
│    ├── gates.js         要不要说 + 说多长（本地概率 + 灰区）  │
│    ├── audit.js         灰区外审（同一决策对象的复核）        │
│    ├── brain.js         DSH 子进程调用（一次性问答）          │
│    ├── dshprofile.js    人设分层：L1 生成 + profile 补丁       │
│    ├── meme/tts/split   输出协议（表情包 / 语音 / 分段）      │
│    ├── vision/stt       材料预处理（图片描述 / 语音转写）     │
│    └── store.js         观测落盘（observation / ui-messages） │
├─────────────────────────────────────────────────────────────┤
│  webui.js + webui/*     配置端（127.0.0.1:8799）              │
├─────────────────────────────────────────────────────────────┤
│  napcat.js              NapCat 守护（拉起 / 探活 / 令牌同步） │
└─────────────────────────────────────────────────────────────┘
        ↓ 子进程                          ↓ 外部进程
  dsh --profile qq-brain             NapCat（OneBot WS 服务）
```

三个外部依赖，都由程序自己管：

| 依赖 | 作用 | 谁拉起 |
|---|---|---|
| NapCat | QQ ↔ OneBot v11 WebSocket | `napcat.js`（可配置自动拉起/关闭）|
| DSH CLI | 大脑（一次性问答）| `brain.js` 每次调用时 spawn |
| 可选侧车 | 本地 STT（faster-whisper）| `main.js` 的 `ensureSttServer()` |

## 2. 分层与模块的对应关系

| 层 | 职责 | 主要模块 |
|---|---|---|
| **L1 角色本体** | 生成系统提示词、写 profile 补丁 | `dshprofile.js`、`config.js`、`brain.js` |
| **L2 交互环境** | 环境选择、环境块、判定、输出协议 | `runtime.js`、`onebot.js`、`gates.js`、`audit.js`、`meme.js`、`tts.js`、`split.js` |
| **L3 档案与学习** | 档案、记忆、兴趣、标定 | `profile.js`、`corpus.js`、`train.js`、`label.js`、`feedback.js`、`bandit.js`、`tools/calibrate.mjs` |
| 横切 | 配置、观测、守护、更新 | `webui.js`、`store.js`、`uimessages.js`、`napcat.js`、`update.js` |

模块名与层不是一一对应 —— 例如 `gates.js` 只服务 L2，`dshprofile.js` 只服务 L1。**判断某个功能属于哪一层，看它跨环境要不要重写**。

## 3. L1 的实现

### 3.1 生成链路

```
配置(app.json)
   ↓ config.js            读取 + 默认值 + 迁移
personaFromConfig(cfg)    字段归一化（名字/年龄/外形/性格/语气/归属/开关）
   ↓
buildPersonaText(p, cfg)  拼出 L1 文本（章节：身份内核 / 性格 / 说话方式 / 归属 /
                                             我可以 / 绝不 / 态度 / 形象）
   ↓
renderProfilePatch(...)   包成 DSH 的 profile patch（system-prompt 条目）
   ↓
writeProfilePatch(...)    写到 app/dsh-home/profiles/qq-brain/cordis.patch.yml
```

**L1 只在启动时（或人设变更时）重写一次**，运行期不碰。这是前缀缓存的前提。

### 3.2 profile 的落盘结构

```
app/dsh-home/profiles/qq-brain/
  cordis.yml                 主配置（模型、插件、会话）
  cordis.patch.yml           人设补丁（system-prompt = L1 文本）
  tier-low.patch.yml         低档：短评，不调大脑
  tier-mid.patch.yml         中档：总结
  tier-high.patch.yml        高档：详细回答
```

三档只改**模型调用参数**，不碰人设 —— 所以三档的 persona 前缀字节完全一致，缓存可以跨档共享。这是「一个 profile + 三个补丁」而不是「三个 profile」的原因。

### 3.3 大脑调用（`brain.js`）

```
spawn(dsh, [--profile qq-brain, --patch tier-*, --json])
  env: ELECTRON_RUN_AS_NODE=1    ← 关键：用 Electron 当 Node 跑 CLI
       DSH_HOME=<工作区>/app/dsh-home
       DEEPSEEK_API_KEY=<从 secrets 读>
输入：promptText（整段 prompt 从 stdin/参数传入）
输出：JSON 事件流 → parseEvents() 抽出 text / usage / sessionId
```

**一次性问答，没有工具循环**：她所有能力都通过 prompt 里的标记表达，程序负责执行。这是「行为可控」的根源。

失败分类：`launch 找不到` / `超时` / `provider 报错`（例如免费模型不认 reasoningEffort）/ `空输出`。每类都落到 `brain_error` 并给出兜底话术。

## 4. L2 的实现

### 4.1 环境选择与注入

```
evt.channel（默认 group）
   ↓
buildChannelText(channel, persona, cfg)   → 该环境的环境块（字符串）
   ↓
runtime 组 prompt 时插在 L1 之后、L3 之前
```

`channel` 由各入口设置：OneBot 群事件 → `group`；私聊事件 → `private`（待接）；B站轮询 → `bili`（待接）。

### 4.2 QQ 群环境（参考实现）

#### 4.2.1 事件入口 `onebot.js`

- WebSocket 客户端，兼容两种鉴权头（`Authorization: Bearer` 与 `access_token` 参数）。
- 归一化事件：群消息 / 私聊消息 / 戳一戳 / 图片 / 语音 → 统一结构 `{gid, uid, speaker, text, atBot, replyId, ...}`。
- 发送：`send_group_msg`，支持引用（`reply` 字段）、图片（base64 或 file）。
- 引用原文：`get_msg` 拉被引用消息内容（带内存缓存），失败不阻断。

#### 4.2.2 合批 `coalesce.js`

同一人在窗口期（默认 6000ms）内连发合并成一批，避免逐条判断导致的碎片回复。窗口可配，批大小有上限。

#### 4.2.3 判定 `gates.js`

```
输入：消息文本、发送者、是否@、是否回复她、群档案兴趣、上下文热度、成本
   ↓ 六因子加权（probability.js 提供权重与阈值，来自 calibration.json）
输出：{ speak: 是否开口, tier: low|mid|high, maxChars, reason }
        灰区 → 交给 audit.js 外审（一次独立调用，只审这一个决策对象）
```

配套模块（都在这一层，但职责不同）：

| 模块 | 职责 |
|---|---|
| `classify.js` | 意图粗分类（求助 / 闲聊 / 详细问 / 语气词）|
| `addressee.js` | 判定这句话在跟谁说（是不是她）|
| `utility.js` | 效用值（值不值得开口）|
| `brakes.js` | 短期刹车（连续无回应的退让，不是硬闸门）|
| `guard.js` | 注入/越权话术的基础防护 |
| `gatescore.js` / `score.js` | 打分与阈值工具 |
| `localreply.js` | 低档「不调大脑」的本地短答 |

#### 4.2.4 组 prompt（`runtime.js`）

```
blocks = []
  pFacts        本群事实（谁是谁、成员规模）
  pInterests    兴趣与在聊话题
  channelBlock  L2 环境块            ← 本次重构新增的位置
  taskText      本轮任务（含引用原文、B站材料、失败提示）
  pMemo         L3 记忆（她记下的事）
  ctxBlock      最近 N 条群消息
  visionTexts   图片描述 / 语音转写
```

顺序固定，L1 在系统提示词里、不重复出现在这里。

#### 4.2.5 输出协议

| 模块 | 处理 | 失败时 |
|---|---|---|
| `meme.js` | `[表情: 描述]` → 按标签圈定 + 文本打分选图 | 分数不足则不配图 |
| `tts.js` | `[语音: 内容]` → 本机 SAPI 合成 wav | 合成失败只发文字 |
| `split.js` | 长文按句号切段（≤6 段）| 绝不截断 |
| `chart.js` + `diagram.js` | `[图表: 说明]` → 规格 → 渲染 → PNG | 失败则无图（正文保留）|
| illustration | `[立绘]` → 发配置图 | 无图则忽略 |
| 引用 | `[引用]` → 带 reply 发送 | 无原消息则忽略 |

#### 4.2.6 发送与观测

- 发送按段进行，段间有节奏控制（`sendGapMs`），避免风控。
- 每轮落 `observation.jsonl`：`decision` / `sent` / `meme_by_tag` / `meme_fail` / `brain_error` / `batch_fail` / `bili_watch` / `bili_fail`。
- 配置端「消息表」读 `ui-messages.json`（最近 N 条，含判定与动作）。

#### 4.2.7 自愈与隔离

| 场景 | 处理 |
|---|---|
| 单批抛错 | try/catch 包住整批 → `batch_fail` + 标记该批 error，下一批继续 |
| 状态悬挂 | 每 ≥60 秒 `markStale(180000)` 清理超时行 |
| 大脑报错 | 回一句兜底话术（不静默消失）|
| 发送失败 | 记录并继续下一段（不重试整段）|

### 4.3 QQ 私聊环境（框架占位）

```
入口：OneBot 私聊事件（message_type=private）
环境块：buildChannelText('private')  ← 已实现
待接：
  · 事件路由到 runtime 并设置 channel=private
  · 好友白名单（仅好友可私聊）
  · 私聊档案（L3 键 = uid）
  · 审批指令通道（关键词：发 / 不发 / 其它=正常聊天）
```

### 4.4 B 站评论区环境（框架占位）

```
入口：定时轮询指定视频的评论（不是事件流）
环境块：buildChannelText('bili')  ← 已实现
待做：
  · 评论读取（x/v2/reply，已验证可匿名读）
  · wbi 签名 + 发评论（x/v2/reply/add，需 SESSDATA + csrf）
  · @ 人（必须用 UID，昵称点不到人）
  · 人工审批（QQ 私聊关键词，见维护手册 10.5）
  · 独立限流 + 每日上限 + 异步（不占 QQ 队列）
```

## 5. L3 的实现

### 5.1 档案（`profile.js`）

```
app/dsh-data/data/profiles/g-<gid>.json
  { nicknames: {}, interests: [], interestStats: {}, memo: [], personaText: '', ... }
```

- 键：群号（未来：私聊用 uid）。
- 内容：谁是谁 / 常聊话题 / 兴趣词 / 她记下的事 / 该群专属规则。
- 兴趣有「固化」与「降级」：命中次数 + 跨天数达标才算稳定。

### 5.2 记忆与语料

| 模块 | 职责 |
|---|---|
| `store.js` | 观测与档案落盘（原子写）|
| `corpus.js` | 收集可用于标注/训练的样本 |
| `train.js` | 触发一轮本地训练/标定 |
| `label.js` | 标注工具（该回 / 短回 / 不回）|
| `feedback.js` | 把运行结果反馈到标定数据 |
| `bandit.js` | 探索-利用（开口策略的小幅试探）|
| `tools/calibrate.mjs` | 由标注数据算出推荐权重与阈值 |

### 5.3 学习回路

```
运行 → observation.jsonl → 标注 → calibrate.mjs → calibration.json
                                                    ↓
                                          probability.js 读取新权重/阈值
```

## 6. 配置端

```
webui.js             HTTP 服务（127.0.0.1:8799，仅本机）
   GET  /api/status    运行状态
   GET  /api/config    字段表 + 当前值（secret 遮蔽为「已配置」）
   POST /api/config    局部保存（深合并，不提交的字段不动）
   GET  /api/profile   群档案
   GET  /api/bili/login  一键扫码登录（轮询取 cookie）
webui/app.js         单页前端（无框架，原生 DOM）
webui/app.css        样式
```

**字段表驱动**：`prompts/配置端字段表.json` 定义所有可配字段（分组 / 标签 / 类型 / 默认值 / 说明）。前端按分组渲染，服务端按同一份表做校验与默认值填充。

人设页现在的四张卡对应 L1：全局人设 / 形象与立绘 / 用户信息 / 群聊专属人设（后者是 L3）。

## 7. 进程与守护

| 模块 | 职责 |
|---|---|
| `napcat.js` | 拉起/关闭 NapCat、探活、令牌同步、配置读写 |
| `update.js` | 检查更新（对比远端版本与本地文件）|
| `paths.js` | 路径常量（工作区、数据、临时）|
| `index.js` | 应用入口（供测试与嵌入调用）|
| `options.js` | 命令行参数 |
| `commands.js` | 配置端触发的运维命令 |
| `plugins.js` | 社区插件探测与兼容 |
| `ofm.js` | Our Free Model 通道（免费模型接入）|
| `secrets.js` | 密钥存取与遮蔽 |

## 8. 数据与文件布局

| 路径 | 内容 | 写入者 |
|---|---|---|
| `app/dsh-data/config/app.json` | 全部配置 | 配置端 |
| `app/dsh-data/config/secrets.json` | 密钥（单独文件）| 配置端 |
| `app/dsh-data/data/profiles/g-*.json` | 群档案（L3）| runtime |
| `app/dsh-data/data/observation.jsonl` | 决策与发送观测 | runtime |
| `app/dsh-data/data/ui-messages.json` | 配置端消息表 | runtime |
| `app/dsh-data/data/calibration.json` | 判定标定结果 | calibrate |
| `app/dsh-home/profiles/qq-brain/` | DSH profile（L1 与三档补丁）| dshprofile |
| `app/dsh-data/brain/` | 临时目录（语音、图片、图表、profile）| runtime |
| `prompts/*.template.md` | 人设/档案/外审模板 | 打包 |

临时文件统一在 `app/dsh-data/brain/` 下，发完即删。

## 9. 关键时序

### 9.1 一条群消息

```
NapCat → WS → onebot.js → coalesce(6s) → runtime.onEvent
  → gates（本地）→ [灰区] audit → 组 prompt → brain.spawn
  → 解析标记 → 生成语音/图片/图表 → split 分段 → send_group_msg
  → observation.jsonl + ui-messages
```

### 9.2 人设变更

```
配置端保存 → writeProfilePatch（重写 cordis.patch.yml）
           → 提示「重启后生效」（L1 不进运行期内存）
```

### 9.3 一键扫码登录（B 站）

```
配置端点按钮 → bililogin.js 启动独立 Edge（调试端口 9333）
  → 用户扫码 → CDP 读 cookie（SESSDATA / bili_jct）
  → 写入配置 → bili.setAuth() 热生效 → 自动关窗口
```

## 10. 成本结构

| 部分 | 典型量级 | 说明 |
|---|---|---|
| L1（系统提示词）| 约 1.5~2K tokens，命中缓存 | 缓存命中率 94%~96%，成本约为原价 1/10 |
| L2 + L3 + 上下文 | 每轮变化 | 不进缓存前缀 |
| 识图 | 每帧约 1K 输入 | 只在需要时抽帧 |
| 本地短答 | 0 | 低档不调大脑 |

省 token 的优先级：前缀缓存 > 缩短 L1 > 减少大脑调用 > 减少识图帧数。

## 11. 测试与可观测

- `node test/run-tests.mjs`：**260 项**骨架回归（模块级 + 集成级，含真实的 DSH 子进程调用测试）。
- `app/dsh-data/_probe/`：临时诊断脚本（gitignore，不入包）。
- 配置端「状态」页：判定分布、分档、缓存命中率、最近决策。

## 12. 扩展点

| 想加什么 | 动哪里 |
|---|---|
| 新环境（如 Discord）| `buildChannelText` 加分支 + 字段表加 `channels.*` + 入口适配 + L3 键 |
| 新输出能力（如表情反应）| 环境块加一条 + runtime 解析标记 + 执行模块 |
| 新判定因子 | `probability.js` 因子表 + `calibrate.mjs` 重算 |
| 新 L1 字段 | `personaFromConfig` + `buildPersonaText` + 字段表 + 配置端卡片 |

## 13. 已知边界

- **单进程**：所有环境共享一个事件循环，新环境必须异步，不能占用群聊队列。
- **L1 变更需重启**：人设写进 profile 文件，运行期不重读。
- **私聊与 B 站 未接线**：环境块已就位，通道层待做。
- **无工具循环**：她不能主动查询外部信息，除非程序把材料塞进 prompt。
