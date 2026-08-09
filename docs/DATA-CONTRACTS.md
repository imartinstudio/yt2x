# 数据契约（Data Contracts）

本文件描述 **磁盘产物** 与 **`process-status.json`** 的约定，与实现源码对齐处已标注。权威 Zod 定义在 `packages/core/src/domain/pipeline/state.ts`。

## 1. 每视频目录 `<outDir>/<videoId>/`

与 `yt2x video`（native）采集输出一致时的**常见文件**：

| 文件                              | 说明                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| `metadata.json`                   | yt-dlp 风格元数据；含 `webpage_url`、`title` 等             |
| `chunks.md`                       | 转写分块                                                    |
| `timestamped-cues.md`             | 时间轴 cues                                                 |
| `structured-notes.md`             | 笔记阶段产出（`yt2x notes` / `yt2x text` notes 阶段）       |
| `screenshots/scene_manifest.json` | 可选；截图清单                                              |
| `video/full.mp4`                  | 默认；完整视频下载产物，MP4，限制到 720p                    |
| `video/clip.mp4`                  | 可选；手动 `--video-start` / `--video-end` 下载的视频片段   |
| `video/clip-manifest.json`        | 视频下载范围、模式、来源、文件和 warning 清单               |
| `process-status.json`             | **步骤状态主 JSON**（见下节）                               |
| `process-status.journal.ndjson`   | 瞬时日志；正常每次 patch 后会清空，崩溃恢复时与主 JSON 合并 |

`video/clip-manifest.json` 示例：

```json
{
  "version": 1,
  "mode": "full",
  "source": "full_video",
  "start_seconds": 0,
  "end_seconds": 1234,
  "duration_seconds": 1234,
  "file": "video/full.mp4",
  "format": "mp4",
  "warnings": []
}
```

普通采集模式下，完整视频是默认 artifact；下载失败会写入 `prepare-result.json` 的 warnings，但不会让 acquire 主链路失败。`yt2x video --video-only` 模式下，`metadata.json`、`video/clip-manifest.json` 和 manifest 指向的视频文件是 acquire 成功条件，字幕和转写文件不再是必需产物。

同一个视频目录下重新下载时，yt2x 会清理旧的 `video/full.*` / `video/clip.*` 并重写 `video/clip-manifest.json`，确保 manifest 与实际视频文件一致。默认不传时间段时下载完整视频；手动时间段变化（`--video-start` / `--video-end`）会下载片段，`--video-start` + `--video-duration` 会按开始时间和目标秒数计算 `end_seconds`。

`yt2x video` 默认下载完整 MP4 视频（720p 上限）；可用 `--no-download-video` 跳过。不改变 notes / article 的输入契约。只要不是 `--video-only`，acquire 成功仍要求 `metadata.json`、`chunks.md`、`timestamped-cues.md` 存在。

## 2. `ProcessStatusV1`（`process-status.json`）

- **version**：固定 `1`。
- **videoId** / **url**：视频 ID 与 canonical 页面 URL（用于状态合并 identity）。
- **updatedAt**：ISO 8601 字符串（可选，读取时会回填）。
- **steps**：四个键固定存在：`acquire` | `notes` | `article` | `publish`。
- **threadUrl**（可选）：publish 成功后 X thread 链接。
- **articleOutDir**（可选）：当前选中的内容目录绝对路径（native 扁平：`.../files/articles/<videoId>/`）。

### `StepInfo`（每个 step）

| 字段         | 类型                                         | 说明                                                       |
| ------------ | -------------------------------------------- | ---------------------------------------------------------- |
| `status`     | `pending` \| `running` \| `done` \| `failed` | native 长步骤前会写 `running`                              |
| `startedAt`  | string?                                      | ISO 8601                                                   |
| `finishedAt` | string?                                      | ISO 8601                                                   |
| `durationMs` | number?                                      | 非负毫秒                                                   |
| `artifacts`  | string[]                                     | 该步骤产生或消费的关键文件名                               |
| `resultFile` | string?                                      | 主结果文件名（如 `structured-notes.md`）                   |
| `error`      | `{ code, message }`?                         | 失败时；`code` 建议 `E_LLM_*` / `E_PUBLISH_*` 等可机读前缀 |

### Journal 行（`process-status.journal.ndjson`）

与 `ProcessStatusJournalLineSchema` 一致：`{ v:1, ts, step, stepInfo, threadUrl?, articleOutDir? }`。读取逻辑见 `readProcessStatusMerged`（`packages/adapters-node/src/fs/process-status-store.ts`）。

## 3. Native article 产物（`files/articles/<videoId>/`）

| 文件                                 | 说明                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `article.md`                         | 长文章草稿 Markdown；暂不通过 X API 自动发布                                        |
| `run.json`                           | 文章生成元数据（模型、耗时、usage 等）                                              |
| `x-thread.md`                        | 专门生成的 X 串推 Markdown                                                          |
| `x-hooks.json`                       | 串推首推候选                                                                        |
| `x-short.md`                         | 单条 X 短帖                                                                         |
| `<platform>-format/prompts.json`     | X、公众号、小红书或 B 站的封面/插图提示包；包含术语档案指纹时只允许在同一档案下复用 |
| `images/cover.*`                     | 可选；从笔记目录 `screenshots/` 复制                                                |
| `video/full.*` / `video/clip.*`      | 可选；从采集目录复制完整视频或手动片段供长文引用                                    |
| `video/full.en.srt`                  | 双语模式按完整语义句投影后的英文原文字幕                                            |
| `video/full.zh.srt`                  | 双语模式按完整语义句投影后的简体中文译文字幕                                        |
| `video/full.bilingual.srt`           | 译文在上、原文在下且共享时间轴的交付字幕                                            |
| `video/full.bilingual.ass`           | 可选；双语 ASS 版本                                                                 |
| `video/full.bilingual.semantic.json` | 双语投影、布局指纹、字体回退结果与质量报告                                          |
| `video/full.bilingual-burned.mp4`    | 可选；仅在内容和展示质量门都通过后生成                                              |
| `x-thread-visuals.json`              | 可选；串推配图计划（v0.2）                                                          |
| `x-short-visual.json`                | 可选；短文配图计划（v0.2）                                                          |
| `xiaohongshu-article.md`             | 计划；小红书图文笔记适配稿                                                          |
| `xiaohongshu-metadata.json`          | 计划；小红书标题、核心标签和封面/配图建议                                           |
| `wechat-article.md`                  | 计划；微信公众号 Markdown 长文适配稿                                                |
| `wechat-metadata.json`               | 计划；公众号标题候选、摘要、导语和封面图建议                                        |
| `bilibili-article.md`                | 计划；哔哩哔哩标题、简介、分区和标签建议                                            |
| `bilibili-metadata.json`             | 计划；哔哩哔哩标题、标签和章节时间线草案                                            |

`article.md` 落盘时会固定补齐首屏素材与尾注：如果存在 `images/cover.*`，H1 后的第一张图就是封面；如果存在下载视频片段，首个 `##` 小节前会插入引用 `video/clip.*` 的 `<video>`；LLM 正文末尾应输出 3-5 个从主题提取的 X 话题标签，之后再追加固定格式 `👇完整视频：` 与原视频地址。

双语字幕把 `files/downloads/<videoId>/` 视为只读源资产。语义投影和
烧录只写上述 article `video/` 文件，不会在下载目录新建、覆盖或删除字幕、ASS、
manifest、烧录视频或本地转写临时文件。双语模式只读取已经下载的源语言 SRT/VTT；
找不到时直接失败，不调用本地 ASR。`full.bilingual.semantic.json` 的 `kind` 固定为
`semantic-bilingual`；其中记录 `status`、翻译/对齐/断句/布局四阶段状态、源字幕 SHA、
翻译规则与模型、布局和样式版本、实际解析字体、视频尺寸、
`videoWidthFraction: 0.8`、三份 SRT 的 SHA 以及质量报告。

### 3.1 术语档案与可追踪指纹

所有会生成文字、JSON 字段或视觉提示的目标，都从中央目录和本次源材料的动态发现结果创建同一份 `TechnicalTermProfile`。它的 `profileFingerprint` 必须随可复用产物保存，并参与缓存命中判断：目录条目、别名、策略、源文本、已批准的动态术语或发现规则版本变化时，旧产物不可静默复用。

当前已落盘的指纹字段如下：

- `run.json.technicalTermProfileFingerprint`：主文章生成所使用的术语档案。
- `full.bilingual.semantic.json.technicalTermProfileFingerprint`：语义双语字幕的源级档案；与源字幕 SHA、翻译规则版本和模型一起校验。
- `dub/dub-script.json.technicalTermProfileFingerprint`：配音稿的源级档案；当前 `dub-script.json` schema 为 **version 3**，旧版 2（以及更早版本）必须视为缓存未命中并重新生成。
- `<platform>-format/prompts.json.technicalTermProfileFingerprint`：平台视觉提示包的档案；封面、插图、`name`、`filename`、`label` 和 `prompt` 等嵌套字段写入前统一校验。

视觉提示包使用单一对象 schema：

```json
{
  "platform": "<platform>",
  "title": "<source title>",
  "model": "<model>",
  "technicalTermProfileFingerprint": "sha256-<64-hex-fingerprint>",
  "coverPrompts": [],
  "illustrationPrompts": []
}
```

`prompts.json` 的旧版 `string[]`、旧版 `{ "prompts": [...] }` 或缺少 `technicalTermProfileFingerprint` 的对象均视为缓存未命中，必须重建。profile 缺失或不匹配时，合并器不得继承旧的 `coverPrompts`、`illustrationPrompts`、`prompts` 或旧 `model`；只保留明确兼容的 `platform`、`title` 字段，并写入新的 profile。平台编排器和小红书版式适配器通过同一个按路径串行、临时文件 rename 的写入器合并字段；Dashboard 的上传、编辑和删除也必须使用同一把锁，不能直接做无锁的 read-modify-write。

视觉提示字段的 owner/skip/merge 契约如下：通用平台编排器是带 LLM 的新鲜封面和插图生成 owner；小红书 adapter 只在 profile 匹配时消费缓存，带 LLM 时才负责生成并 merge 自己的插图字段。小红书 adapter 没有 LLM 且缓存不存在或 profile 不匹配时，只完成排版和预览，跳过提示生成与 `prompts.json` 写入，绝不能用空 prompt 覆盖已有生成结果。Dashboard 必须等待通用编排器完成后再进入小红书 adapter。

#### 如何维护中央术语库

机器可读唯一事实来源是 `packages/core/src/domain/technical-term-catalog.ts`。添加一个人工确认的术语时，只修改中央目录及其条目测试，不在平台 prompt、字幕、配音或适配器中新增局部数组：

1. `canonical` 填标准输出拼写；`aliases` 只填源材料可能出现的大小写或 ASR 变体。canonical 必须唯一，别名不能与其他条目的 canonical/alias 冲突。
2. `categories` 至少填写一个领域分类：`ai`、`ai-coding`、`ai-agent`、`product`、`person` 或 `domain`。分类用于提示和审计，不应在调用方复制成枚举白名单。
3. `policy` 选择 `preserve`、`contextual-preserve` 或 `fixed-zh`。前两者保留 canonical 原文；只有 `fixed-zh` 才填写 `preferredZh`。
4. `forbiddenZh` 只记录该术语的已知错误中文替代词，并且只能在同一源范围命中该术语时恢复；它不是全局替换表。普通词（例如“图片”“配图”“插图”“流程图”）不得作为 Graph 的错误翻译加入全局规则。
5. 为每个新条目补一个应命中的正例和一个不应命中的反例，运行目录不变量、相关产物 focused tests、typecheck 和 `git diff --check`。

源材料出现目录中没有的 AI、AI coding 或 AI agent 术语时，源级 discovery 会要求模型返回可在原文中逐字定位的 span。高置信度候选只进入当前运行的 profile，不会自动写回中央目录；中置信度候选进入 warning，低置信度或无法定位的候选丢弃。这样未来术语可以立即在文章、帖子、视觉提示、字幕和 dub 中保持原文，同时不会把一次模型误判永久升级为全仓库规则。人工确认后，再按上述目录流程提交 canonical、aliases、category、policy、forbiddenZh 及测试。

所有后续重写、压缩、补漏和定向 repair 都必须复用初始 profile；格式化、烧录、TTS 和混音模块只消费已通过术语门的上游产物，不再维护第二套术语枚举。

### 下载目录只读契约（硬性）

`files/downloads/` 是**只读的原始素材区**：

- **读**：二次创作（字幕烧录、配音）一律从 downloads 取源视频；`files/articles/` 只作为产物写入目标，不得作为素材来源。
- **写**：除 `acquire` 采集步骤外，任何流程、脚本、测试夹具都不得向 downloads 写入或覆盖文件。
- **写的唯一例外**：本地转写产出的同语言旁挂文件 `full.local.<lang>.srt` / `full.local.<lang>.words.json` 允许写入，无论由哪个阶段触发（`yt2x subtitle-tools transcribe-local` 或 `yt2x video --deliver dubbed` 的前置转写）。判据是「素材 vs 二创」而非「哪个阶段」：转写是对原始音轨的机器读取，与原片同语言、同内容，属于素材；烧录版、配音版、水印版是二创产物，一律只进 `files/articles/`。该例外不允许覆盖任何已有文件。
- 冒烟/测试若需要短片段，必须从原始素材裁切且放在 downloads **之外**的临时/夹具目录；或使用 `yt2x dub --start-ms/--end-ms` 限定处理时间窗（临时窗写在 article `dub/work/`，不进 downloads）。
- 可执行检查：`pnpm check:downloads`（跟随 `files/` 符号链接；干净基线应零报警）。

### Qsync 同步边界（环境约束）

`files/` 是逻辑产物根目录，可能通过符号链接指向 Qsync 的实时同步目录。先用
`readlink files` 和 `realpath files` 确认当前机器的实际目标；解析目标不会改变上面的
产物路径契约，也不应要求调用方改用另一套路径。

`files/downloads/` 源素材与 `files/articles/<videoId>/video/` 下的成片、字幕等稳定交付物
需要保留备份；`files/articles/<videoId>/dub/` 则是可由 `yt2x dub` 重建的高频工作目录，包含
配音稿、时长/计划/落点/门禁 JSON、逐句音频和人声分离结果。Qsync 应在客户端的选择性同步
设置中排除 `**/dub/`（或等价的目录模式），而不是把整个 `files/` 移出同步范围。Qsync
客户端设置不属于仓库配置，勿直接编辑 `~/.Qsync/` 下的内部规则文件。

工单 #132 已记录本机现象：多次运行配音时，`dub/` 中间 JSON 会随机消失；丢失时间与
`~/.Qsync/Debug/QNLog.log` 中的 `Check NAS file error (1040)` 相吻合，而同一进程的下游
阶段仍使用内存结果，成片与门禁结果不受影响。因此该现象判定为 Qsync/NAS 同步故障，
不是配音业务逻辑的代码缺陷。

若配音过程中发现中间 JSON 在磁盘上消失，按以下顺序判别是否为同步环境故障：

1. 记录丢失文件的绝对路径、进程时间和 `readlink files` / `realpath files` 结果，确认它位于
   实际同步根目录下的 `articles/<videoId>/dub/`。
2. 对照 `~/.Qsync/Debug/QNLog.log` 的同一时间段；`Check NAS file error (1040)` 与本地文件
   消失时间吻合，且多次运行稳定复现时，判定为 Qsync/NAS 同步失败后的外部删除。
3. 不要先在代码中搜索一个不存在的删除调用：配音 JSON 由 `packages/adapters-node/src/dub/file-store.ts`
   采用临时文件加 `rename` 的方式写入，下游阶段同时使用内存中的结果。若进程内下游已完成、
   但文件随后从磁盘消失，且成片和门禁结果不受影响，该现象不是配音业务逻辑的代码缺陷。
4. 配置排除规则后，在获得正常运行授权的前提下连续运行数次
   `pnpm yt2x dub --video-id <videoId>`，确认 `dub/` 中间 JSON 不再随机消失，同时确认
   `files/articles/<videoId>/video/` 的稳定交付物仍正常写入。

缓存分为翻译与展示两层：源 SHA、翻译规则、模型和三份 SRT SHA 都一致时复用翻译；
字体回退结果、视频尺寸、宽度比例或布局/样式版本变化时，只重新测量、定向重排和烧录，
不会无故重新翻译。内容验证、语义边界或展示质量失败会写
`status: "failed"` 的文章侧审计报告并使命令非零退出；不存在逐 cue 交付回退。
烧录前必须重新校验 `kind: "semantic-bilingual"`、`status: "ready"`、四阶段全部
`done`、质量门通过以及三份 SRT SHA 完全匹配，否则不调用烧录器。

`x-thread.md` / `x-short.md` 面向 X post 发布，生成阶段不得使用 Markdown 加粗、行内代码、代码块、有序列表、无序列表、Markdown 链接、引用或表格。对比、参数、步骤或结构化信息应写成纯文本短行。冒号式标题或标签必须在冒号后换行；数字序号、圈号序号和 emoji 数字序号都必须让序号单独占一行，内容从下一行开始。

`x-thread.md` 发布读取时以行首 `1/`、`2/`、`3/` 这类编号作为 tweet 边界；单条 tweet 内部允许保留空行和纯文本结构，不会再按空行切成多条回复。发布前转换 hook 仍兼容旧 Markdown 产物，但新生成规则不再依赖 Markdown 转换。

小红书、微信公众号和哔哩哔哩产物处于 v0.3 计划阶段，规格见 `docs/MULTI-PLATFORM-OUTPUT-TASK.md`。这些平台产物默认从 `article.md` 适配，只允许改变表达方式，不允许新增事实或改变观点结论；第一阶段只固化数据结构，不改变现有 `--targets all` 行为。

## 4. 视觉内容链路（v0.2）

采集阶段通过 `--keyframes` 生成 `screenshots/scene_manifest.json`，经质量筛选后转换为 `available_visuals` 传入 LLM prompt。LLM 只能引用已存在的 `visual_id`，禁止虚构图片。

数据流：

```text
scene_manifest.json → available_visuals → LLM visual_plan → 图片渲染 → 发布
```

关键字段（`scene_manifest.json` 中每个 frame）：

| 字段                                | 说明                                  |
| ----------------------------------- | ------------------------------------- |
| `id`                                | 稳定唯一标识（如 `scene_003`）        |
| `visual_quality.blur`               | `low` / `medium` / `high` / `unknown` |
| `visual_quality.has_text`           | 帧中是否检测到文字                    |
| `visual_quality.has_ui`             | 帧中是否检测到 UI 界面                |
| `visual_quality.center_presenter`   | 画面中心区域是否有主播人像            |
| `visual_quality.usable_for_content` | 综合判断是否可用于配图                |

`available_visuals` 过滤规则：

- `blur: "high"` / `blur: "unknown"` → 不可用
- `center_presenter: true` → 不可用
- `usable_for_content: false` → 不可用

## 5. Native publish 产物（article 目录内）

| 文件                   | 说明                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `publish-result.json`  | thread URL、各推 id、部分失败信息，或 article browser-draft 结果 |
| `publish-preview.json` | `yt2x publish --dry-run` 的预览内容、长度与封面信息              |

`publish-preview.json` 也会把 `<outDir>/<videoId>/process-status.json` 的 `publish` step 标记为 `done`，`resultFile` 指向 `publish-preview.json`；真实发帖或 article browser-draft 成功时仍写 `publish-result.json`。预览 JSON 会包含 `mode` 与 `source`，例如 `mode: "article"` / `source: "article.md"`、`source: "x-thread.md"`、`source: "x-short.md"` 或 `source: "x-short.md + x-thread.md"`；串推预览额外包含 `tweets`，短帖和 article 预览额外包含 `text`，`x-thread-short` 预览包含 `text`、`replies` 和完整 `tweets`。

`publish --target article --browser-draft` 还会写 `article_for_x.md`，保留原始
`article.md`。对应 `publish-result.json` 的 `mode` 为 `article-draft`，含
`source`、`adaptedSource`、`subscriptionTier`、`draftSavedAt`、可选 `editorUrl`
与 `warnings`。`x-thread`、`x-short` 和 `x-thread-short` 预览还会包含
`sourceReply`，真实发布时会在主 post/thread 后追加“👇完整视频：<原视频地址>”来源回复；
`x-short` 和 `x-thread-short` 会尽量把 `images/cover.*` 附在首推上。真实发布
`x-thread` / `x-thread-short` 时，每两条推文之间默认随机等待 20-30 秒，可通过
`threadDelayMs` 预览字段确认实际配置。

## 6. 批次队列与 `process-status.json`（无根级 `pipeline-state.json`）

**不再**在输出根目录写入 **`pipeline-state.json`**。批次内有哪些视频、以何顺序处理，由 **`listBatchVideosFromOutRoot`** 扫描 `<outDir>` 下子目录决定：凡目录名不含前导 `.`，且该子目录内存在 **`metadata.json`** 或 **`process-status.json`**，即视为一条视频；**`video_id` = 目录名**，整体按 **`video_id` 字典序**（与 `collectNativePipelineVideoIds` 一致）。

**步骤状态唯一真理**：每个 `<outDir>/<videoId>/process-status.json`（及可选 `process-status.journal.ndjson`）。Zod 定义见 `packages/core/src/domain/pipeline/state.ts`，读写与锁见 `packages/adapters-node/src/fs/process-status-store.ts`。

**批次队列（无内存 `PipelineState`）**：`packages/adapters-node/src/acquire/batch-queue.ts` — `listBatchVideosFromOutRoot`、`resolveAcquireVideoQueue`（`--continue` 时先扫盘再解析 URL）、`collectNativePipelineVideoIds`、`validateArtifacts`。

**步骤读写 API（权威）**：`packages/adapters-node/src/fs/process-status-store.ts` — `readProcessStatusMerged`、`patchProcessStatus`、`patchStepRunning`、`markStepDone`、`markStepFailed`、`isStepDone`。

**历史**：若磁盘上仍有旧版 **`pipeline-state.json`**，运行时**不会**再读取或更新它；请以子目录产物与 **`process-status`** 为准。

## 7. 子进程结果 JSON

采集阶段会写入 `prepare-result.json`，记录本次 `prepareYoutubeVideo` 的输入 URL、输出目录、是否成功、告警和各子步骤耗时。发布 dry-run / review 写入 `publish-preview.json`，真实发布写入 `publish-result.json`。新增阶段产物时，应同步更新本文件和对应测试。

## 8. 配音（dub）产物

`yt2x dub` 只消费本地转录通道的词级时间戳 `<outDir>/<videoId>/video/full.local.<lang>.words.json`（`transcribe-local.py` 产出，默认 `lang=en`）——不读取任何中文字幕文件。产物写在 `<articleRoot>/<videoId>/dub/`：

| 文件                 | 说明                                        |
| -------------------- | ------------------------------------------- |
| `dub-script.json`    | 配音稿：话语单元 + 长度受限翻译后的中文文本 |
| `dub-timing.json`    | 倍率 1.0 的实测时长报告                     |
| `dub-plan.json`      | 时长协商计划                                |
| `dub-placement.json` | 最终落点（反向 SRT / 混音的输入）           |
| `dub-report.json`    | 质量门禁报告                                |

`dub-plan.json` 的 `version` 为 **3**：时长协商的第三档「事后 LLM 改短」（旧版 1 的 `shorten` 动作与 `shortenCount` 字段）已删除，冗余改在生成配音稿阶段由长度受限翻译挤掉，见 `docs/DUB-TASK.md`。version 3（PR4）新增 `stretch` 动作与 `stretchCount` 字段：合成音明显短于目标时长时反向放慢语速填充，减少句尾死寂，取代此前"富余时间只能变成死寂"的行为；放慢幅度受 `TtsPort.rateRange` 下限约束。它是中间产物，重跑 `yt2x dub` 即可重新生成，不提供旧版本兼容读取。`dub-placement.json` 同步新增 `stretchCount` 字段（它自己的 `version` 见下一段）。

`dub-placement.json` 的 `version` 现为 **3**：新增 `runId`（本次协商执行的唯一标识，`crypto.randomUUID()`）与 `generatedAt`（生成时刻，ISO 8601 字符串）——这份报告此前只写不读，也没有任何机制表明它属于哪一次运行；被流程外的手工命令覆写成残缺内容时，只能靠比对文件系统修改时间去猜测，猜错就会把工具问题误判成协商逻辑缺陷（issue #110 的真实事故）。`readDubPlacementReport`（`packages/adapters-node/src/dub/file-store.ts`）新增，用 zod 校验整体形状与 `version` 字面量，口径与 `readDubTimingReport` 一致：残缺或版本不匹配直接拒绝、报错信息定位到具体字段，不返回裸 JSON。目前唯一的读取方是 `yt2x dub-replay` 的协商核对——比对结果会带上盘上报告的 `runId`/`generatedAt`，无论核对通过还是不通过。它同样是中间产物，重跑 `yt2x dub` 即可重新生成，不提供旧版本兼容读取。写入逻辑本身未变——仍由协商执行阶段一次性写盘；本次改动只新增来源标记与读回校验，不加文件锁或只读权限，因为覆写来自流程外操作，用权限对抗它只会给正常调试添堵。

`dub-script.json` 的 `version` 为 **3**：切到本地转录通道后 schema 实质变了——`sourceWords`（词级时间戳文件相对路径）取代了旧版 1 的 `sourceSubtitle`（中文字幕文件路径），`sourceText` 从中文原文变成英文原文，`cueIndices` 的语义从「字幕条 index」变成「话语单元 index」，并新增 `droppedCount`（翻译失败、未进入 `lines` 的话语单元数——门禁据此拦截静默丢句，见下），以及随术语 profile 变化而失效的 `technicalTermProfileFingerprint`。`readDubScript`（`packages/adapters-node/src/dub/file-store.ts`）用 zod 校验 `version` 与整体形状，版本不匹配或字段缺失时直接拒绝、不返回裸 JSON；`yt2x dub` 全片模式下读到这类拒绝会当作缓存未命中，记一条 warning 后重新生成，不会静默复用旧链路产物。

`dub-report.json`（门禁）中的 `info-loss` 是 advisory（不阻断）：把某行译文的字符数与该行**时长预算**（`dubTranslateCharBudget(targetDurationMs)`）相比，标注明显低于预算、疑似过度精简的行，供人工复核；不再拿英文 `sourceText` 与译文的码点数直接相除——跨语言下那个比例天生偏低，会对忠实翻译系统性误判。`droppedCount`（见上）在门禁里是独立的 hard 指标：只要 `dub-script.json` 里 `droppedCount > 0` 即阻断，因为被丢弃的话语单元在成片里只有 BGM、没有配音也没有字幕，必须显式暴露而不是被 `lineCount` 悄悄吸收。

`--start-ms` / `--end-ms` 时间窗按话语单元过滤（`filterUtterancesByTimeRange`），不再按字幕 cue 过滤；窗口内产物写在 `dub/work/`，不复用或覆盖全片缓存。

最终成片默认写入 `<articleRoot>/<videoId>/video/full.zh-dubbed.mp4`。`--output-path` 可为语速试听
指定另一个 MP4 文件名，但路径必须位于同一视频的 `article` `video/` 目录内；这样可以保留多份
试听成片，同时禁止把配音成片写入只读的 `files/downloads/` 或其他越界路径。试听使用的
`<outputPath>.audition.json` 会记录该成片的语速地板、触发阈值、运行 flags、协商摘要和两道门结果，
用于证明两版试听的变量边界。`dub-plan.json`、`dub-placement.json`、`dub-report.json` 等高频中间
产物仍位于 `dub/`，可由下一次运行重建；稳定交付物是 `video/` 下的成片、字幕与试听 manifest。
如果指定的成片已经存在而本次未加 `--force`，manifest 会标记 `status: reused-existing-output`、
`gates: null`，明确表示本次没有重新评估门禁。
