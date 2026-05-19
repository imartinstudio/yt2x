# yt2x 当前状态

> **用途**：快速了解当前实现、剩余工作和文档入口。长期方向见 [ROADMAP.md](./ROADMAP.md)。

| 字段         | 值                                                              |
| ------------ | --------------------------------------------------------------- |
| **最后更新** | 2026-05-16                                                      |
| **当前阶段** | v0.1 开源前打磨期；CLI first；npm 发布放最后                    |
| **运行入口** | 本地 clone 后使用 `pnpm yt2x`                                   |
| **发布状态** | 根包和三个 workspace 包仍为 `private: true`，尚未公开发布到 npm |

## 当前已落地

| 维度                 | 状态   | 备注                                                       |
| -------------------- | ------ | ---------------------------------------------------------- |
| Monorepo + pnpm + TS | 已落地 | `packages/core`、`packages/adapters-node`、`packages/cli`  |
| Native CLI           | 已落地 | `acquire` / `notes` / `article` / `publish` / `pipeline`   |
| YouTube 采集         | 已落地 | Node adapter 调用 `yt-dlp` / `ffmpeg`                      |
| LLM provider 抽象    | 已落地 | OpenAI 兼容、Anthropic、DeepSeek、Moonshot                 |
| X OAuth 2.0 PKCE     | 已落地 | `auth login` / `whoami` / token store                      |
| Native publish       | 已落地 | X API v2，支持长文、thread、封面上传降级                   |
| 发布安全预览         | 已落地 | `--dry-run` / `pipeline --publish review` 不真实发帖       |
| 批次队列 + 步骤状态  | 已落地 | 每视频 `process-status.json`，无根级 `pipeline-state.json` |
| 历史文档清理         | 已落地 | 历史 PR 验收稿、旧重构蓝图、一次性修复记录已从 docs 中移除 |
| v2.0 视频片段下载    | 进行中 | `--download-video` / `--video-only` 任务文档与实现推进中   |

## 架构快照

```text
packages/core
  领域模型、纯函数、Zod schema、端口接口

packages/adapters-node
  fs、process runner、yt-dlp/ffmpeg、LLM clients、X OAuth、X publish

packages/cli
  Commander 命令、参数解析、流水线编排、日志和进度展示
```

## 下一步

1. 跑一次完整本地质量闸：`pnpm run ci`。
2. 手测真实视频：`acquire -> notes -> article -> publish --dry-run`。
3. 发布前跑 `pnpm run ci:full`。
4. 如需公开 npm 包，按 [CONTRIBUTING.md](../CONTRIBUTING.md) 的维护者发布流程执行。
5. 可选：补 README 演示 GIF 或短视频。

## 当前文档入口

| 文档                                                     | 说明                         |
| -------------------------------------------------------- | ---------------------------- |
| [README.md](../README.md)                                | 项目入口、快速开始、常用命令 |
| [USAGE.md](./USAGE.md)                                   | 详细命令、环境变量、续跑说明 |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                     | 包职责与数据流               |
| [DATA-CONTRACTS.md](./DATA-CONTRACTS.md)                 | 磁盘产物与状态文件契约       |
| [ROADMAP.md](./ROADMAP.md)                               | 当前路线图                   |
| [VIDEO-DOWNLOAD-V2-TASK.md](./VIDEO-DOWNLOAD-V2-TASK.md) | v2.0 视频片段下载执行任务    |
| [AGENT-PROMPTS.md](./AGENT-PROMPTS.md)                   | 多 Agent 协作提示词          |
| [adr/README.md](./adr/README.md)                         | 架构决策记录                 |
| [CONTRIBUTING.md](../CONTRIBUTING.md)                    | 贡献与发布流程               |
