# 数据契约（Data Contracts）

本文件描述 **磁盘产物** 与 **`process-status.json`** 的约定，与实现源码对齐处已标注。权威 Zod 定义在 `packages/core/src/domain/pipeline/state.ts`。

## 1. 每视频目录 `<outDir>/<videoId>/`

与 `yt2x acquire`（native）采集输出一致时的**常见文件**：

| 文件                              | 说明                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| `metadata.json`                   | yt-dlp 风格元数据；含 `webpage_url`、`title` 等             |
| `chunks.md`                       | 转写分块                                                    |
| `timestamped-cues.md`             | 时间轴 cues                                                 |
| `structured-notes.md`             | 笔记阶段产出（`yt2x notes` / pipeline notes 阶段）          |
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

普通采集模式下，完整视频是默认 artifact；下载失败会写入 `prepare-result.json` 的 warnings，但不会让 acquire 主链路失败。`yt2x acquire --video-only` 模式下，`metadata.json`、`video/clip-manifest.json` 和 manifest 指向的视频文件是 acquire 成功条件，字幕和转写文件不再是必需产物。

同一个视频目录下重新下载时，yt2x 会清理旧的 `video/full.*` / `video/clip.*` 并重写 `video/clip-manifest.json`，确保 manifest 与实际视频文件一致。默认不传时间段时下载完整视频；手动时间段变化（`--video-start` / `--video-end`）会下载片段，`--video-start` + `--video-duration` 会按开始时间和目标秒数计算 `end_seconds`。

`pipeline` 默认下载完整 MP4 视频（720p 上限）；可用 `--no-download-video` 跳过。不改变 notes / article 的输入契约。只要不是 `--video-only`，acquire 成功仍要求 `metadata.json`、`chunks.md`、`timestamped-cues.md` 存在。

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

| 文件                                 | 说明                                             |
| ------------------------------------ | ------------------------------------------------ |
| `article.md`                         | 长文章草稿 Markdown；暂不通过 X API 自动发布     |
| `run.json`                           | 文章生成元数据（模型、耗时、usage 等）           |
| `x-thread.md`                        | 专门生成的 X 串推 Markdown                       |
| `x-hooks.json`                       | 串推首推候选                                     |
| `x-short.md`                         | 单条 X 短帖                                      |
| `images/cover.*`                     | 可选；从笔记目录 `screenshots/` 复制             |
| `video/full.*` / `video/clip.*`      | 可选；从采集目录复制完整视频或手动片段供长文引用 |
| `video/full.en.srt`                  | 双语模式按完整语义句投影后的英文原文字幕         |
| `video/full.zh.srt`                  | 双语模式按完整语义句投影后的简体中文译文字幕     |
| `video/full.bilingual.srt`           | 译文在上、原文在下且共享时间轴的交付字幕         |
| `video/full.bilingual.ass`           | 可选；双语 ASS 版本                              |
| `video/full.bilingual.semantic.json` | 双语投影、布局指纹、字体回退结果与质量报告       |
| `video/full.bilingual-burned.mp4`    | 可选；仅在内容和展示质量门都通过后生成           |
| `x-thread-visuals.json`              | 可选；串推配图计划（v0.2）                       |
| `x-short-visual.json`                | 可选；短文配图计划（v0.2）                       |
| `xiaohongshu-article.md`             | 计划；小红书图文笔记适配稿                       |
| `xiaohongshu-metadata.json`          | 计划；小红书标题、核心标签和封面/配图建议        |
| `wechat-article.md`                  | 计划；微信公众号 Markdown 长文适配稿             |
| `wechat-metadata.json`               | 计划；公众号标题候选、摘要、导语和封面图建议     |
| `bilibili-article.md`                | 计划；哔哩哔哩标题、简介、分区和标签建议         |
| `bilibili-metadata.json`             | 计划；哔哩哔哩标题、标签和章节时间线草案         |

`article.md` 落盘时会固定补齐首屏素材与尾注：如果存在 `images/cover.*`，H1 后的第一张图就是封面；如果存在下载视频片段，首个 `##` 小节前会插入引用 `video/clip.*` 的 `<video>`；LLM 正文末尾应输出 3-5 个从主题提取的 X 话题标签，之后再追加固定格式 `👇完整视频：` 与原视频地址。

双语字幕把 `files/downloads/<videoId>/` 视为只读源资产。语义投影和
烧录只写上述 article `video/` 文件，不会在下载目录新建、覆盖或删除字幕、ASS、
manifest、烧录视频或本地转写临时文件。双语模式只读取已经下载的源语言 SRT/VTT；
找不到时直接失败，不调用本地 ASR。`full.bilingual.semantic.json` 的 `kind` 固定为
`semantic-bilingual`；其中记录 `status`、翻译/对齐/断句/布局四阶段状态、源字幕 SHA、
翻译规则与模型、布局和样式版本、实际解析字体、视频尺寸、
`videoWidthFraction: 0.8`、三份 SRT 的 SHA 以及质量报告。

### 下载目录只读契约（硬性）

`files/downloads/` 是**只读的原始素材区**：

- **读**：二次创作（字幕烧录、配音）一律从 downloads 取源视频；`files/articles/` 只作为产物写入目标，不得作为素材来源。
- **写**：除 `acquire` 采集步骤外，任何流程、脚本、测试夹具都不得向 downloads 写入或覆盖文件。
- 冒烟/测试若需要短片段，必须从原始素材裁切且放在 downloads **之外**的临时/夹具目录；或使用 `yt2x dub --start-ms/--end-ms` 限定处理时间窗（临时窗写在 article `dub/work/`，不进 downloads）。
- 可执行检查：`pnpm check:downloads`（跟随 `files/` 符号链接；干净基线应零报警）。

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
| `publish-preview.json` | dry-run / pipeline `--publish review` 的预览内容、长度与封面信息 |

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

`dub-plan.json` 的 `version` 为 **3**：时长协商的第三档「事后 LLM 改短」（旧版 1 的 `shorten` 动作与 `shortenCount` 字段）已删除，冗余改在生成配音稿阶段由长度受限翻译挤掉，见 `docs/DUB-TASK.md`。version 3（PR4）新增 `stretch` 动作与 `stretchCount` 字段：合成音明显短于目标时长时反向放慢语速填充，减少句尾死寂，取代此前"富余时间只能变成死寂"的行为；放慢幅度受 `TtsPort.rateRange` 下限约束。它是中间产物，重跑 `yt2x dub` 即可重新生成，不提供旧版本兼容读取。`dub-placement.json` 同步新增 `stretchCount` 字段，`version` 随之升到 **2**。

`dub-script.json` 的 `version` 为 **2**：切到本地转录通道后 schema 实质变了——`sourceWords`（词级时间戳文件相对路径）取代了旧版 1 的 `sourceSubtitle`（中文字幕文件路径），`sourceText` 从中文原文变成英文原文，`cueIndices` 的语义从「字幕条 index」变成「话语单元 index」，并新增 `droppedCount`（翻译失败、未进入 `lines` 的话语单元数——门禁据此拦截静默丢句，见下）。`readDubScript`（`packages/adapters-node/src/dub/file-store.ts`）用 zod 校验 `version` 与整体形状，版本不匹配或字段缺失时直接拒绝、不返回裸 JSON；`yt2x dub` 全片模式下读到这类拒绝会当作缓存未命中，记一条 warning 后重新生成，不会静默复用旧链路产物。

`dub-report.json`（门禁）中的 `info-loss` 是 advisory（不阻断）：把某行译文的字符数与该行**时长预算**（`dubTranslateCharBudget(targetDurationMs)`）相比，标注明显低于预算、疑似过度精简的行，供人工复核；不再拿英文 `sourceText` 与译文的码点数直接相除——跨语言下那个比例天生偏低，会对忠实翻译系统性误判。`droppedCount`（见上）在门禁里是独立的 hard 指标：只要 `dub-script.json` 里 `droppedCount > 0` 即阻断，因为被丢弃的话语单元在成片里只有 BGM、没有配音也没有字幕，必须显式暴露而不是被 `lineCount` 悄悄吸收。

`--start-ms` / `--end-ms` 时间窗按话语单元过滤（`filterUtterancesByTimeRange`），不再按字幕 cue 过滤；窗口内产物写在 `dub/work/`，不复用或覆盖全片缓存。
