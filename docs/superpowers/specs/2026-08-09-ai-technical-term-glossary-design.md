# AI 专业术语库与统一保护设计

## 目标

建立一套由所有生成与翻译链路共享的专业术语保护能力，覆盖 AI、AI Coding、AI Agent 相关术语，并允许后续只修改中央术语库即可扩展已知术语。系统同时自动发现源材料中的未知技术术语，避免把当前列出的 `Prompt Engineering`、`Context Engineering`、`Graph Engineering`、`Knowledge Graph`、`Agent Graph` 变成新的有限白名单。

同一套规则必须作用于文章、平台长文、帖子、标题、摘要、介绍、标签、时间线、JSON 字段、字幕、语义双语字幕、配音稿、封面提示和插图提示。只负责格式化、烧录或混音的模块不重新翻译；它们消费已经通过术语校验的上游产物。

## 问题与根因

当前仓库存在三套互不完整的术语机制：

- `shared-rules.ts` 与 `technical-terms.ts` 保护普通内容产物，但已知中英映射主要是五个枚举项。
- `dub/glossary.ts` 保护配音和语义双语字幕中的产品名、人名及少量领域词，却不知道文章侧新增的 AI 术语。
- `srt-translator.ts`、语义字幕的压缩/重排提示、配音的多轮修复提示和平台视觉提示分别维护自己的通用文字规则，无法保证所有轮次使用相同术语上下文。

因此，提示词即使写了“保留技术术语”，模型仍可能把新术语翻译掉；生成后的确定性修复又只认识有限词表。任何后续重写、压缩或修复轮次还可能再次丢失已经保住的术语。

## 方案比较

### 方案一：只增强提示词

在每个 LLM prompt 中增加“所有技术术语保留英文”的规则。改动小、没有额外调用，但模型可能忽略规则，且每条链路仍会复制规则。它无法确定性恢复已被翻译的未知术语，也无法阻止后续压缩轮次再次丢词。

### 方案二：只维护中央术语库

所有链路共享一个机器可读词库，已收录术语可以稳定匹配、恢复和审计。这个方案确定性强、成本低，但有限词库天然无法覆盖尚未收录的新术语；纯英文转写中的小写新词也不一定能靠格式特征识别。

### 方案三：中央术语库 + 自动发现 + 统一术语守卫

采用方案三。中央术语库提供已知术语的标准写法和明确策略；确定性识别器捕获缩写、模型名、命令、API、代码标识、显式中英并列词等结构化候选；源级 LLM 发现补充无法仅靠格式判断的未知术语。统一术语守卫把三类结果合并成一个可缓存的术语档案，并负责提示、占位保护、恢复与校验。

该方案比方案一可靠，比方案二具备开放词汇能力。额外的术语发现按源材料缓存，而不是在每个输出或字幕 cue 上重复调用。

## 领域模型

### 术语条目

机器可读目录中的每个条目包含：

```ts
type TechnicalTermEntry = {
  canonical: string;
  aliases: readonly string[];
  categories: readonly ("ai" | "ai-coding" | "ai-agent" | "product" | "person" | "domain")[];
  policy: "preserve" | "fixed-zh" | "contextual-preserve";
  preferredZh?: string;
  forbiddenZh?: readonly string[];
};
```

规则语义：

- `preserve`：源材料命中标准写法或别名时，输出必须包含 `canonical`；长文可以附加中文解释，但不能只保留中文。
- `fixed-zh`：普通英文领域词允许翻译，但必须使用 `preferredZh`。现有配音词表中要求统一译法的派生词属于该策略。
- `contextual-preserve`：只有源材料把词用于技术概念时才保留。裸 `Graph` 使用该策略；`Knowledge Graph` 等完整术语使用 `preserve`。
- `forbiddenZh`：模型常见的错误替代词。仅当同一翻译单元的源文本命中对应术语时，才允许把这些错误译法恢复为标准写法，禁止脱离源材料全局替换。

匹配采用最长词优先。完整短语优先于内部单词，例如 `Knowledge Graph` 优先于裸 `Graph`；明确的技能名优先于内部普通派生词。已知别名大小写不敏感匹配，输出使用 `canonical`。未知发现项只能保留源文本中的实际拼写，不能凭空发明标准大小写。

### 初始目录

第一版至少包含以下 `preserve` 项，并为小写 ASR 形式提供别名：

- AI：`Artificial Intelligence`、`Large Language Model`、`Foundation Model`、`Embedding`、`Vector Database`、`Retrieval-Augmented Generation`、`RAG`。
- AI Coding：`AI Coding`、`Coding Agent`、`Code Generation`、`Prompt Engineering`、`Context Engineering`、`Model Context Protocol`、`MCP`、`Structured Output`。
- AI Agent：`AI Agent`、`Agentic Workflow`、`Tool Calling`、`Function Calling`、`Graph Engineering`、`Knowledge Graph`、`Agent Graph`。

现有 `Grill Me`、`Codex`、`Plan Mode`、`2PRD`、人名及固定中文译法迁入同一目录，避免文章、字幕和配音继续读取不同事实来源。`CONTEXT.md` 保留面向人的领域说明；机器可读目录是运行时唯一事实来源。

### 术语候选与术语档案

一个未知候选必须包含实际源文本片段、源偏移范围、发现方式和 `high | medium | low` 置信度。系统丢弃无法在源材料中逐字或大小写不敏感定位的候选，防止发现模型虚构术语。`high` 候选进入本次源材料的术语档案；`medium` 候选只进入审计 warning；`low` 候选丢弃。自动发现的结果只影响当前源材料，不会自动写回中央目录，因此一次误判不会污染其他视频或文章。

术语档案是一次源材料处理的可序列化结果：

```ts
type TechnicalTermProfile = {
  sourceFingerprint: string;
  entries: readonly ResolvedTechnicalTerm[];
  occurrences: readonly TechnicalTermOccurrence[];
  profileFingerprint: string;
};
```

档案合并三种来源：中央目录命中、确定性结构识别、经过源范围校验的 LLM 发现。目录条目覆盖发现项；更长、更具体的条目覆盖内部短词；冲突无法按这些规则消解时记录机器可读错误，不静默选择。

## 模块与接口

### Core：专业术语守卫

专业术语守卫是一个深模块，接口保持在三个入口以内：

```ts
const guard = createTechnicalTermGuard({ sourceText, sourceTitle, discoveredTerms });

const prepared = guard.prepare(value); // 保护后的输入、动态 prompt、恢复上下文和档案指纹
const result = guard.finalize(output, prepared.restoration); // 恢复术语并返回违规项
guard.validate(result.value); // 对不能安全自动修复的结果做只读校验
```

`prepare` 返回独立、不可变的恢复上下文，允许同一个 guard 并发处理多个字幕批次或平台目标，不能把占位符映射藏在可变全局状态中。实现隐藏目录匹配、别名归一化、候选合并、最长匹配、占位符、字符串/JSON 递归处理、Graph 上下文、错误译法恢复和指纹计算。调用方不再了解具体术语数组，也不再手写五个示例词。

动态 prompt 由“所有技术术语的一般规则”和“本次源材料实际激活的术语列表”组成，不把完整中央目录塞进每次请求。这样新增术语不要求修改 prompt 文件，同时避免无关词表增加 token、诱导模型凭空写入源材料没有的术语。

现有 `restoreProtectedTechnicalTermsInContent`、`restoreProtectedTechnicalTermsInValue` 和 dub glossary 导出在迁移期间作为兼容外观调用守卫，完成所有调用方迁移后再评估是否删除；不得在新调用方中继续扩展旧数组。

### Adapter：源级术语发现

源级发现复用现有 `LlmPort`，不新增远程能力接口。它读取完整源标题、文章、结构化笔记或转写文本，返回技术术语候选；适配层只执行调用与缓存，候选的源范围验证、去重和策略合并全部回到 Core 守卫完成。

发现调用满足以下约束：

- 同一源 SHA、发现提示版本和目录内容指纹只调用一次。
- 长转写允许分块发现后合并，但不按字幕 cue 重复调用。
- 源材料没有拉丁字母、数字缩写、命令或代码标识，且中央目录没有命中时，跳过 LLM 发现。
- 发现失败时记录 `technical-term-discovery-unavailable`，继续使用中央目录和确定性识别；不得阻止已有术语的保护。
- 自动发现只产生 `preserve` 候选，不得自动创建 `fixed-zh` 或 `forbiddenZh` 规则；这些有语义风险的规则只能人工维护。
- 生产环境的发现会增加一次源级 LLM 工作；缓存命中时不增加调用。实现和单元验证阶段不得调用真实 provider。

## 数据流

```text
源材料
  → 中央目录匹配 + 结构识别 + 源级术语发现
  → TechnicalTermProfile
  → 守卫 prepare：占位保护 + 动态 prompt 规则
  → LLM 生成 / 翻译 / 重写 / 压缩 / 修复
  → 守卫 finalize：恢复标准写法
  → 守卫 validate：缺失、错误译法、虚构术语检查
  → 目标产物或定向修复
```

每次 LLM 改写都必须复用同一术语档案。不能只保护初次翻译，随后让字幕压缩、语义切分、配音 tighten/expand、glossary repair、口语化修复或视觉提示生成绕过守卫。

字幕术语档案从完整源 SRT 构建，而不是逐 cue 构建。完整落在单个翻译单元内的术语使用占位符确定性恢复；跨 cue 的术语记录覆盖的连续 cue 范围，并在该范围拼接后的输出中校验必须出现一次。跨 cue 位置无法安全自动确定时执行一次范围级定向修复，不向每个 cue 机械重复术语。

## 链路接入范围

必须接入：

- 主文章、平台文章、结构化笔记、X thread、X short、video short、deconstruct 和 clip post。
- 普通 SRT 翻译的初次调用及所有补漏修复阶段。
- 语义双语字幕的完整句翻译、术语补漏、内容对齐切分、宽度压缩、CPS 压缩和最终序列化。
- 配音翻译的 initial、repair、tighten、expand、glossary repair、speakable repair 和最终 `DubTranslatedLine`。
- X、公众号、小红书和 B 站的封面提示、插图提示、图片名称与图内文字说明。

不接入：

- 纯 Markdown/HTML 排版、文件复制、SRT 合并、字幕烧录、TTS 合成、音频混音和视频编码。
- 不包含翻译或文案生成的 CLI 编排层。

这些模块不接入并不表示放弃校验：字幕烧录与配音混音前仍必须确认上游产物的术语门已通过，但它们不自行改变文本。

## `Graph` 的上下文规则

`Graph` 不能退化为全局“图”替换：

- 源翻译单元命中 `Graph` 技术术语或该单元已解析出 `contextual-preserve` 的裸 `Graph` 时，错误译法“图”可以恢复成 `Graph`。
- `Knowledge Graph`、`Agent Graph`、`Graph Engineering` 按完整术语优先恢复。
- “截图、图片、图表、流程图、封面图、配图、插图、地图、示意图”等图像词始终受保护，不参与裸 `Graph` 恢复。
- 源材料未出现或未发现 `Graph` 技术概念时，输出中的普通“图”不得被修改。

这保证“Graph 的基本词汇”“什么时候值得用 Graph”“构建你的第一个 Graph”能恢复，同时不会把“添加一张截图”改坏。

## 校验与失败语义

术语校验至少报告：

- `missing-canonical-term`：源材料命中保护术语，但输出缺少标准写法。
- `forbidden-translation`：对应源术语存在时，输出仍只保留禁止的中文错误译法。
- `unrestored-placeholder`：产物中残留内部占位符。
- `invented-canonical-term`：输出出现目录术语，但源材料和已批准发现项均不存在。
- `conflicting-term-policy`：同一源范围命中不可消解的策略冲突。

可安全定位的错误由 `finalize` 机械恢复。无法安全定位时只允许一次定向修复；修复结果必须再次经过同一守卫。

- 字幕、双语字幕和配音稿仍有术语硬错误时，翻译阶段失败，禁止进入烧录、TTS 或混音。
- 文章、帖子和视觉提示仍有术语硬错误时，仅对应目标失败，不写入或覆盖该目标的成功产物。
- 自动发现不可用本身是 warning；已知术语遗漏、占位符残留和策略冲突是 error。

## 缓存与产物

术语档案指纹由源 SHA、实际激活的目录条目、别名、策略、发现提示版本和已批准发现项的稳定序列化内容共同决定。任何相关变化都会让翻译缓存失效；不依赖人工记得递增一个孤立版本号。

现有 article run metadata、语义双语字幕 manifest 和 dub script 缓存键增加术语档案指纹。普通 SRT 翻译如果没有独立 manifest，由调用方把指纹纳入现有缓存判定。第一版不在 `files/downloads/` 新增独立术语 JSON；必要的档案或审计信息写入已有文章侧元数据和报告，保持下载目录契约不变。

## 维护规则

中央目录变更必须通过以下静态检查：

- `canonical` 唯一且非空；别名去重，不能与另一条目的标准写法产生未声明冲突。
- `fixed-zh` 必须有 `preferredZh`；`preserve` 不得配置会替换标准英文的固定中文。
- `forbiddenZh` 只能在对应源术语命中时使用，不能成为全局替换表。
- 新条目必须包含分类、至少一个正例和一个不应命中的反例。
- 目录内容指纹必须稳定，条目顺序变化不能造成无意义缓存失效。

运行中发现的未知候选不会自动写回仓库。它们进入 warning 或审计结果，经人工确认后再作为独立代码变更加入目录，避免模型把普通英文短语永久升级成专业术语。

## 测试设计

测试以守卫接口为主要测试面，不依赖内部正则或数组顺序。

### Core

- 已知术语的标准写法、大小写别名、最长匹配和固定译法。
- 未知结构化术语及经过源范围验证的发现候选。
- 源材料不存在时不凭空加入术语。
- `Graph` 技术概念恢复与截图、图片、图表、流程图等反例。
- 字符串、数组、嵌套 JSON、标题和标签使用相同结果。
- 占位符往返、冲突报告和稳定档案指纹。
- 目录 schema、重复别名和策略不变量。

### 翻译链路

- 普通 SRT：模型把新术语译成中文时最终恢复；repair prompt 复用相同档案；跨 cue 术语只恢复一次。
- 语义双语字幕：完整句翻译、内容切分和两次压缩都不能丢失术语；最终 zh/bilingual SRT 一致。
- 配音：initial、tighten、expand 或 speakable repair 任一轮丢词都被恢复或拒绝；最终配音稿保留标准术语。
- 文章与所有平台文本：title/body/tags/hooks/timeline/JSON 字段及视觉提示共享同一规则。
- 回归样例包含当前五个术语，并增加一个不在初始目录、由自动发现提供的新术语，证明系统不是只验证枚举项。

### 验证边界

实现阶段只运行单元测试、类型检查和格式检查，不调用真实 provider，不执行完整视频转写、字幕烧录、TTS、混音或视频编码。真实媒体验证需要单独授权，并使用临时目录或既有 article 产物边界。

## 完成标准

- 术语目录成为所有翻译和文案链路的唯一机器可读事实来源。
- 新增一个已知术语只修改中央目录及其条目测试，不修改各平台 prompt。
- 一个不在目录中的源技术术语可以通过自动发现进入档案，并在至少文章、普通 SRT 和配音三条代表链路中保持原文。
- 当前五个术语及裸 `Graph` 示例在所有相关产物中符合规则，普通图像词不受影响。
- 所有后续 LLM 重写轮次复用同一档案，最终交付前存在可机读术语校验结果。
- 术语目录或发现结果变化会使相关翻译缓存失效，不复用旧的错误产物。
