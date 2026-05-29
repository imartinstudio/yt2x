# X target output task

版本归属：v0.2

## 背景

yt2x 当前主链路是：

```text
YouTube URL
  -> metadata / subtitles / transcript chunks
  -> structured notes
  -> X long-form article
  -> publish preview or real X post
```

这条链路已经适合生成长文，但 X 信息流传播更依赖首条停留、连续阅读、回复、转发、收藏和负反馈控制。把 `article.md` 机械切分成串推可以保证可发布，却不能保证串推本身有适合 X 的节奏。

本任务目标是增加“按发布目标生成内容”的能力，先用 `x-thread` 做最小闭环，并把 `x-short` 作为独立目标纳入同一套设计。

## 目标

新增 `x-thread` 和 `x-short` 目标输出，使 yt2x 可以从 `structured-notes.md` 直接生成专门面向 X 的信息流内容。

首个可交付版本只做：

```text
structured-notes.md + metadata.json
  -> x-thread.md
  -> x-short.md
  -> x-hooks.json
```

`x-thread` 用于完整展开一个视频观点，`x-short` 用于单条短帖测试选题或快速发布。二者都是独立目标，不互相派生。

暂不改变默认 publish 行为，避免一次改动过大。后续再让 publish 按单个目标使用 `article.md`、`x-thread.md` 或 `x-short.md`。

## 非目标

- 不复刻或模拟 X 推荐模型。
- 不引入真实 X 数据、用户画像或账号分析。
- 不自动发布真实内容。
- 不把长文、串推、短帖默认全部生成。
- 不提交下载产物、真实视频 ID、API key、OAuth token、cookies 或浏览器凭证。

## 设计原则

- `structured-notes.md` 是公共中间层，长文、串推和短帖都应从它生成。
- `x-thread.md` 不是 `article.md` 的切片，而是独立创作目标。
- `x-short.md` 不是 `x-thread.md` 的摘要，而是独立创作目标。
- 默认单次任务只生成一个目标输出，减少 LLM 成本和产物噪音。
- 内容优化参考 X 推荐目标：提高停留、点击、回复、转发、收藏概率，降低不感兴趣、静音、举报风险。
- prompt 必须继续强调忠实来源、不编造、不廉价标题党。

## 产物约定

输出目录：

```text
files/articles/<videoId>/
```

新增文件：

```text
x-thread.md
x-short.md
x-hooks.json
```

`x-thread.md` 格式：

```md
1/ <短观点标签：独立总述 hook，直接给强观点、强对立、强总结和阅读收益>

2/ <短观点标签：从这里开始输出第一个原文观点或知识点>

3/ <短观点标签：第二个真实观点或知识点>

...

N/ <短观点标签：开放问题、明确判断或读者收益，引导回复>
```

要求：

- `x-thread.md` 正文不写 Markdown 标题，直接从 `1/` 开始；JSON 里的 `title` 仅作内部元数据。
- 生成前先提炼 `core_thesis`、`conflict`、`key_points`、`reader_gain`、`final_post`，第一条参考 `x-short` 的判断式开头。
- 第一条是整条串推的独立总述，不承载原文第一个知识点；从第二条开始才逐条展开原文观点、步骤或验证方法。
- tweets 数量由视频中的真实观点或知识点决定，通常 6–8 条，不按 Markdown 段落粗暴拆分，最多 10 条。
- 每条 tweet 都必须使用「短观点标签：正文」格式，冒号前是 2–12 个字左右的总结，冒号后才展开正文。
- `key_points` 必须有 4–6 个有信息增量的内容要点，不能只是章节标题。

`x-short.md` 格式：

```md
<单条 X 短帖正文，直接可发布>
```

要求：

- 默认生成 1 条主短帖，不超过 X 普通单帖限制。
- 可以带 1 个来源链接，但不强制。
- 可以在单帖内部使用 1. 2. 3. 的内容总结清单，但不写成 `1/`、`2/` 串推。
- 至少包含一句话核心总结、明确痛点或冲突、4–6 个内容要点，以及读者收益或讨论点。

`x-hooks.json` 格式：

```json
{
  "hooks": [
    {
      "text": "<首推候选>",
      "angle": "<反直觉 | 实用收益 | 争议判断 | 趋势观察 | 技术洞察>",
      "risk": "low"
    }
  ]
}
```

## 开发步骤

本功能必须按任务拆分推进。每个任务完成后，需要在本节把任务总览和任务内完成标记从 `[ ]` 改为 `[x]`，将状态改为“已完成”，并确保该任务的验收标准已经满足。

任务总览：

- [x] Task 1: Core target types and parsing
- [x] Task 2: X thread generation domain
- [x] Task 3: X short generation domain
- [x] Task 4: Node target generators
- [x] Task 5: Article command targets
- [x] Task 6: Pipeline targets
- [x] Task 7: Publish generated targets
- [x] Task 8: Documentation updates
- [x] Task 9: Cross-platform article target and X post limits
- [x] Task 10: X thread-short publish target and cover media

### Task 1: Core target types and parsing

状态：已完成

范围：

- 定义内容生成目标：`article`、`x-thread`、`x-short`、`all`。
- 实现逗号分隔 `--targets` 的解析和去重。
- 保持默认目标为 `article`，确保不传 `--targets` 时行为不变。

验收：

- `all` 等价于 `article,x-thread,x-short`。
- 重复目标只执行一次。
- 非法目标给出清晰错误。
- 有纯函数单测覆盖默认值、组合值、`all`、非法值。

完成后标记：

- [x] Task 1 complete

### Task 2: X thread generation domain

状态：已完成

新增文件：

```text
packages/core/src/domain/thread/
  prompts.ts
  types.ts
  index.ts
```

职责：

- 定义 `ThreadPromptInput`、`ThreadPromptOptions`。
- 构造 `ARTICLE_X_SYSTEM_PROMPT` 之外的 thread 专用 prompt。
- prompt 输入包括精简后的 `metadata` 和 `structuredNotesMd`。
- prompt 输出必须明确要求同时生成 `x-thread.md` 和 `x-hooks.json` 所需内容，或者生成一个可解析 JSON，再由 adapter 落盘。

建议优先使用结构化 JSON 输出，adapter 再渲染 Markdown：

```ts
type GeneratedThread = {
  title: string;
  tweets: string[];
  hooks: Array<{
    text: string;
    angle: string;
    risk: "low" | "medium" | "high";
  }>;
};
```

验收：

- 有 prompt 构造单测。
- prompt 明确禁止编造、标题党、逐段复述。
- prompt 要求通常 6–8 条串推、最多 10 条，每条只讲一个信息点。

完成后标记：

- [x] Task 2 complete

### Task 3: X short generation domain

状态：已完成

新增文件：

```text
packages/core/src/domain/short/
  prompts.ts
  types.ts
  index.ts
```

职责：

- 定义 `ShortPromptInput`、`ShortPromptOptions`。
- 构造 short 专用 prompt。
- prompt 输入包括精简后的 `metadata` 和 `structuredNotesMd`。
- prompt 输出必须明确要求生成单条短帖正文，不能生成串推或长文。

建议优先使用结构化 JSON 输出，adapter 再渲染 Markdown：

```ts
type GeneratedShortPost = {
  text: string;
  angle: "contrarian" | "practical" | "trend" | "technical" | "discussion";
  risk: "low" | "medium" | "high";
};
```

验收：

- 有 prompt 构造单测。
- prompt 明确禁止编造、标题党、逐段复述。
- prompt 要求只表达一个核心判断或问题。
- prompt 要求不要输出编号，不要写成串推。

完成后标记：

- [x] Task 3 complete

### Task 4: Node target generators

状态：已完成

新增文件：

```text
packages/adapters-node/src/thread/
  generator.ts
  file-store.ts
  index.ts

packages/adapters-node/src/short/
  generator.ts
  file-store.ts
  index.ts
```

职责：

- 读取 `files/downloads/<videoId>/metadata.json`。
- 读取 `files/downloads/<videoId>/structured-notes.md`。
- 调用 `LlmPort` 生成 thread 结构。
- 写入 `files/articles/<videoId>/x-thread.md`。
- 写入 `files/articles/<videoId>/x-hooks.json`。
- 调用 `LlmPort` 生成 short post 结构。
- 写入 `files/articles/<videoId>/x-short.md`。
- 使用既有文件写入风格，避免半写入产物。

验收：

- 缺少 `structured-notes.md` 时给出清晰错误。
- LLM 返回非法 JSON 时给出清晰错误。
- 文件写入测试覆盖成功路径和失败路径。

完成后标记：

- [x] Task 4 complete

### Task 5: Article command targets

状态：已完成

新增或修改：

```text
packages/cli/src/commands/article.ts
packages/cli/src/index.ts
packages/cli/src/args/single-stage.ts
```

命令：

```bash
pnpm yt2x article --video-id <videoId>
pnpm yt2x article --video-id <videoId> --targets x-thread
pnpm yt2x article --video-id <videoId> --targets x-short
pnpm yt2x article --video-id <videoId> --targets article,x-thread,x-short
pnpm yt2x article --video-id <videoId> --targets all
```

可选参数：

```bash
--out-dir <path>
--articles-dir <path>
--llm-provider <provider>
--model <model>
--output-language <zh|en>
--targets <targets>
```

验收：

- 不传 `--targets` 时保持当前行为，只生成 `article.md`。
- `--targets` 支持 `article`、`x-thread`、`x-short`、`all` 和逗号分隔自由组合。
- `--targets all` 等价于 `article,x-thread,x-short`。
- `--video-id` 继续使用现有安全校验。
- 不要求真实 YouTube URL 或真实视频 ID。

完成后标记：

- [x] Task 5 complete

### Task 6: Pipeline targets

状态：已完成

新增目标输出参数：

```bash
pnpm yt2x pipeline \
  --urls "<YOUTUBE_URL>" \
  --acquire auto \
  --notes auto \
  --targets x-thread \
  --publish review
```

建议先实现最小兼容：

- `--targets article`：现有 article 行为。
- `--targets x-thread`：执行 notes 后生成 `x-thread.md` 和 `x-hooks.json`。
- `--targets x-short`：执行 notes 后生成 `x-short.md`。
- `--targets article,x-thread,x-short`：执行 notes 后生成全部三类内容。
- `--targets all`：等价于 `article,x-thread,x-short`。
- 默认值保持当前行为，避免破坏现有用户。

验收：

- 默认 pipeline 行为不变。
- 生成阶段使用复数 `--targets`，支持一个或多个输出目标。
- `--targets x-thread` 不生成 `article.md`，除非用户显式要求 `article`。
- `--targets x-short` 不生成 `article.md` 或 `x-thread.md`，除非用户显式要求。
- `--targets article` 仍走现有 article 阶段。
- publish 阶段后续使用单数 `--target`，一次只发布一种目标。

完成后标记：

- [x] Task 6 complete

### Task 7: Publish generated targets

状态：已完成

第二阶段再做，不放进首个 PR。

目标行为：

- `publish --thread-source generated` 使用 `x-thread.md`。
- `publish --thread-source article` 使用现有 `articleToThread(article.md)`。
- `publish --thread-source auto` 优先使用 `x-thread.md`，不存在时回退到 `article.md` 机械切分。
- `publish --target x-short` 使用 `x-short.md`。

验收：

- review / dry-run 永远不调用 X API。
- 预览 JSON 标明 thread 来源：

```json
{
  "mode": "thread",
  "source": "x-thread.md",
  "tweets": []
}
```

- 短帖预览 JSON 标明 short 来源：

```json
{
  "mode": "short",
  "source": "x-short.md",
  "text": ""
}
```

完成后标记：

- [x] Task 7 complete

### Task 8: Documentation updates

状态：已完成

范围：

- 更新 `README.md`。
- 更新 `docs/USAGE.md`。
- 更新 `docs/DATA-CONTRACTS.md`。
- 更新 `docs/ROADMAP.md`。

验收：

- 文档示例只使用 `<YOUTUBE_URL>` 和 `<videoId>` 占位符。
- 文档说明生成阶段使用 `--targets`，发布阶段使用 `--target`。
- 文档说明默认行为保持只生成 `article.md`。

完成后标记：

- [x] Task 8 complete

### Task 9: Cross-platform article target and X post limits

状态：已完成

背景：

当前实现把 `x-longform` 同时用于“生成长文章草稿”和“发布为 X long post”，语义不清。X 上的内容发布应区分为两大类：

- `article`：长文章草稿。当前 X 没有对外开放 Article 发布 API，因此暂不走 API 自动发布。
- `post`：可通过 X API 发布的 post 内容，其中 `x-thread` 是串推，`x-short` 是单篇 post。

目标语义：

```text
publish target
  article
    -> article.md
    -> 不调用 X API 自动发布

  x-thread
    -> x-thread.md
    -> 通过 X API 发布 reply thread

  x-short
    -> x-short.md
    -> 通过 X API 发布单篇 post
```

范围：

- 将生成目标中的 `x-longform` 改为跨平台命名 `article`。
- 发布目标改为 `article | x-thread | x-short | x-thread-short`。
- 保留必要的兼容迁移逻辑：旧的 `x-longform` 可作为输入别名解析为 `article`，但文档不再推荐。
- `article` 目标只生成 / 预览 `article.md`，真实发布阶段不得调用 X API。
- `x-short` 不设置固定字数上限，但必须精炼表达核心判断，不能把长文压缩成流水账。
- `x-thread` 单条默认上限改为 500 字符。
- `x-thread` 默认生成 / 发布最多 8 条，允许显式配置 1-10 条，超过 10 条报错。
- `x-thread` prompt 应表达“通常 6-8 条”，不能继续要求 8-15 或 6-15 条。
- `x-thread` 是主要观点总结，不是按原文段落截取；段落或观点超过 500 字符时必须压缩表达或与相邻观点合并，不能截断尾部或舍弃关键事实。
- `x-thread.md` 和 `x-short.md` 禁止生成 Markdown 表格；对比、参数、步骤或结构化信息必须在生成阶段改写成编号列表、要点列表或「字段：值」短行。
- `x-thread.md` 和 `x-short.md` 不再生成 Markdown 加粗、行内代码、代码块、有序列表、无序列表、Markdown 链接、引用或表格；冒号式标题必须在冒号后换行，数字/圈号/emoji 数字序号必须让序号单独占一行。
- `x-thread.md` 发布读取时必须以行首 `1/`、`2/`、`3/` 作为 tweet 边界，单条 tweet 内部的空行、列表、代码块不能被误切成多条回复。
- 发布前 Markdown 转换 hook 会把加粗中的英文 / 数字转为 X 可见的 Unicode bold；中文等没有通用 Unicode 粗体字形的字符保持原字形。
- `x-thread` 不得由程序补充「核心公式：」「读者收益：」「关键方法：」等模板化标题；如需小标题，只保留 LLM 基于内容提炼出的自然标题。
- `articleToThread(article.md)` 机械切分路径应降级为兼容路径，不作为默认推荐发布方式。
- `x-short` 和 `x-thread` 发布成功后，都必须在评论区追加一条来源回复：

```text
👇完整视频：
<YOUTUBE_URL>
```

其中 `<YOUTUBE_URL>` 只是文档占位符；实际发布和 dry-run 预览时必须替换为采集阶段保存的原视频地址。

- `x-thread-short` 发布时，`x-short.md` 作为首推，`x-thread.md` 全部作为回复依次发布，来源回复挂在最后一条成功回复后。
- `x-short` 和 `x-thread-short` 发布首推时应尽量附带 `images/cover.*` 封面图。
- 真实发布 `x-thread` / `x-thread-short` 时，每两条推文之间默认随机等待 20-30 秒，可通过发布参数配置。

建议实施顺序：

1. Core target schema
   - 把 `ARTICLE_OUTPUT_TARGETS` 从 `x-longform,x-thread,x-short` 调整为 `article,x-thread,x-short`。
   - `all` 展开为 `article,x-thread,x-short`。
   - `parseArticleOutputTargets` 接受旧值 `x-longform`，内部归一为 `article`，并去重。
   - 更新相关单测：默认值、`all`、别名、非法值。

2. Article generation orchestration
   - `executeNativeArticle` 中把长文章生成分支从 `x-longform` 改为 `article`。
   - `article.md`、`run.json` 文件名保持不变。
   - CLI 帮助和错误提示使用 `article,x-thread,x-short,all`。
   - `--targets x-longform` 继续可用，但只作为兼容别名。

3. X post limits
   - 移除 short post 固定字数上限，prompt 改为强调精炼核心。
   - 把 generated thread 每条默认发布上限调整为 500。
   - 把 thread 默认 `maxTweets` 调整为 8。
   - 对 `--max-tweets` 增加 1-10 校验，超过 10 直接报错。
   - 同步 core prompt：thread 通常 6-8 条、最多 10 条；short 不设固定上限但必须精炼核心。
   - 同步 core prompt：thread / short 禁止使用 Markdown 表格，结构化信息改用编号列表、要点列表或「字段：值」短行。
   - 同步生成解析和落盘测试：新产物使用纯文本结构，旧 Markdown 产物仅由发布转换层兼容。
   - 发布读取 `x-thread.md` 时按行首 `N/` 识别 tweet 边界，保留单条 tweet 内部空行。
   - 记录发布前 Markdown 转换策略：加粗英文 / 数字转 Unicode bold，中文保持原字形。
   - 移除 thread 程序兜底标题，清理「核心公式：」「读者收益：」等模板化前缀，只保留 LLM 内容提炼标题。
   - generated thread 发布预览不得静默截断超长 tweet；如果 `x-thread.md` 中单条超过上限，应报错并要求重新生成压缩 / 合并后的串推。

4. Publish target semantics
   - `publish --target article`：支持 dry-run / review 预览 `article.md`，写入 `publish-preview.json`，但真实 publish 明确报错并说明 X Article 当前无 API 自动发布。
   - `publish --target x-thread`：使用 `x-thread.md`，默认 `--thread-source generated` 或等价行为。
   - `publish --target x-short`：使用 `x-short.md`。
   - `x-thread` 成功发布主 thread 后，在最后一条成功 tweet 下追加包含原视频地址的“👇完整视频：”来源回复。
   - `x-short` 成功发布主 post 后，在该 post 下追加包含原视频地址的“👇完整视频：”来源回复。
   - 来源回复使用采集阶段保存的 YouTube 原视频地址；dry-run / review 预览中必须显示替换后的真实来源 URL。
   - 旧 `--thread` 保留为兼容开关，但文档推荐 `--target x-thread`。
   - 旧 `--target x-longform` 如需兼容，应归一到 `article`，不能再静默发 long post。

5. Data contracts and docs
   - 更新 `README.md`、`docs/USAGE.md`、`docs/DATA-CONTRACTS.md`、`docs/ROADMAP.md`。
   - 文档示例统一使用占位符 `<YOUTUBE_URL>`、`<videoId>`。
   - 明确说明 `article` 当前是草稿 / 预览目标，不通过 X API 自动发布。
   - 明确说明 X API 自动发布覆盖 `x-thread`、`x-short` 和 `x-thread-short`。

验收：

- `article --targets article` 生成 `article.md`。
- `article --targets x-longform` 仍能生成 `article.md`，但内部归一为 `article`。
- `article --targets all` 等价于 `article,x-thread,x-short`。
- `publish --target article --dry-run` 写入 `publish-preview.json`，不调用 X API。
- `publish --target article` 在非 dry-run 下返回清晰错误，不调用 X API。
- `publish --target x-thread --dry-run` 默认最多 8 条，每条不超过 500 字符。
- `publish --target x-thread --max-tweets 11` 报错。
- `publish --target x-thread --dry-run` 遇到超过 500 字符的 generated tweet 时直接报错，不截断尾部、不丢弃内容。
- `publish --target x-short --dry-run` 不按 `--publish-max-chars` 截断内容，但生成 prompt 必须要求精炼核心。
- `publish --target x-thread --dry-run` 的预览包含来源回复，格式为 `👇完整视频：\n<原视频地址>`。
- `publish --target x-short --dry-run` 的预览包含来源回复，格式为 `👇完整视频：\n<原视频地址>`。
- 真实发布 `x-thread` 时，来源回复挂在最后一条成功 tweet 下。
- 真实发布 `x-short` 时，来源回复挂在主 post 下。
- `pnpm run check` 和相关单测通过。

完成后标记：

- [x] Task 9 complete

### Task 10: X thread-short publish target and cover media

状态：已完成

范围：

- 新增 `publish --target x-thread-short`。
- 读取 `x-short.md` 作为首推，读取 `x-thread.md` 作为后续回复，按顺序发布。
- `x-thread-short` dry-run 写入 `mode: "thread-short"`、`text`、`replies`、完整 `tweets` 和 `sourceReply`。
- `x-thread-short` 真实发布时复用 thread 发布链路，来源回复挂在最后一条成功 tweet 下。
- `x-short` 与 `x-thread-short` 发布首推时查找 `images/cover.*` 或根目录 `cover.*`，有 `media.write` 时上传并附在首推。
- thread 发布链路支持每两条推文之间随机等待，默认 20-30 秒，可通过 `--thread-delay <seconds|range>` 配置，覆盖 `x-thread` 和 `x-thread-short`。
- CLI 帮助和文档补充 `x-thread-short` 语义。

验收：

- `publish --target x-thread-short --dry-run` 使用 `x-short.md + x-thread.md`，首推为 short，回复为 thread。
- `publish --target x-thread-short --dry-run` 的预览包含来源回复，格式为 `👇完整视频：\n<原视频地址>`。
- `publish --target x-short --dry-run` 能发现 `images/cover.*` 并写入 `coverPath`。
- 真实发布 `x-short` 时，封面图挂在主 post 上。
- 真实发布 `x-thread-short` 时，封面图挂在 short 首推上。
- 真实发布 `x-thread` / `x-thread-short` 时，后续回复发布前会按 `--thread-delay` 配置等待；未配置时使用 20-30 秒。

完成后标记：

- [x] Task 10 complete

## 测试要求

首个 PR 至少包含：

- core prompt 构造测试。
- thread Markdown 渲染测试。
- short Markdown 渲染测试。
- hooks JSON 写入测试。
- CLI 参数解析或命令投影测试。
- pipeline 默认行为不变的回归测试。

不要求真实 LLM、真实 YouTube 或真实 X API 调用。需要用 fake `LlmPort` 和临时目录测试。

## 文档要求

更新：

- `README.md`：增加 `article --targets` 和 `pipeline --targets` 示例。
- `docs/USAGE.md`：补充产物说明和参数说明。
- `docs/DATA-CONTRACTS.md`：记录 `x-thread.md`、`x-short.md`、`x-hooks.json` 文件约定。
- `docs/ROADMAP.md`：把 `x-thread` / `x-short` 标记为当前候选开发方向或已完成项。

文档示例必须使用占位符：

```text
<YOUTUBE_URL>
<videoId>
```

## 建议 PR 拆分

1. `feature/x-thread-generation`
   - core thread prompt
   - adapters-node generator
   - `article --targets x-thread`
   - 基础文档和测试

2. `feature/x-short-generation`
   - core short prompt
   - adapters-node generator
   - `article --targets x-short`
   - 基础文档和测试

3. `feature/pipeline-target-output`
   - `pipeline --targets x-thread`
   - `pipeline --targets x-short`
   - `pipeline --targets all`
   - 默认行为回归测试

4. `feature/publish-generated-targets`
   - publish 使用 `x-thread.md`
   - publish 使用 `x-short.md`
   - dry-run / review 安全测试

## 完成定义

首个可交付版本完成时，应能运行：

```bash
pnpm yt2x acquire --urls "<YOUTUBE_URL>"
pnpm yt2x notes --video-id <videoId>
pnpm yt2x article --video-id <videoId> --targets all
```

并在文章目录得到：

```text
x-thread.md
x-short.md
x-hooks.json
```

同时 `pnpm run check` 和相关单测通过。
