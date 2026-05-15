# @yt2x/cli

`yt2x` 可执行入口（从仓库根目录通过 `pnpm yt2x` 或 `packages/cli` 的 `bin` 调用）。

## 当前状态

- **子命令**：`info`、`pipeline`、`acquire`、`notes`、`article`、`publish`、`publish auth`、`llm` 等已注册，见 `src/index.ts`。
- **全路径 native**：`acquire` / `notes` / `article` / `publish` / `pipeline` 均走 `@yt2x/adapters-node` + `src/orchestrator/native-*.ts`。
- **采集**：`executeNativeAcquire` → `prepareYoutubeVideo`（`yt-dlp` + `ffmpeg`）。

## 命令一览

| 命令                | 说明                                   |
| ------------------- | -------------------------------------- |
| `yt2x publish auth` | OAuth 2.0 PKCE，写入本机凭证           |
| `yt2x pipeline`     | native acquire + orchestrator 后三阶段 |
| `yt2x acquire`      | 仅采集（`executeNativeAcquire`）       |
| `yt2x notes`        | 结构化笔记（native LLM）               |
| `yt2x article`      | 长文（`files/articles/<videoId>/`）    |
| `yt2x publish`      | 发 X 串推（OAuth 2.0 v2）              |
| `yt2x llm`          | LLM 配置探测 / 校验                    |

更完整的参数与环境变量见仓库根目录 `docs/USAGE.md`。
