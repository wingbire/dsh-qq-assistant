# DSH-QQ 小助手 · 维护手册（给 AI 维护者）

> 版本：v3.0.0 ｜ 最后更新：2026-10-22 ｜ 读者：接手维护的 AI（不是给用户看的说明书）
> 用户看得懂的入口文档在 docs/ 其他文件里；这份只讲「为什么这么写、哪里踩过坑、改之前必须知道什么」。

---

## 0. 一句话

一个零 npm 依赖的 Node 24 ESM 程序，接 OneBot v11（NapCat）当 QQ 群机器人「小肥鱼」；
「大脑」是每次回复时拉起的一个独立 DSH 进程（单轮回，prompt in → JSON out），
其余能力（搜索/识图/表情包/画图/B站/语音）都是**主程序自己实现 + 用标记驱动**。

## 1. 运行方式与目录

```
node app/main.js                 # 唯一入口（配置端 127.0.0.1:8799 同时起来）
app/main.js                      # 装配：读配置 → 建各服务 → 起 runtime → 连 OneBot
app/src/                         # 全部逻辑（ESM，无外部依赖）
app/dsh-data/config/app.json     # 用户配置（gitignore，不进仓库/包）
app/dsh-data/data/data/          # 语料、观测、校准、群档案（gitignore）
app/dsh-home/                    # DSH 侧的人设补丁 + 会话（gitignore）
prompts/配置端字段表.json         # 配置端 UI 的字段定义（= 事实来源）
tools/                           # 标定脚本、回放脚本、STT 服务
dist/                            # 打包产物（zip 也在这里）
test/run-tests.mjs               # 260 项回归测试，改任何东西先跑它
```

**大脑调用**（关键）：app/src/brain.js → DeepSeek Harness.exe 或 node cli.js 以**子进程**运行，
必须带 ELECTRON_RUN_AS_NODE=1（否则每次判定都会闪一个窗口，这是踩过的坑）。

## 2. 架构总览（一条消息的一生）

```
QQ 消息 → NapCat(WS:3001) → onebot 客户端 → runtime.handleEvent
  ├─ 管理指令（/回 N 等）→ 直接执行，不进判定
  ├─ 合并器 coalesce：同一人 windowMs 内连发 → 合成一批（默认 6000ms）
  ├─ 冷启动/反馈/预算等旁路检查
  └─ 每个 evt：
       gates.judge（本地判定：档位 U、pSay 概率、外审、长度档）
          → verdict: yes/grey/no → dec.action: brain/ignore
       ▼
       runtime.handleBatch：合并成 mergedDec（取最近一个 brain 决策，不重新判）
       ▼ 若 action=brain：
       拼 prompt（缓存优先顺序！见 §5）+ 搜索 + B站 + 表情菜单 + 记忆
       ▼
       brain（一次调用，JSON 输出 text/mood/quotes/…）
       ▼
       标记解析（[引用]/[表情]/[语音]/[立绘]/[图表]）→ 各自执行
       ▼
       分段发送（splitReply 软区间）→ 观测落盘 → 记忆计数 → 可能触发记忆整理
```

## 3. 核心模块职责

| 文件 | 职责 | 改动风险 |
|---|---|---|
| runtime.js | 一切编排：批处理、prompt、发送、记忆、B站/画图/表情接入 | **最高**，改前先读 §4/§5 |
| gates.js | 本地判定 + 外审；返回 action/verdict/tier/pSay | 高（容易变成一刀切）|
| probability.js | 开口概率模型（12 特征）+ FEATURE_KEYS | 中（特征与语料必须对齐）|
| classify.js | 文本特征（问句/请求/媒体/新鲜信息/搜索意图） | 中，**曾因 flags 层级写错导致搜索从不触发** |
| brain.js | 拼 prompt、调 DSH、解析 JSON | 高（人设拼接与缓存都在这里）|
| dshprofile.js | 人设文本 + 配置端人设补丁 + 标记解析 | 高（人设=行为）|
| split.js | 按软区间拆消息（句号优先，不硬截断） | 低，但改完要测 |
| corpus.js / train.js | 标注语料、训练（逻辑回归 + 留一 + 最佳阈值） | 中 |
| search.js | 免费搜索（kimi 引擎通道 c）+ 摘要 | 低 |
| vision.js | 图片下载/按文件头判格式/多模态识图 | 低 |
| bilibili.js | B站：标题/字幕/抽帧/配对音频/自己找 | 中 |
| diagram.js | 画图：大脑出 spec → archify 渲染 | 中 |
| meme.js | 表情包图库（多包合并）+ 选图 | 低 |
| chart.js | HTML→PNG（Edge headless）| 中（profile 冲突坑）|
| proactive.js | 主动搭话（兴趣命中 + 概率）| 中 |
| webui.js + webui/app.js | 配置端 API + 单页 UI | 中 |

## 4. 判定链路（最容易被改坏的地方）

**唯一决策点**：gates.judge 给出 action；合并时**取最后一个 brain 决策**，不重新判、不覆盖。

**红线（用户明确要求过）**：
1. **不要加死闸门**。已经删掉过：频率闸（5 分钟 2 条）、两人对话硬闸、话题降温闸。
   判断应该交给 pSay（概率）+ 大脑，而不是 if 地拦。
2. **长度是软的**：splitReply(text, soft, { maxSegments })，soft→hard = min(max(soft+20, soft*2), 300)，
   在标点处截断、**绝不直接截断丢内容**；runtime.maxSegments 默认 6。
3. 被点名/@/回复/叫外号 → 必须接话（人设里已写死这条）。
4. 外审有否决权，但**只在「要不要开口」上**否决；它不再决定长度。

## 5. 上下文与缓存（prompt 顺序为什么这样）

顺序（**稳定在前、易变在后**，为了前缀缓存命中）：
```
系统人设（字节稳定）→ 群档案(不含 memo) → 兴趣 → 可用表情包菜单 → 本轮任务 → 【记忆 memo】→ 上下文 → 图片/B站材料
```
- 人设必须是**纯函数输出**：不得含时间戳/随机数，否则缓存全废（实测命中 94~96%）。
- 记忆块**故意放在任务之后**（早期放在系统提示里，缓存命中掉过）。
- 上下文 contextBlock 用日志格式（· 时间 名字）+ 明确写「这是背景，不要复制」。
  之前被模型抄进正文（引用原文重复），这是修过的老问题。

## 6. 功能清单（含开关与配置键）

| 功能 | 开关（app.json） | 关键配置 | 备注 |
|---|---|---|---|
| 判定/开口 | 无 | runtime.contextWindow(20) runtime.coalesceWindowMs(6000) | 概率模型见 §4 |
| 搜索 | plugins.freeSearch | plugins.freeSearchEngine(kimi) | **2026-10 修：classify 的 flags 层级写错，搜索从未触发过** |
| 识图 | runtime.vision.enabled | runtime.vision.timeoutMs(90000) | 下载图按**文件头**判格式（QQ URL 全是 .jpg，实际常是 GIF）|
| 表情包 | plugins.meme | meme.packDir | 多图库合并（~/.dsh/meme-packs/* + profile/node_modules）|
| 画图 | plugins.archify | — | 大脑写 [图表: 一句话] → diagram.js 出 spec → archify render → PNG |
| B站看视频 | plugins.bilibili | runtime.bili.frames(4) maxMinutes(30) listenPerFrame(0) | 画面与音频**按时间点配对**；AI 字幕需登录 |
| 语音合成 | runtime.voice.enabled | runtime.voice.voice | Windows SAPI，本机 7 个音色 |
| 语音转写 | runtime.stt.enabled | endpoint(8910) | 本机 faster-whisper small；stt.autoStart 会自动拉起 |
| 立绘 | plugins.illustration | persona.youngPic/adultPic | **当前关**（两张图都为空）|
| 记忆（群档案）| runtime.memory.enabled | runtime.memory.everyN(30) | 每 N 条回复整理一次；顺带提炼「趣：领域词」 |
| 训练 | — | runtime.autoTrainAt(30) | 标注页「开始训练」/标够 N 条自动练 |
| 主动搭话 | runtime.proactive.enabled | rate / maxPerHour | 兴趣命中才搭话；群档案兴趣权重 ×0.4 |

## 7. 配置端（webui）结构

- 字段定义全在 prompts/配置端字段表.json（分组 = 页面）。加字段 = 改这个文件 + 让代码读它。
- 自定义卡片页：识图/本地语音/插件通道/额外功能/B站/标注页的大卡片。
- **凡是能力开关，人设里的能力段必须跟着开关走**（关掉就不写进人设），否则她会对用户承诺做不到的事。
  personaFromConfig 里 visionEnabled / voiceEnabled / biliEnabled / archifyEnabled / illustrationEnabled 都是这个模式。

## 8. 数据与临时文件

| 路径 | 内容 | 策略 |
|---|---|---|
| data/data/observation.jsonl | 判定/发送/错误观测 | 2000 行 / 2MB 轮转（.1 保留一份）|
| data/data/ui-messages.json | 配置端消息表 | 每群 30 条 |
| data/data/corpus.json | 标注语料 | 永久 |
| data/data/calibration.json | 训练出的权重+阈值 | 训练时覆盖 |
| dsh-data/brain/images、voice | 识图/语音临时文件 | **用完即删**（下载的才删，本机文件不动）|
| dsh-data/brain/charts | 画图中间产物 | 发完清理 |
| /tmp 里 bili-* | B站抽帧/抽音频 | 识完/转写完即删 |

## 9. 维护历史（按时间/问题记录）

> 只记「症状 → 根因 → 修法」，方便同样的坑不踩第二次。

**2026-10 上旬**
- 每次判定闪一个窗口 → 子进程没带 ELECTRON_RUN_AS_NODE=1。
- 引用回复把原文抄了 → 人设/上下文格式问题 → 上下文改日志格式 + echo_strip 兜底。
- 颜文字只会一种 (・ω・) → 她自己历史里的 tic 自我锚定 → stripOwnTics。
- 卡住的批量回复（嗯嗯啊啊）→ 本地兜底 + 重试都删掉，大脑一次调用，空=静默。

**2026-10 中旬**
- 群档案从来没接通（saveProfile 只在反馈重训里调）→ 改成「每 N 条回复自我总结」写 memo。
- 记忆压得太长 → 改成只记「她的互动」+ 滚动更新 ≤300 字。
- 「搜索从未触发」→ classify 返回的是 {flags:{...}}，gates 读 cls.explicitSearch 全是 undefined。**修：flags 平铺一层**。
- 「看不到图片」→ 扩展名从 URL 猜（QQ 全是 .jpg），实际是 GIF → 按**文件头**判格式。
- 表情包几乎不发 → 图库只读了第一个包（break）+ 没扫 ~/.dsh/meme-packs → 合并所有包（24→162 张）+ 把图库菜单放进 prompt。
- 主动搭话总在劝人换话题 → 这是**我写的降温指令**让 AI 替群友决定话题 → **整条删除**。
- 判定一直挂「判定中」→ 批处理异常被外层 catch 吞掉 + 重启丢批 → 每批单独 catch + markStale 定期标过期。

**2026-10 下旬**
- 「画图从来没生效」→ 人设让大脑写「HTML 绝对路径」，但它单轮跑不了 archify → **新增 diagram.js：大脑出 spec，程序渲染**。
- PNG 截图偶发失败 → Edge 抢用户主配置 → --user-data-dir 独立 profile。
- B站抽帧整段被跳过 → longVideo 声明在使用之后（TDZ）→ 调整顺序。
- 本地语音转写一直是坏的（模型只有元数据、缺 model.bin）→ 用 hf-mirror + HF_HUB_DISABLE_XET=1 下全 tiny/small，重启服务。
- 「没网查不了」→ 搜索闸门从未触发（见上）→ 修好后搜索正常。

## 10. 已知问题 / 待办

1. **B站 AI 字幕**：接口 need_login_subtitle=true，需要小号 SESSDATA（配置端已加字段）。填上后应优先用字幕，失败回退音频转写。
2. **B站发评论**：bili_jct 字段已加，评论链路未实现；实现时要先 dry-run + 频率限制 + 默认关。
3. **群档案兴趣词**：目前只在记忆整理时提炼「趣：领域词」，权重 ×0.4（主动搭话）/×1（B站取词，全局 ×3）。观察是否跑偏成具体名词。
4. **立绘**：plugins.illustration 已关（没图）。给了图记得打开并填 persona.youngPic/adultPic。
5. **训练**：上次结果 训练集 82% / 留一 72% / 阈值 0.62 → 83%。语料里 7 个特征（含 twoPerson/continuation）从未出现，
   新标注开始会带上；想让它学「两人对话别插」需要再标一批新语料。
6. **推送**：本地提交用 git push public main；github 直连经常 reset，需 Clash/Watt。

## 11. 日常运维命令

```bash
node test/run-tests.mjs                                   # 改完必跑（260 项）
node dist/build-package.mjs && powershell -File dist/make-zip.ps1   # 打包
node tools/calibrate.mjs                                  # 训练（或配置端点按钮）
node tools/replay-corpus.mjs                              # 语料回放核对
powershell -Command "Get-Process node | Stop-Process -Force"  # 重启前杀进程
Start-Process node -ArgumentList app/main.js -WindowStyle Hidden
git push public main                                      # 推送（用户也会自己推）
```

## 12. 改代码时的红线（逐条都是踩过的）

1. **先跑测试**，再把改动写进 docs/回归清单.md 的对应项。
2. **不要**给「要不要说话」加 if 判断；交给概率模型 + 大脑。
3. **不要**写具体的话术范例进人设（用户明确反对）。标记语法（[表情: 描述]）必须有，但不要写「比如你说：XXX」。
4. **人设是纯函数**，不得含时间戳/随机。
5. **能力开关 ↔ 人设段**必须同时改，否则她会对做不到的事打保票。
6. **临时文件用完即删**（图片/音频/抽帧/图表），文字结果留在观测里就够。
7. 配置端字段必须以 prompts/配置端字段表.json 为准；加字段要确认有人读、有页面渲染。
8. **推送/发布只做本地提交**，除非用户明确说推。

---

*(本文件是给 AI 维护者的；用户版说明见 docs 下其他文档。)*
