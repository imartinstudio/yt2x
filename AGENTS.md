# AGENTS.md

## 通用要求

- 所有回复必须使用中文。
- 改动前先阅读相关代码和文档，遵循仓库现有分层与风格。
- 不要提交真实 API key、OAuth token、cookies、浏览器凭证、下载产物或真实示例视频 ID。
- 文档示例中的 YouTube URL / videoId 必须使用占位符，例如 `<YOUTUBE_URL>`、`<videoId>`。

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
