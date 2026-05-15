# yt2x 使用说明

面向本仓库开发者的日常命令与环境约定。架构总览见 [ARCHITECTURE.md](./ARCHITECTURE.md)，字段与状态契约见 [DATA-CONTRACTS.md](./DATA-CONTRACTS.md)。

## 环境要求

- **Node.js**：≥ 22（见根目录 `package.json` 的 `engines`）
- **包管理**：`pnpm` 9.x（`packageManager` 字段）
- **采集阶段（`yt2x acquire` / `yt2x pipeline` 默认）**：系统需安装 **`yt-dlp`**、**`ffmpeg`**（Node 采集实现，见 `@yt2x/adapters-node` `src/acquire/`），并按需配置浏览器 cookies 等（见 `yt2x acquire --help`）

## 安装

```bash
git clone <repo-url> yt2x && cd yt2x
pnpm install
```

开发时通过 **`pnpm yt2x`** 调用 CLI（等价于 `tsx packages/cli/src/index.ts`）。**`pnpm install` 后请执行 `pnpm run build`**（或 **`pnpm run rebuild`**）生成各 workspace 包的 **`dist/`**（`@yt2x/*` 包入口指向 `dist`）。若 `dist` 异常，先 **`pnpm run clean`** 再 build（会清除各包 **`.tsbuildinfo`**）。

## 常用命令

| 命令                   | 作用                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm yt2x --help`     | 列出所有子命令                                                                                        |
| `pnpm yt2x acquire …`  | 下载元数据、字幕、可选关键帧；`--search "词:2"` 搜前 2 条；`--search-sort views` 按播放量降序后再取 N |
| `pnpm yt2x notes …`    | 生成结构化笔记（native LLM；`--video-id` 或 `--all`）                                                 |
| `pnpm yt2x article …`  | 生成长文（`files/articles/<videoId>/`）                                                               |
| `pnpm yt2x publish …`  | 发布到 X（OAuth 2.0 + v2）                                                                            |
| `pnpm yt2x auth …`     | OAuth 2.0 PKCE 登录 / 登出 / 状态                                                                     |
| `pnpm yt2x pipeline …` | **native acquire** + orchestrator 内 `notes`→`article`→`publish`                                      |
| `pnpm yt2x llm …`      | LLM 连通性诊断                                                                                        |
| `pnpm run ci`          | typecheck + lint + format:check + test                                                                |

`pipeline` 安全默认：`--publish review` 只预览发布内容并写 `publish-preview.json` / `process-status.json`，不会真实调用 X API；真实发帖必须显式传 **`--publish auto`**。只想跑到长文产物时继续使用 **`--publish skip`**。

## 目录约定

| 路径                         | 含义                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `files/downloads/<videoId>/` | 默认采集 + 笔记根目录（`--out-dir` 可改）                           |
| `files/articles/<videoId>/`  | **默认 article（native）** 长文输出（`--article-out-dir` 可改）     |
| `files/`                     | 本地大文件 / 临时产出（根 `.gitignore` 已忽略除 `.gitkeep` 外内容） |

## LLM 环境变量（native 路径）

在仓库根复制 **`.env.example` → `.env`** 并填写密钥；`pnpm yt2x` 启动时会自动加载仓库根（及当前工作目录）的 **`.env`**，且**不会**覆盖已在 shell 里导出的同名变量。

- **默认 provider**（省略 `--llm-provider` 时）：环境变量 **`YT2X_LLM_PROVIDER`** 或 **`YT2X_DEFAULT_LLM_PROVIDER`**，取值 `openai` | `anthropic` | `deepseek` | `moonshot`，或别名 **`gpt`** / **`claude`** / **`kimi`**（未设置时默认为 `openai`）。
- **OpenAI / GPT**：`OPENAI_API_KEY`（或 `OPENAI_KEY`、`GPT_API_KEY`）
- **Anthropic / Claude**：`ANTHROPIC_API_KEY`（或 `CLAUDE_API_KEY`、`CLAUDE_KEY`）
- **DeepSeek**：`DEEPSEEK_API_KEY`
- **Moonshot（Kimi）**：`MOONSHOT_API_KEY`

可选：`OPENAI_BASE_URL` 等覆盖默认 Base URL；CLI 支持 `--llm-provider` / `--llm-model` / `--llm-base-url`。

## X 发布（默认 native `publish`）

先完成 `yt2x auth login`，token 默认在 `~/.config/yt2x/credentials.json`。`publish` 使用 **`--article-out-dir`**（默认 **`./files/articles`**）。

采集在 **`packages/adapters-node/src/acquire/`**（Node + yt-dlp/ffmpeg）。**`yt2x publish` 使用 OAuth 2.0 API**，不依赖浏览器自动化。

发布命令只接受安全的视频目录名作为 **`--video-id`**（字母、数字、连字符、下划线），避免把路径误当成视频 ID。需要指定非默认长文目录时使用 **`--article-dir`**。

## 续跑与批次队列

- **`yt2x pipeline --continue-from`**：在 **`--out-dir`** 下扫描已有 **`metadata.json`** 或 **`process-status.json`** 的视频子目录恢复队列（**不再**读写根目录 `pipeline-state.json`）。
- 视频顺序为子目录名 **`video_id` 字典序**。

## 与 Agent / Skill 的关系

跨平台可复制提示词和本地 Agent Skill 模板以 **`docs/AGENT-PROMPTS.md`** 为准；该文档不绑定单一客户端，可用于 Claude Code、Codex、Cursor 或其他支持用户级指令的 Agent。
