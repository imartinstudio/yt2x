# yt2x · Agent Prompts

本文件为 **任意 LLM 对话或本地 Agent 客户端**（Claude / ChatGPT / Codex / Cursor / DeepSeek / Gemini 等）提供可复制的提示词与 Skill 模板：默认只引用 **CLI 命令** 与仓库文档，不绑定单一厂商。

**仓库内开发**时优先使用：`pnpm yt2x …`（等价 `tsx packages/cli/src/index.ts`）。全局安装发布后可用 `yt2x …`。

**默认行为（v0.1+）**：`acquire` / `notes` / `article` / `publish` / `pipeline` 均走 CLI native 实现（见 [USAGE.md](./USAGE.md)、[ARCHITECTURE.md](./ARCHITECTURE.md)）。

---

## 1. 完整流水线（采集 → 笔记 → 长文 → 发布）

把下面整段贴给 Agent（将 `<URL>` 换成真实链接；按需改 `--out-dir` / provider）：

```text
我有一条 YouTube 视频：<URL>

请在已安装 yt2x 与依赖（Node 22+、pnpm、yt-dlp、ffmpeg，见仓库 README / docs/USAGE.md）的机器上按顺序执行：

1. 采集元数据与字幕：
   pnpm yt2x acquire --urls "<URL>"
2. 生成结构化笔记（需配置 OPENAI_API_KEY 等）：
   pnpm yt2x notes --video-id <从输出目录推断的 videoId>
3. 生成 X 长文（输出默认在 files/articles/<videoId>/）：
   pnpm yt2x article --video-id <同上 videoId>
4. 发布到 X（OAuth2 + v2；需先 pnpm yt2x auth login）：
   pnpm yt2x publish --video-id <同上 videoId> --dry-run
   确认无误后再去掉 --dry-run 真发。

或一条命令跑全流程：pnpm yt2x pipeline --urls "<URL>"（按需加 --skip-* 控制阶段）。

参考文档：README.md、docs/USAGE.md、docs/DATA-CONTRACTS.md
```

---

## 2. 仅采集（不跑 LLM）

```text
请在本机用 yt2x 只下载某条 YouTube 的字幕与元数据（及可选关键帧），不生成笔记：

  pnpm yt2x acquire --urls "<URL>"

输出默认在 files/downloads/<videoId>/。环境要求见 docs/USAGE.md。
```

---

## 3. 仅笔记 / 仅长文（已有视频目录）

```text
视频目录已在 files/downloads/<videoId>/，且含 chunks.md 等。请生成结构化笔记（默认 native）：

  pnpm yt2x notes --video-id <videoId>

再生成 X 长文（默认 native）：

  pnpm yt2x article --video-id <videoId>

环境变量与 LLM 选项见 pnpm yt2x notes --help / article --help。
```

---

## 4. 仅发布（已有 article.md）

```text
长文已生成在 files/articles/<videoId>/article.md。请先 dry-run 再真发：

  pnpm yt2x publish --video-id <videoId> --dry-run
  pnpm yt2x publish --video-id <videoId>

`pnpm yt2x publish --video-id <id> --dry-run`（默认从 `files/articles/<id>/article.md` 解析；可用 `--article-out-dir` / `--article-dir` 覆盖）。
```

---

## 5. 自定义改写风格（对话里约束，不改代码）

```text
在运行 pnpm yt2x article 之前，我希望长文风格更偏「<例如：口语化 / 硬核技术 / 少形容词>」。
请在同一轮对话里根据我已提供的 structured-notes.md 内容，先给出你认为合适的段落级提纲，再说明你会如何在 article 阶段用提示词约束模型——但不要编造笔记里不存在的事实。
```

（系统级 prompt 的源码真值在 `packages/core/src/domain/article/prompts.ts`；若要长期改风格应改代码并跑 `pnpm run ci`。）

---

## 6. 与「真实 prompt 文本」的关系

- **笔记 / 长文** 的 system prompt 与拼装逻辑在 **`packages/core/src/domain/notes/`**、**`packages/core/src/domain/article/`**，以 TypeScript 为准。
- 本文件 **不复制** 全文 prompt，避免与代码漂移；Agent 场景以 **CLI + 上述路径** 为单一事实来源。

---

## 7. 本地 Agent Skill（可选）

如果你使用支持本地 Skill / Rules / Agent instruction 的客户端，可以把下面模板复制到对应的用户级配置目录。不要把个人配置目录、API Key、OAuth token 或 cookies 提交进本仓库。

常见安装位置由客户端决定，例如：

- Claude Code：`~/.claude/skills/yt2x/SKILL.md`
- Codex：`~/.codex/skills/yt2x/SKILL.md`
- Cursor：用户级 rules / skills / project rules 配置
- 其他 Agent：任意等价的用户级指令文件

可复制模板：

```markdown
---
name: yt2x
description: Use yt2x CLI to turn YouTube videos into structured notes, X articles, publish previews, or X posts.
---

# yt2x Agent Skill

Use this skill when the user mentions YouTube transcription, structured notes,
X long-form articles, X posting, `yt2x`, `pnpm yt2x`, subtitles, or keyframe
acquisition.

## Canonical docs

If the current workspace is a yt2x clone, read these first:

- `README.md`
- `docs/USAGE.md`
- `docs/AGENT-PROMPTS.md`
- `docs/DATA-CONTRACTS.md`
- `docs/ARCHITECTURE.md`

## Command policy

- In the yt2x repo, prefer `pnpm yt2x <subcommand>`.
- After npm release, global installs may use `yt2x <subcommand>`.
- Treat `yt2x --help` and subcommand `--help` as the live CLI source of truth.
- Do not ask the user to paste API keys; use environment variables and `yt2x auth login`.
- Long-running stages write `process-status.json`; use it with CLI logs for debugging.
- Never post to X unless the user explicitly requests real publishing. Prefer `--dry-run` or `pipeline --publish review`.

## Common flow

1. Acquire:
   `pnpm yt2x acquire --urls "<URL>"`
2. Notes:
   `pnpm yt2x notes --video-id <videoId>`
3. Article:
   `pnpm yt2x article --video-id <videoId>`
4. Publish preview:
   `pnpm yt2x publish --video-id <videoId> --dry-run`

Only remove `--dry-run` or use `pipeline --publish auto` after explicit confirmation.
```
