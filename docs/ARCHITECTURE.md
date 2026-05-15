# yt2x 架构说明

Monorepo（pnpm workspace），目标是把 **YouTube → 笔记 → 长文 → X** 拆成可测试、可替换适配器的层次结构。路线图见 [ROADMAP.md](./ROADMAP.md)。

## 包一览

```text
packages/core              # 领域模型 + 端口接口（无 Node I/O）
packages/adapters-node     # Node 实现：fs、子进程、LLM、X OAuth/API
packages/cli               # Commander CLI，装配 adapters 并暴露命令
```

### `packages/core`

- **领域**：`domain/notes`、`domain/article`、`domain/publish`（如 `articleToThread`）、`domain/pipeline`（`ProcessStatusV1` 等 Zod schema）。
- **端口**：`ports/llm.ts`、`ports/x-auth.ts`、`ports/x-publish.ts` 等，由 adapters 实现。

不直接 `readFile` / `fetch`，便于日后浏览器扩展复用同一套 prompt 与纯函数。

### `packages/adapters-node`

- **LLM**：`src/llm/*` — OpenAI 兼容、Anthropic 等，`createLlmAdapter` 工厂。
- **笔记 / 长文（native）**：`src/notes/*`、`src/article/*` — 读视频目录产物、调 `LlmPort`、原子写。
- **X**：`src/x-auth/*`、`src/x-publish/*` — OAuth 2.0 PKCE、`findArticleArtifacts`、发帖与媒体上传。
- **状态**：`src/fs/process-status-store.ts` — 锁 + `process-status.json` + NDJSON journal 合并读。
- **采集（Node）**：`packages/adapters-node/src/acquire/*` — **`executeNativeAcquire`** 进程内调用 `prepareYoutubeVideo`（yt-dlp / ffmpeg 子进程）。

### `packages/cli`

- 各命令在 `src/commands/*.ts`。
- **`acquire` / `pipeline` 采集**：**`executeNativeAcquire`** → **`prepareYoutubeVideo`**（`yt-dlp` + `ffmpeg`）；队列由各视频子目录 **`metadata.json` / `process-status.json`** 发现。
- **`pipeline`**：**native acquire** + **`src/orchestrator/`** 内 `notes` / `article` / `publish`（`native-pipeline.ts` → `native-*.ts`）。
- **单阶段命令**：`notes` / `article` / `publish` 均调用对应 `executeNative*`。

## 数据流（概念）

1. **Acquire**：字幕 + 元数据 + 可选截图 → `files/downloads/<videoId>/`（`executeNativeAcquire`）。
2. **Notes**：`chunks.md` + `timestamped-cues.md` + `metadata.json` → `structured-notes.md`（native LLM）。
3. **Article**：structured notes → `article.md`（`files/articles/<videoId>/`）。
4. **Publish**：`article.md` → thread → X API（native 使用 OAuth 2.0 v2）。

## 单一状态源（步骤）

每个视频目录下的 **`process-status.json`** 为 **acquire / notes / article / publish** 四步的权威存储；native 路径通过 `patchProcessStatus` / `patchStepRunning` 更新。详见 [DATA-CONTRACTS.md](./DATA-CONTRACTS.md)。

**无根级 `pipeline-state.json`**：`yt2x pipeline` 与 native acquire 通过 **`listBatchVideosFromOutRoot`** / **`resolveAcquireVideoQueue`**（`batch-queue.ts`）发现视频子目录（含 **`metadata.json`** 或 **`process-status.json`** 即入队，字典序）。步骤状态仅各目录 **`process-status.json`**。

## 测试与质量闸

根目录 `pnpm run ci`：`tsc -b`、ESLint、Prettier、`vitest run`。发布前使用 `pnpm run ci:full`，额外包含覆盖率和 high+ audit。
