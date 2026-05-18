# Content quality task

版本归属：v0.2

## 背景

yt2x 已支持 `article`、`x-short`、`x-thread`、`x-thread-short` 多目标生成，并已接入截图和发布配图链路。但最近两天真实发布的 Article 暴露出一个共同问题：内容信息量足够，但呈现仍偏“传统博客体”，没有充分适配 X 的信息流、移动端阅读和互动机制。

典型问题：

- 首屏 Hook 偏背景介绍，缺少具体痛点、损失或收益承诺。
- Markdown 格式可用但不稳定，容易形成长段落堆叠。
- 截图和封面没有稳定承担解释、验证或首屏吸引任务。
- 高信任成本内容缺少风险、边界和透明说明。
- 干货总结多，但缺少读者可直接复制或执行的资产。
- Short 和 Thread 也存在同类问题：像摘要，而不是信息流内容产品。

本任务目标是把生成规则从“可读 Markdown”升级为“适合 X 发布、移动端扫描、可收藏、可互动的内容单元”。

## 目标

新增内容质量规则层，覆盖 `article`、`x-short` 和 `x-thread`：

```text
structured-notes
  -> content angle planning
  -> platform-specific quality rules
  -> article / short / thread prompt
  -> generated artifact
  -> deterministic quality checks
```

首个可交付版本优先改 prompt 和本地校验，不引入复杂多模型评审。

## 非目标

- 不追求廉价标题党，不编造原材料没有的数据、来源、结果或官方链接。
- 不强制每篇都插图；没有高价值截图时保持纯文本。
- 不把 CTA 机械写成“评论区打 1”，避免账号风格劣化。
- 不在 v0.2 MVP 中实现自动发帖时间优化或平台算法预测。
- 不把发布数据归因做成硬判断；曝光、点赞、互动只能作为后续评估信号。

## 设计原则

- **首屏优先**：标题和前 120 字必须让读者知道“这和我有什么关系”。
- **移动端扫描**：段落短、层级清晰，每 250-400 字必须有视觉锚点。
- **信任前置**：涉及账号、支付、风控、购买、平台规则时，必须独立说明风险和适用边界。
- **可执行资产**：每篇至少提供一个可复制 prompt、模板、检查清单、步骤表、风险清单或决策树。
- **视觉服务信息**：图片必须解释界面、验证结果、流程节点或对比关系；不能为了“有图”插低价值截图。
- **跨目标一致**：Article、Short、Thread 使用同一套内容判断，但按平台形态输出不同结构。

## 内容质量规则

### Article 规则

Article 必须满足：

- 标题要忠实，但必须包含具体对象、冲突、收益或结果。
- 导语前 120 字必须使用“场景 / 痛点 / 后果 / 收益承诺”中的至少 2 个元素。
- 禁止用纯背景句开头，例如“近年来”“随着”“某某从未放松”“本视频介绍了”。
- 每个小节最多连续 2 个正文段落；超过后必须插入列表、引用块、代码块、警示块、图片或分隔。
- 每个核心小节必须有一句加粗结论。
- 长步骤必须拆成“准备 / 操作 / 验证 / 风险”或同等清晰结构。
- 涉及账号、支付、购买、充值、封号、平台风控时，必须包含 `## **风险与适用边界**`。
- 涉及第三方服务、优惠口令、购买渠道时，促销信息只能出现一次，并说明其来自原材料还是作者补充。
- 每篇至少包含一个“可拿走资产”：prompt、模板、清单、步骤表、风险清单或决策树。
- 最后一段 CTA 必须具体，但不能破坏专业可信度。

### Short 规则

Short 必须满足：

- 第一段必须是强判断或强反差，不是摘要。
- 必须给出 4-6 条可收藏要点，每条都有具体信息增量。
- 至少 1 条要点必须是可执行动作、检查项或模板片段。
- 结尾必须给出明确互动动作或读者收益。
- 不输出“本视频讲了”“总结一下”这类摘要腔。
- 不使用表格；用编号列表或短行字段表达。

### Thread 规则

Thread 必须满足：

- 首推必须像 Short：独立成立，覆盖核心冲突、读者收益和继续阅读理由。
- 第二条开始逐条展开，每条只讲一个信息增量。
- 至少一条 tweet 给出模板、清单、操作步骤或风险提示。
- 抽象框架必须通过对比、流程或层级表达，避免连续概念堆叠。
- 最后一条 CTA 从开放问题升级为具体互动动作，例如让读者回复自己的场景、选择或第一步。
- 不把 Article 机械切片成 Thread。

## 视觉与封面规则

- Article 封面优先使用 `youtube_cover.*`；没有官方封面时再回退到高质量截图。
- `contact_sheet.*` 不得作为默认封面，除非没有任何其他图片。
- 抽象框架类内容应优先生成“视觉建议”，例如层级图、流程图、错误/正确对比图、模板卡片。
- 如果当前版本没有图片生成或图表渲染能力，先把视觉建议写入调试或计划产物，不强行插入正文。
- Short / Thread 的配图必须与具体 tweet 或短帖要点绑定，不能只作为装饰图。

## 信任与风险规则

高信任成本主题包括但不限于：

- Apple ID、账号注册、外区账号、封号、平台风控。
- 付款、礼品卡、充值、订阅、退款、第三方购买渠道。
- OAuth、API key、token、cookies、浏览器凭证。
- 自动发布、删除数据、部署代码、发送消息。

触发高信任成本主题时：

- Article 必须有独立风险小节。
- Short 必须至少有 1 条风险提醒。
- Thread 必须至少有 1 条风险或边界 tweet。
- 不得弱化后果，例如账号锁定、充值失败、资金损失、凭证泄露。
- 不得编造“官方认可”“永久有效”“百分百成功”等无来源保证。

## 质量检查

MVP 先做确定性检查，避免依赖二次 LLM 评审：

- Article 检查：
  - 标题存在且加粗。
  - 导语不超过 120 字。
  - 是否存在 `##` 小节。
  - 是否存在连续超长段落。
  - 高信任主题是否包含风险小节。
  - 是否包含可执行资产信号：代码块、清单、模板、步骤或 prompt。
- Short 检查：
  - 是否包含 4-6 条 list item。
  - 是否存在首句摘要腔禁用词。
  - 是否包含至少 1 条可执行要点。
- Thread 检查：
  - tweet 数量在 6-10 条。
  - 首推不以串推编号解释原视频。
  - 是否包含至少 1 条模板、清单、步骤或风险 tweet。

检查失败时，MVP 可先报 warning；后续再支持自动 retry。

## 开发步骤

本功能必须按任务拆分推进。每个任务完成后，需要在本节把任务总览和任务内完成标记从 `[ ]` 改为 `[x]`，将状态改为“已完成”，并确保该任务的验收标准已经满足。

任务总览：

- [x] Task 1: Content quality requirements and fixtures
- [x] Task 2: Article prompt upgrade
- [x] Task 3: Short prompt upgrade
- [x] Task 4: Thread prompt upgrade
- [x] Task 5: Deterministic quality checks
- [x] Task 6: Visual suggestion and cover policy
- [x] Task 7: Documentation and manual evaluation

### Task 1: Content quality requirements and fixtures

状态：已完成

范围：

- 固化本文档中的 Article / Short / Thread 质量规则。
- 选取至少 3 个真实或脱敏 fixture：
  - 高信任成本教程类，例如外区账号注册。
  - 抽象框架类，例如 Claude Skills 工作流。
  - 普通工具教程类。
- 为每个 fixture 记录预期内容特征：Hook 类型、风险需求、可执行资产类型、视觉需求。

验收：

- fixture 不包含真实 API key、OAuth token、cookies、浏览器凭证或真实新视频 ID 示例。
- 每个 fixture 有明确质量预期，能用于 prompt 单测或快照评估。

完成后标记：

- [x] Task 1 complete

### Task 2: Article prompt upgrade

状态：已完成

范围：

- 更新 `ARTICLE_X_SYSTEM_PROMPT`。
- 强化首屏 Hook、移动端节奏、风险边界、可执行资产和视觉使用规则。
- 增加高信任成本主题处理要求。
- 要求模型在没有合适截图时不硬插图。

验收：

- 单测覆盖 prompt 中存在关键规则。
- 用现有 GAt5pcQbZkw / qOvc9IUKEIc 产物手测重生成时，文章包含强 Hook、风险/边界或模板资产。
- 不编造官方链接、数据或原材料没有的来源。

完成后标记：

- [x] Task 2 complete

### Task 3: Short prompt upgrade

状态：已完成

范围：

- 更新 `SHORT_X_SYSTEM_PROMPT`。
- 强制首句判断、4-6 条可收藏要点、至少 1 条可执行动作或模板片段。
- 增加高信任主题风险提醒。
- 细化 CTA 规则，避免机械互动话术。

验收：

- 单测覆盖 prompt 中存在关键规则。
- 生成的 short 不再像长文摘要压缩版。
- JSON schema 保持兼容，现有发布链路不破坏。

完成后标记：

- [x] Task 3 complete

### Task 4: Thread prompt upgrade

状态：已完成

范围：

- 更新 `THREAD_X_SYSTEM_PROMPT`。
- 强化首推独立传播能力。
- 要求至少 1 条 tweet 提供模板、清单、步骤或风险提示。
- 抽象概念必须用对比、流程或层级表达。
- 细化最后一条 CTA 的具体互动要求。

验收：

- 单测覆盖 prompt 中存在关键规则。
- 生成的 thread 不是 article 切片，也不是视频摘要。
- tweet 数量、JSON schema 和现有发布链路保持兼容。

完成后标记：

- [x] Task 4 complete

### Task 5: Deterministic quality checks

状态：已完成

范围：

- 新增纯函数校验 Article / Short / Thread 基础质量。
- 先以 warning 形式集成到生成阶段，不阻断产物落盘。
- 检查项包括 Hook、段落长度、风险小节、可执行资产、list 数量、tweet 数量和摘要腔禁用词。

验收：

- 有单测覆盖通过和失败样例。
- 检查失败时日志能指出具体原因和产物路径。
- 不调用 LLM，不增加生成成本。

完成后标记：

- [x] Task 5 complete

### Task 6: Visual suggestion and cover policy

状态：已完成

范围：

- 固化封面选择策略：`youtube_cover.*` 优先，`contact_sheet.*` 最后回退。
- 为抽象框架类内容增加视觉建议产物，例如 `visual-suggestions.json`。
- 视觉建议只描述“应该生成什么图”，不在没有图片文件时写入 Markdown 图片引用。

验收：

- 封面策略有单测覆盖。
- 抽象框架类 fixture 能输出视觉建议。
- 没有真实图片文件时正文不出现虚构图片路径。

完成后标记：

- [x] Task 6 complete

### Task 7: Documentation and manual evaluation

状态：已完成

范围：

- 更新 `docs/USAGE.md` 或相关文档，说明内容质量规则和 warning 含义。
- 为 GAt5pcQbZkw / qOvc9IUKEIc 做一次手动重生成对比记录。
- 记录哪些优化属于 prompt 层，哪些需要后续图表生成或发布时间策略支持。

验收：

- 文档说明用户如何理解质量 warning。
- 至少两条真实样例完成人工对比。
- 明确后续增强不阻塞 v0.2 MVP。

落实记录：

- `docs/USAGE.md` 已新增「内容质量 warning」「视觉建议产物 `visual-suggestions.json`」「文章封面选择规则」三段说明，覆盖所有 deterministic check 的 code 与处理建议。
- 高信任成本场景的判断逻辑与 warning code 同源（`HIGH_TRUST_TOPIC_KEYWORDS` 与 `RISK_SECTION_KEYWORDS`），用户在文档中即可看到「触发哪类主题需要补充哪类小节」。
- 视觉建议产物只在抽象框架 / 流程 / 对比 / 模板 / 风险等小节命中时落盘，避免在普通工具教程下污染目录。

手动评估对照模板：

> 真实视频 ID 在文档中统一使用占位符 `<videoId-A>` / `<videoId-B>` 代替，与 AGENTS.md 一致；对照表只承诺方法和字段，不固化真实 ID。

执行步骤：

1. 选择两条之前已发布的 article，记录原始产物路径（例如 `files/articles/<videoId-A>/article.md`）。
2. 备份原始 `article.md` / `x-short.md` / `x-thread.md` / `x-hooks.json` / `visual-suggestions.json`（如有）。
3. 用 `--force` 重新生成：`pnpm yt2x article --video-id <videoId-A> --targets all --force`。
4. 对照下面的表格，对每个目标记录新旧版本的差异；同时把生成阶段终端日志中的 `quality check warnings for ...` 段落贴入「Warning 命中」列。

| 字段                       | 旧版本 (`<videoId-A>`) | 新版本 (`<videoId-A>`) | 旧版本 (`<videoId-B>`) | 新版本 (`<videoId-B>`) |
| -------------------------- | ---------------------- | ---------------------- | ---------------------- | ---------------------- |
| Article Hook 元素命中数    |                        |                        |                        |                        |
| Article 风险/边界小节      |                        |                        |                        |                        |
| Article 可执行资产类型     |                        |                        |                        |                        |
| Short list item 数         |                        |                        |                        |                        |
| Short 可执行要点           |                        |                        |                        |                        |
| Short 风险提醒             |                        |                        |                        |                        |
| Thread tweet 数            |                        |                        |                        |                        |
| Thread 首推是否独立成立    |                        |                        |                        |                        |
| Thread 可执行 / 风险 tweet |                        |                        |                        |                        |
| 视觉建议条数               |                        |                        |                        |                        |
| Warning 命中               |                        |                        |                        |                        |

后续不在本任务范围（已在 USAGE.md / 任务文档说明，不阻塞 v0.2 MVP）：

- 自动图表 / 模板卡渲染（visual-suggestions → 真实图片）。
- 发布时间策略与平台算法预测。
- 基于历史曝光、点赞、互动数据的自动 retry。
- 高质量 prompt 的 LLM-judge 二次评审（MVP 不引入二次 LLM 评分）。

完成后标记：

- [x] Task 7 complete
