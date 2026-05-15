# Architecture Decision Records (ADR)

本目录记录 yt2x 项目的重大架构决策。ADR 只保留仍能解释当前代码结构和边界的决策；过期的操作手册和低价值模板不放在这里。

## 索引

| 编号                                                | 标题                        | 状态     | 日期       |
| --------------------------------------------------- | --------------------------- | -------- | ---------- |
| [0001](./0001-multi-target-architecture.md)         | 多端架构与 Monorepo         | Accepted | 2026-05-14 |
| [0002](./0002-llm-provider-abstraction.md)          | LLM Provider 抽象与国内兼容 | Accepted | 2026-05-14 |
| [0003](./0003-publish-safety-and-process-status.md) | 发布安全与每视频状态契约    | Accepted | 2026-05-16 |

## 格式约定

每条 ADR 包含：

- **Status**：Proposed / Accepted / Deprecated / Superseded by ADR-N
- **Context**：决策背景与约束
- **Decision**：做了什么决定
- **Consequences**：正面/负面影响
- **Alternatives Considered**：被否决的方案与原因

## 撰写新 ADR

新增 ADR 时，复制现有 ADR 的结构即可，并在本索引追加一行。ADR 应记录影响长期架构或维护边界的决策，不用于记录一次性任务清单。
