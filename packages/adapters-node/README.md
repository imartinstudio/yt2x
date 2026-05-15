# @yt2x/adapters-node

Node.js 环境下 `@yt2x/core` 端口（port）的实现与 CLI 所需的 I/O 适配。

## 内容

- `src/acquire/` — native 采集；`batch-queue.ts` 扫子目录队列 + `fs/process-status-store.ts` 写步骤状态
- `src/youtube/` — yt-dlp 搜索（`ytsearch`）
- `src/llm/` — `createLlmAdapter`：OpenAI 兼容、Anthropic、DeepSeek、Moonshot
- `src/notes/`、`src/article/` — 笔记与长文（`notes/generator.ts` + `@yt2x/core` prompts）
- `src/x-auth/`、`src/x-publish/` — X OAuth 2.0 PKCE 与发帖
- `src/fs/` — 原子写、`process-status` NDJSON 等
- `src/process/` — 子进程 runner（超时、stderr 截断）
