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
| `process-status.json`             | **步骤状态主 JSON**（见下节）                               |
| `process-status.journal.ndjson`   | 瞬时日志；正常每次 patch 后会清空，崩溃恢复时与主 JSON 合并 |

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

| 文件                    | 说明                                         |
| ----------------------- | -------------------------------------------- |
| `article.md`            | 长文章草稿 Markdown；暂不通过 X API 自动发布 |
| `run.json`              | 文章生成元数据（模型、耗时、usage 等）       |
| `x-thread.md`           | 专门生成的 X 串推 Markdown                   |
| `x-hooks.json`          | 串推首推候选                                 |
| `x-short.md`            | 单条 X 短帖                                  |
| `images/cover.*`        | 可选；从笔记目录 `screenshots/` 复制         |
| `x-thread-visuals.json` | 可选；串推配图计划（v0.2）                   |
| `x-short-visual.json`   | 可选；短文配图计划（v0.2）                   |

`x-thread.md` / `x-short.md` 面向 X post 发布，生成阶段不得使用 Markdown 表格。对比、参数、步骤或结构化信息应写成编号列表、要点列表或「字段：值」短行。除表格外，生成文件应保留有助于阅读的 Markdown，包括加粗、行内代码、代码块、有序列表、无序列表、链接、引用、分隔段落和空行；发布前转换 hook 仅作为发布兼容层，不作为生成格式约定。

`x-thread.md` 发布读取时以行首 `1/`、`2/`、`3/` 这类编号作为 tweet 边界；单条 tweet 内部允许保留空行、列表和代码块，不会再按空行切成多条回复。发布前转换 hook 会把 Markdown 加粗中的英文 / 数字转为 X 可见的 Unicode bold；中文等没有通用 Unicode 粗体字形的字符保持原字形。

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
| `publish-result.json`  | thread URL、各推 id、部分失败信息等                              |
| `publish-preview.json` | dry-run / pipeline `--publish review` 的预览内容、长度与封面信息 |

`publish-preview.json` 也会把 `<outDir>/<videoId>/process-status.json` 的 `publish` step 标记为 `done`，`resultFile` 指向 `publish-preview.json`；真实发帖成功时仍写 `publish-result.json`。预览 JSON 会包含 `mode` 与 `source`，例如 `mode: "article"` / `source: "article.md"`、`source: "x-thread.md"`、`source: "x-short.md"` 或 `source: "x-short.md + x-thread.md"`；串推预览额外包含 `tweets`，短帖和 article 预览额外包含 `text`，`x-thread-short` 预览包含 `text`、`replies` 和完整 `tweets`。`x-thread`、`x-short` 和 `x-thread-short` 预览还会包含 `sourceReply`，真实发布时会在主 post/thread 后追加“👇完整视频：<原视频地址>”来源回复；`x-short` 和 `x-thread-short` 会尽量把 `images/cover.*` 附在首推上。真实发布 `x-thread` / `x-thread-short` 时，每两条推文之间默认随机等待 20-30 秒，可通过 `threadDelayMs` 预览字段确认实际配置。

## 6. 批次队列与 `process-status.json`（无根级 `pipeline-state.json`）

**不再**在输出根目录写入 **`pipeline-state.json`**。批次内有哪些视频、以何顺序处理，由 **`listBatchVideosFromOutRoot`** 扫描 `<outDir>` 下子目录决定：凡目录名不含前导 `.`，且该子目录内存在 **`metadata.json`** 或 **`process-status.json`**，即视为一条视频；**`video_id` = 目录名**，整体按 **`video_id` 字典序**（与 `collectNativePipelineVideoIds` 一致）。

**步骤状态唯一真理**：每个 `<outDir>/<videoId>/process-status.json`（及可选 `process-status.journal.ndjson`）。Zod 定义见 `packages/core/src/domain/pipeline/state.ts`，读写与锁见 `packages/adapters-node/src/fs/process-status-store.ts`。

**批次队列（无内存 `PipelineState`）**：`packages/adapters-node/src/acquire/batch-queue.ts` — `listBatchVideosFromOutRoot`、`resolveAcquireVideoQueue`（`--continue` 时先扫盘再解析 URL）、`collectNativePipelineVideoIds`、`validateArtifacts`。

**步骤读写 API（权威）**：`packages/adapters-node/src/fs/process-status-store.ts` — `readProcessStatusMerged`、`patchProcessStatus`、`patchStepRunning`、`markStepDone`、`markStepFailed`、`isStepDone`。

**历史**：若磁盘上仍有旧版 **`pipeline-state.json`**，运行时**不会**再读取或更新它；请以子目录产物与 **`process-status`** 为准。

## 7. 子进程结果 JSON

采集阶段会写入 `prepare-result.json`，记录本次 `prepareYoutubeVideo` 的输入 URL、输出目录、是否成功、告警和各子步骤耗时。发布 dry-run / review 写入 `publish-preview.json`，真实发布写入 `publish-result.json`。新增阶段产物时，应同步更新本文件和对应测试。
