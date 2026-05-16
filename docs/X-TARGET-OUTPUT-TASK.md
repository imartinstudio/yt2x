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
# <thread title>

1/ <强 hook，直接给冲突、反直觉或核心收益>

2/ <背景或上下文，但不复述视频>

3/ <第一个核心观点>

...

N/ <开放问题或明确判断，引导回复>
```

`x-short.md` 格式：

```md
<单条 X 短帖正文，直接可发布>
```

要求：

- 默认生成 1 条主短帖，不超过 X 普通单帖限制。
- 可以带 1 个来源链接，但不强制。
- 不使用编号，不写成串推。
- 适合测试选题、表达一个核心判断或抛出一个讨论点。

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

- [ ] Task 1: Core target types and parsing
- [ ] Task 2: X thread generation domain
- [ ] Task 3: X short generation domain
- [ ] Task 4: Node target generators
- [ ] Task 5: Article command targets
- [ ] Task 6: Pipeline targets
- [ ] Task 7: Publish generated targets
- [ ] Task 8: Documentation updates

### Task 1: Core target types and parsing

状态：未完成

范围：

- 定义内容生成目标：`x-longform`、`x-thread`、`x-short`、`all`。
- 实现逗号分隔 `--targets` 的解析和去重。
- 保持默认目标为 `x-longform`，确保不传 `--targets` 时行为不变。

验收：

- `all` 等价于 `x-longform,x-thread,x-short`。
- 重复目标只执行一次。
- 非法目标给出清晰错误。
- 有纯函数单测覆盖默认值、组合值、`all`、非法值。

完成后标记：

- [ ] Task 1 complete

### Task 2: X thread generation domain

状态：未完成

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
- prompt 要求 8-15 条串推，每条只讲一个信息点。

完成后标记：

- [ ] Task 2 complete

### Task 3: X short generation domain

状态：未完成

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

- [ ] Task 3 complete

### Task 4: Node target generators

状态：未完成

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

- [ ] Task 4 complete

### Task 5: Article command targets

状态：未完成

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
pnpm yt2x article --video-id <videoId> --targets x-longform,x-thread,x-short
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
- `--targets` 支持 `x-longform`、`x-thread`、`x-short`、`all` 和逗号分隔自由组合。
- `--targets all` 等价于 `x-longform,x-thread,x-short`。
- `--video-id` 继续使用现有安全校验。
- 不要求真实 YouTube URL 或真实视频 ID。

完成后标记：

- [ ] Task 5 complete

### Task 6: Pipeline targets

状态：未完成

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

- `--targets x-longform`：现有 article 行为。
- `--targets x-thread`：执行 notes 后生成 `x-thread.md` 和 `x-hooks.json`。
- `--targets x-short`：执行 notes 后生成 `x-short.md`。
- `--targets x-longform,x-thread,x-short`：执行 notes 后生成全部三类内容。
- `--targets all`：等价于 `x-longform,x-thread,x-short`。
- 默认值保持当前行为，避免破坏现有用户。

验收：

- 默认 pipeline 行为不变。
- 生成阶段使用复数 `--targets`，支持一个或多个输出目标。
- `--targets x-thread` 不生成 `article.md`，除非用户显式要求 `x-longform`。
- `--targets x-short` 不生成 `article.md` 或 `x-thread.md`，除非用户显式要求。
- `--targets x-longform` 仍走现有 article 阶段。
- publish 阶段后续使用单数 `--target`，一次只发布一种目标。

完成后标记：

- [ ] Task 6 complete

### Task 7: Publish generated targets

状态：未完成

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

- [ ] Task 7 complete

### Task 8: Documentation updates

状态：未完成

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

- [ ] Task 8 complete

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
