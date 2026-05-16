# yt2x

把 YouTube 视频转换成可发布到 X 的结构化内容流水线：

```text
YouTube URL
  -> metadata / subtitles / transcript chunks
  -> structured notes
  -> X long-form article
  -> publish preview or real X post
```

当前项目是一个 TypeScript / pnpm monorepo，主入口是 CLI：**`pnpm yt2x`**。npm 包尚未公开发布，各 `@yt2x/*` workspace 包仍为 **`private: true`**；现阶段推荐 clone 仓库后本地运行。

## 适合谁

- 想把 YouTube 视频快速整理成结构化笔记、长文草稿或 X 发布内容的人。
- 想把采集、LLM 生成、文章改写、发布拆成可回放流水线的开发者。
- 想基于明确磁盘产物和状态文件做多 Agent / 自动化协作的人。

## 当前能力

- **采集**：通过 `yt-dlp` / `ffmpeg` 获取视频元数据、字幕、时间轴文本，可选关键帧截图。
- **笔记**：用 LLM 生成 `structured-notes.md`。
- **长文**：从结构化笔记生成 X 长文 `article.md`。
- **发布**：通过 X OAuth 2.0 / API v2 发布长文或串推。
- **安全预览**：`pipeline --publish review` 只生成发布预览，不会真实发帖。
- **可续跑**：每个视频目录都有 `process-status.json`，流水线可从已有产物恢复。

## 包结构

```text
packages/core
  领域模型、纯函数、Zod schema、端口接口；不依赖 Node I/O。

packages/adapters-node
  Node 适配器：文件系统、子进程、yt-dlp、LLM client、X OAuth、X publish。

packages/cli
  Commander CLI；装配 core 与 adapters-node，暴露 acquire / notes / article / publish / pipeline。
```

更完整的分层说明见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 环境要求

- **Node.js ≥ 22**
- **pnpm 9.x**
- **yt-dlp**
- **ffmpeg**
- 至少一个 LLM API Key，用于 `notes` / `article`

macOS 示例：

```bash
brew install yt-dlp ffmpeg
corepack enable
```

## 快速开始

```bash
git clone https://github.com/yt2x/yt2x.git yt2x
cd yt2x
pnpm install
pnpm run build
pnpm yt2x --help
```

首次 clone 后需要 `pnpm run build`，因为 workspace 包入口指向各自的 `dist/`。如果安装时使用过 `--ignore-scripts`，也请先 build 再运行 CLI。

## 配置 LLM

复制环境变量模板：

```bash
cp .env.example .env
```

然后至少填写一种 provider 的 key，例如：

```bash
YT2X_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

支持的 provider：

| Provider  | 主要环境变量                                                |
| --------- | ----------------------------------------------------------- |
| OpenAI    | `OPENAI_API_KEY`，也支持 `OPENAI_KEY` / `GPT_API_KEY`       |
| Anthropic | `ANTHROPIC_API_KEY`，也支持 `CLAUDE_API_KEY` / `CLAUDE_KEY` |
| DeepSeek  | `DEEPSEEK_API_KEY`                                          |
| Moonshot  | `MOONSHOT_API_KEY`                                          |

`YT2X_LLM_PROVIDER` 可取 `openai`、`anthropic`、`deepseek`、`moonshot`；也支持别名 `gpt`、`claude`、`kimi`。完整配置见 [.env.example](./.env.example) 和 [docs/USAGE.md](./docs/USAGE.md)。

## 15 分钟跑通第一条流水线

下面命令会完成 **采集 + 结构化笔记**，不会生成文章，也不会发布到 X：

```bash
pnpm yt2x pipeline \
  --urls "<YOUTUBE_URL>" \
  --acquire auto --notes auto --article skip --publish skip \
  --out-dir ./files/downloads
```

成功后会在 `./files/downloads/<videoId>/` 看到：

```text
metadata.json
chunks.md
timestamped-cues.md
structured-notes.md
process-status.json
```

只想验证视频采集、不消耗 LLM 配额：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --out-dir ./files/downloads
```

## 常用命令

```bash
# 查看所有命令
pnpm yt2x --help

# 采集视频元数据、字幕、分块文本
pnpm yt2x acquire --urls "<YOUTUBE_URL>"

# 对已采集视频生成结构化笔记
pnpm yt2x notes --video-id <videoId> --llm-provider openai

# 从结构化笔记生成 X 长文
pnpm yt2x article --video-id <videoId>

# 预览发布内容，不调用 X API
pnpm yt2x publish --video-id <videoId> --dry-run

# 全流水线：采集、笔记、文章，跳过发布
pnpm yt2x pipeline \
  --urls "<YOUTUBE_URL>" \
  --acquire auto --notes auto --article auto --publish skip
```

更完整的 CLI 参数说明见 [docs/USAGE.md](./docs/USAGE.md#cli-参数说明)。如果 YouTube 采集遇到登录、人机验证或区域 / 年龄限制，通常需要先在本机浏览器登录 YouTube，再传 `--cookies-from-browser`：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --cookies-from-browser chrome
```

## 发布到 X

真实发布前需要先配置 X OAuth 2.0：

1. 在 X Developer Portal 启用 OAuth 2.0。
2. 设置 callback URL，默认是 `http://127.0.0.1:8989/callback`。
3. 在 `.env` 填写 `X_CLIENT_ID`，必要时填写 `X_CLIENT_SECRET`。
4. 执行登录：

```bash
pnpm yt2x auth login
pnpm yt2x auth whoami
```

发布预览：

```bash
pnpm yt2x publish --video-id <videoId> --dry-run
```

真实发布：

```bash
pnpm yt2x publish --video-id <videoId>
```

流水线发布的安全规则：

- `--publish skip`：不进入发布阶段。
- `--publish review`：只生成 `publish-preview.json`，并更新 `process-status.json`，不会调用 X API。
- `--publish auto`：真实发布，需要本地已有有效 X OAuth 凭证。

因此，想让 pipeline 真发帖时必须显式传：

```bash
pnpm yt2x pipeline \
  --urls "<YOUTUBE_URL>" \
  --acquire auto --notes auto --article auto --publish auto
```

`--video-id` 只接受字母、数字、连字符、下划线，避免把路径误当作视频 ID。需要指定非默认文章目录时使用 `--article-dir`。

## 目录与产物

默认目录：

| 路径                         | 含义                                 |
| ---------------------------- | ------------------------------------ |
| `files/downloads/<videoId>/` | 采集、笔记和每视频状态文件           |
| `files/articles/<videoId>/`  | 长文、发布预览、发布结果和封面图     |
| `files/`                     | 本地产物根目录，除 `.gitkeep` 外忽略 |

关键产物：

| 文件                            | 阶段    | 说明                                     |
| ------------------------------- | ------- | ---------------------------------------- |
| `metadata.json`                 | acquire | 视频元数据                               |
| `chunks.md`                     | acquire | 清洗后的转写分块                         |
| `timestamped-cues.md`           | acquire | 带时间轴的字幕文本                       |
| `structured-notes.md`           | notes   | LLM 结构化笔记                           |
| `article.md`                    | article | 面向 X 的长文 Markdown                   |
| `publish-preview.json`          | publish | dry-run / review 的发布预览              |
| `publish-result.json`           | publish | 真实发布后的 tweet/thread 信息           |
| `process-status.json`           | all     | acquire / notes / article / publish 状态 |
| `process-status.journal.ndjson` | all     | 状态写入恢复日志                         |

数据契约详见 [docs/DATA-CONTRACTS.md](./docs/DATA-CONTRACTS.md)。

## 续跑与批处理

`pipeline --continue-from` 会扫描 `--out-dir` 下已有视频子目录，并按目录名的字典序处理。只要子目录中存在 `metadata.json` 或 `process-status.json`，就会被视为批次队列的一项。

```bash
pnpm yt2x pipeline \
  --continue-from \
  --out-dir ./files/downloads \
  --notes auto --article auto --publish skip
```

项目不再使用根级 `pipeline-state.json`。每个视频目录的 `process-status.json` 是步骤状态的唯一真理。

## 搜索与批量输入

直接传多个 URL：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL_1>" "<YOUTUBE_URL_2>"
```

从文本文件读取 URL：

```bash
pnpm yt2x acquire --url-file ./urls.txt
```

用 YouTube 搜索：

```bash
pnpm yt2x acquire --search "typescript tutorial:3" --search-sort views
```

## 开发命令

```bash
# 构建全部 workspace 包
pnpm run build

# 清理 dist 和 tsbuildinfo
pnpm run clean

# 重新构建
pnpm run rebuild

# 类型检查
pnpm run typecheck

# ESLint
pnpm run lint

# Prettier 检查
pnpm run format:check

# 单元测试
pnpm test

# 本地 CI 快速检查
pnpm run ci

# 覆盖率 + audit，发布前使用
pnpm run ci:full
```

当前测试中 OAuth loopback 相关用例需要本机允许监听 `127.0.0.1`；在受限沙箱中可能出现 `listen EPERM`，这通常是环境限制，不代表业务逻辑失败。

## 质量与安全约束

- TypeScript 开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
- CLI 不接收 LLM API key 参数，密钥只从环境变量或本地凭证读取。
- X token 默认存储在 `~/.config/yt2x/credentials.json`，文件权限由 token store 控制。
- `process-status.json` 写入使用锁和原子写，避免并发损坏。
- 发布阶段区分 preview 与真实发布，`pipeline --publish auto` 才会真实发帖。

## 文档索引

- [docs/USAGE.md](./docs/USAGE.md)：完整用法、环境变量和目录约定。
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)：monorepo 分层与数据流。
- [docs/DATA-CONTRACTS.md](./docs/DATA-CONTRACTS.md)：磁盘产物与 `process-status.json` 契约。
- [docs/AGENT-PROMPTS.md](./docs/AGENT-PROMPTS.md)：多 Agent 协作提示词。
- [docs/ROADMAP.md](./docs/ROADMAP.md)：当前路线图和发布前清单。
- [docs/REFACTOR-STATUS.md](./docs/REFACTOR-STATUS.md)：当前进度。
- [CONTRIBUTING.md](./CONTRIBUTING.md)：贡献与发布流程。

## 发布状态

当前尚未发布到 npm。维护者发布前需要：

1. 确认 `@yt2x/core`、`@yt2x/adapters-node`、`@yt2x/cli` 的 package metadata。
2. 运行 `pnpm run ci:full`。
3. 运行 `pnpm run pack:cli` 并检查 tarball。
4. 按 `core -> adapters-node -> cli` 顺序发布。

细节见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

Apache-2.0。见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
