# AGENTS.md

## 通用要求

- 所有回复必须使用中文。
- 改动前先阅读相关代码和文档，遵循仓库现有分层与风格。
- 不要提交真实 API key、OAuth token、cookies、浏览器凭证、下载产物或真实示例视频 ID。
- 文档示例中的 YouTube URL / videoId 必须使用占位符，例如 `<YOUTUBE_URL>`、`<videoId>`。

## 分支命名规范

所有 Agent 创建或重命名分支时，必须使用标准语义前缀，不使用带有 Agent、工具、个人或供应商色彩的前缀。

要求：

- 从最新远端 `main` 创建短分支。创建新分支前必须先同步远端：

  ```bash
  git fetch origin
  git checkout main
  git pull --ff-only origin main
  git checkout -b <type>/<short-topic>
  ```

- 如果本地 `main` 不能 fast-forward，或存在未提交 / 未推送改动，必须先停止并说明状态，不得强行覆盖或重置。
- 分支名使用小写 kebab-case，格式为 `<type>/<short-topic>`。
- `<type>` 必须从以下类型中选择：
  - `feature/`：新功能、实验性能力、用户可见增强。
  - `fix/`：普通缺陷修复。
  - `hotfix/`：需要快速处理的生产或发布阻断修复。
  - `docs/`：仅文档改动。
  - `chore/`：维护性工作，例如依赖、配置、脚本、仓库 housekeeping。
  - `refactor/`：不改变行为的结构调整。
  - `test/`：测试补充或测试基础设施改动。
- 分支主题必须描述问题或目标，例如 `feature/x-target-output-test`、`fix/publish-review-dry-run`。
- 不要使用 `codex/`、`agent/`、个人姓名、模型名或工具名作为分支前缀。
- 一个分支只解决一个清晰问题，不把大规模格式化、重命名、行为变更混在一起。

## 提交信息规范

所有 Agent 创建或修改提交时，必须使用与初始提交一致的完整提交信息格式：

```text
Short summary in sentence case

Explain what changed and why in one short paragraph.

Included:

- concrete change one
- concrete change two
- concrete change three

Optional final note about scope, compatibility, or operational impact.
```

要求：

- 提交必须包含 body，不能只有一行 subject。
- subject 使用简洁英文句子，不使用 Conventional Commits 前缀，例如 `docs:`、`fix:`、`feat:`。
- subject 不以句号结尾。
- subject 与 body 之间保留一个空行。
- body 说明本次改动的目的和影响，不只重复文件名。
- 多项改动使用 `Included:` 加无序列表。
- 如果 amend 现有提交，也必须保持上述格式。
