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
| `pnpm yt2x article …`  | 生成长文、串推或短帖（`files/articles/<videoId>/`）                                                   |
| `pnpm yt2x publish …`  | 发布到 X（OAuth 2.0 + v2）                                                                            |
| `pnpm yt2x auth …`     | OAuth 2.0 PKCE 登录 / 登出 / 状态                                                                     |
| `pnpm yt2x pipeline …` | **native acquire** + orchestrator 内 `notes`→`article`→`publish`                                      |
| `pnpm yt2x llm …`      | LLM 连通性诊断                                                                                        |
| `pnpm run ci`          | typecheck + lint + format:check + test                                                                |

`pipeline` 安全默认：`--publish review` 只预览发布内容并写 `publish-preview.json` / `process-status.json`，不会真实调用 X API；真实发帖必须显式传 **`--publish auto`**。只想跑到内容生成产物时继续使用 **`--publish skip`**。

## CLI 参数说明

所有命令都可以先用 `--help` 查看当前实现支持的参数，例如：

```bash
pnpm yt2x acquire --help
pnpm yt2x pipeline --help
pnpm yt2x publish --help
```

### 视频来源参数

`acquire` 和 `pipeline` 至少需要一种视频来源；`notes` / `article` / `publish` 通常使用 `--video-id`、`--all` 或已有目录。

| 参数                  | 适用命令                                     | 说明                                                             |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| `--urls <url...>`     | `acquire`、`pipeline`、通用来源参数          | 一个或多个 YouTube URL，空格分隔。                               |
| `--url-file <path>`   | `acquire`、`pipeline`、通用来源参数          | 文本文件，每行一个 URL。                                         |
| `--search <query>`    | `acquire`、`pipeline`、通用来源参数          | 用 `yt-dlp ytsearch` 搜索；支持 `"关键词:N"` 取前 N 条。         |
| `--search-sort views` | `acquire`、`pipeline`、通用来源参数          | 配合 `--search` 使用，按播放量降序后再取 N；当前仅支持 `views`。 |
| `--video-id <id...>`  | `notes`、`article`                           | 处理一个或多个视频 ID；也可传绝对路径到视频目录。                |
| `--video-id <id>`     | `publish`                                    | 在 `--article-out-dir` 下查找对应文章目录。                      |
| `--all`               | `notes`、`article`                           | 批量处理所有符合条件的视频目录。                                 |
| `--out-dir <path>`    | `acquire`、`notes`、`article`、`pipeline` 等 | 采集和笔记根目录，默认 `files/downloads`。                       |

### 采集参数

这些参数适用于 `yt2x acquire`，也适用于 `yt2x pipeline` 的采集阶段。

| 参数                            | 默认值 | 说明                                                                                       |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `--keyframes <n>`               | `0`    | 提取场景关键帧数量；`0` 表示跳过关键帧。需要 `ffmpeg`。                                    |
| `--jobs <n>`                    | `3`    | 并发采集任务数。                                                                           |
| `--sub-langs <lang>`            | 自动   | 手动字幕语言覆盖值，会传给 `yt-dlp --sub-langs`，例如 `en`、`zh-Hans`、`en,zh.*`。         |
| `--scene-threshold <n>`         | `0.35` | 场景检测阈值；值越低通常越容易切出更多关键帧。                                             |
| `--scene-min-gap <n>`           | `12`   | 关键帧最小间隔秒数。                                                                       |
| `--max-words <n>`               | `900`  | `chunks.md` 每个转写分块的最大词数。                                                       |
| `--cookies-from-browser <name>` | 无     | 把浏览器登录态 cookies 传给 `yt-dlp --cookies-from-browser`。详见下方“人机验证 / 登录态”。 |
| `--proxy <url>`                 | 无     | 把代理传给 `yt-dlp --proxy`，例如 `http://127.0.0.1:1082`。                                |
| `--error-strategy stop\|skip`   | `stop` | 批量采集时遇到失败是立刻停止，还是跳过失败项继续处理后续视频。                             |

#### YouTube 人机验证 / 登录态

如果采集失败并出现 YouTube 要求登录、确认不是机器人、人机验证、年龄限制、区域限制，或 `yt-dlp did not write .info.json (check cookies / network)` 之类错误，优先使用浏览器 cookies：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --cookies-from-browser chrome
```

完整流水线同理：

```bash
pnpm yt2x pipeline \
  --urls "<YOUTUBE_URL>" \
  --cookies-from-browser chrome \
  --acquire auto --notes auto --article auto --publish skip
```

`--cookies-from-browser` 的值会原样传给 `yt-dlp`。常见值包括 `chrome`、`firefox`、`edge`、`brave`、`chromium`、`safari` 等；如果你使用浏览器 profile，也可以使用 `yt-dlp` 支持的扩展格式。建议先在目标浏览器里登录 YouTube，并确认可以正常打开该视频，再运行 yt2x。macOS 上读取浏览器 cookies 时可能会弹出钥匙串授权。

如果网络环境还需要代理，可以同时传：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --cookies-from-browser chrome \
  --proxy "http://127.0.0.1:1082"
```

注意：这些 cookies 只从本机浏览器读取并传给本机 `yt-dlp` 进程；不要把浏览器 cookies、导出的 cookie 文件、API key 或 OAuth token 提交到仓库。

### Pipeline 阶段控制参数

| 参数                           | 默认值   | 说明                                                             |
| ------------------------------ | -------- | ---------------------------------------------------------------- |
| `--acquire auto\|review\|skip` | `auto`   | 采集阶段：自动执行、执行前确认、跳过。                           |
| `--notes auto\|review\|skip`   | `review` | 结构化笔记阶段。                                                 |
| `--article auto\|review\|skip` | `review` | 内容生成阶段；默认生成 `article.md`，可用 `--targets` 调整。     |
| `--publish auto\|review\|skip` | `review` | 发布阶段；`review` 只生成预览，`auto` 才会真实发帖。             |
| `--continue-from`              | 关闭     | 从 `--out-dir` 下已有视频目录和 `process-status.json` 恢复队列。 |
| `--force`                      | 关闭     | 覆盖已有 `structured-notes.md` 等阶段产物。                      |
| `--error-strategy stop\|skip`  | `stop`   | 阶段失败时停止或跳过继续。                                       |
| `--verbose`                    | 关闭     | 输出更详细日志。                                                 |

### LLM 参数

`notes`、`article` 和 `pipeline` 会使用 LLM。

| 参数                   | 说明                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `--llm-provider <id>`  | `openai`、`anthropic`、`deepseek`、`moonshot`；默认读环境变量。 |
| `--llm-model <name>`   | 覆盖 provider 默认模型。                                        |
| `--llm-base-url <url>` | 覆盖 provider 默认 Base URL，适合 OpenAI 兼容网关或代理。       |

可先用下面命令验证 LLM 配置：

```bash
pnpm yt2x llm ping --provider openai
```

### 文章与发布参数

| 参数                        | 适用命令              | 说明                                                                                                |
| --------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `--platform <name>`         | `article`、`pipeline` | 目标平台；当前主要支持 `x`。                                                                        |
| `--rewrite-mode rules\|llm` | `pipeline`            | 长文标题 / 内容改写策略；默认 `rules`。                                                             |
| `--targets <targets>`       | `article`、`pipeline` | 生成目标，支持 `article`、`x-thread`、`x-short`、`all` 和逗号分隔组合；`x-longform` 仅作旧别名。    |
| `--article-out-dir <path>`  | `article`、`publish`  | 文章输出根目录，默认 `files/articles`。                                                             |
| `--article-dir <path>`      | `publish`             | 显式指定文章目录，跳过按 `--video-id` 自动发现。                                                    |
| `--profile <name>`          | `publish`             | X OAuth 凭证 profile，默认 `default`。                                                              |
| `--dry-run`                 | `publish`             | 只生成 / 打印发布预览，不调用 X API。                                                               |
| `--publish-dry-run`         | `pipeline`            | pipeline 发布阶段 dry-run。                                                                         |
| `--target <target>`         | `publish`             | 发布目标，支持 `article`、`x-thread`、`x-short`、`x-thread-short`；`article` 只预览，不调用 X API。 |
| `--thread-source <source>`  | `publish`             | `x-thread` 来源：`generated` 使用 `x-thread.md`，`article` 拆 `article.md`，`auto` 优先生成串推。   |
| `--thread`                  | `publish`、`pipeline` | 兼容开关，等价于 `--target x-thread`。                                                              |
| `--publish-max-chars <n>`   | `publish`、`pipeline` | `x-thread` 单条字数上限，默认 500；`x-short` 不设置固定字数上限。                                   |
| `--max-chars <n>`           | `publish`、`pipeline` | `publish` 中是 `--publish-max-chars` 别名；`pipeline` 中也是文章阶段提示。                          |
| `--max-tweets <n>`          | `publish`、`pipeline` | thread 模式最大推文数，`x-thread` 默认 8，`x-thread-short` 默认 10，最大 10。                       |
| `--thread-delay <range>`    | `publish`、`pipeline` | thread 每两条之间的等待秒数，默认 `20-30`；固定值如 `10`，`0` 表示不等待。                          |
| `--numbering`               | `publish`             | thread 模式下给每条推文加编号。                                                                     |
| `--continue-on-failure`     | `publish`             | thread 发布时某条失败后继续尝试后续推文。                                                           |

## 目录约定

| 路径                         | 含义                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `files/downloads/<videoId>/` | 默认采集 + 笔记根目录（`--out-dir` 可改）                           |
| `files/articles/<videoId>/`  | **默认 article（native）** 内容输出（`--article-out-dir` 可改）     |
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

发布命令只接受安全的视频目录名作为 **`--video-id`**（字母、数字、连字符、下划线），避免把路径误当成视频 ID。需要指定非默认内容目录时使用 **`--article-dir`**。

生成阶段可自由组合目标：

```bash
pnpm yt2x article --video-id <videoId> --targets article,x-thread,x-short
pnpm yt2x pipeline --urls "<YOUTUBE_URL>" --targets all --publish review
```

发布阶段一次只发布一种目标：

```bash
pnpm yt2x publish --video-id <videoId> --target article --dry-run
pnpm yt2x publish --video-id <videoId> --target x-thread --thread-source generated --dry-run
pnpm yt2x publish --video-id <videoId> --target x-short --dry-run
pnpm yt2x publish --video-id <videoId> --target x-thread-short --dry-run
```

`article` 目标只做草稿预览；X 当前没有公开 Article 发布 API，因此真实 API 发布覆盖 `x-thread`、`x-short` 和 `x-thread-short`。`x-thread-short` 会把 `x-short.md` 作为首推，再把 `x-thread.md` 中的内容按顺序作为回复发布；`x-short` / `x-thread-short` 发布首推时会尽量附带 `images/cover.*` 封面图。真实发布 `x-thread` / `x-thread-short` 时，每两条推文之间默认随机等待 20-30 秒，可用 `--thread-delay` 配置。旧参数 **`--thread`** 保持兼容，等价于 **`--target x-thread`**。

`x-thread.md` 发布时用行首 `1/`、`2/`、`3/` 作为 tweet 边界，单条 tweet 内部的空行、列表和代码块会保留到同一条回复中。发布前会把 Markdown 转成 X 兼容文本：加粗中的英文 / 数字转为 Unicode bold，中文保持原字形；列表、代码块、链接、引用等会按 X 可读形式转换。

## 续跑与批次队列

- **`yt2x pipeline --continue-from`**：在 **`--out-dir`** 下扫描已有 **`metadata.json`** 或 **`process-status.json`** 的视频子目录恢复队列（**不再**读写根目录 `pipeline-state.json`）。
- 视频顺序为子目录名 **`video_id` 字典序**。

## 与 Agent / Skill 的关系

跨平台可复制提示词和本地 Agent Skill 模板以 **`docs/AGENT-PROMPTS.md`** 为准；该文档不绑定单一客户端，可用于 Claude Code、Codex、Cursor 或其他支持用户级指令的 Agent。
