# @yt2x/core

yt2x 的领域逻辑与端口（port）接口定义。

**约束**：本包**零 Node.js 依赖**，能在 Node、浏览器、Chrome 扩展、Web Worker 中运行。

## 内容

- `src/ports/` — 接口定义（`LlmPort`、`StoragePort`、`HttpPort` 等）
- `src/domain/` — 纯领域逻辑（markdown 处理、平台策略、OAuth 2.0 PKCE 流程、状态机）
- `src/schema/` — Zod schemas

## 依赖原则

- ✅ 允许：`zod`、`@types/*`
- ❌ 禁止：任何 Node 内置模块（`fs`、`child_process`、`path` 等）
- ❌ 禁止：任何要求 Node 运行时的 npm 包（`execa`、`pino`、`puppeteer` 等）

具体实现（fs / yt-dlp / fetch）放在 `@yt2x/adapters-node`（Chrome 扩展适配器计划在 v0.2 单独开包）。
