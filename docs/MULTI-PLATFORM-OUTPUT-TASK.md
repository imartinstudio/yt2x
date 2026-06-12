# Multi-platform output task

版本归属：v0.3 draft

## 背景

yt2x 当前 `article` 阶段已经能生成 X 平台相关产物：

```text
article.md
x-thread.md
x-hooks.json
x-short.md
x-video-short.md
```

这些产物都面向 X 的长文、串推、短帖或短视频脚本文案。下一步需要从同一篇主稿继续适配到更多中文内容平台：

- 小红书
- 微信公众号
- 哔哩哔哩

本任务先定义生成规格和数据结构，不在第一阶段接入新的 LLM 生成器，也不改变现有 X 输出命名和默认行为。

## 已确认决策

除特别标注外，全部采用默认选项：

- 保留现有 X 输出，不重命名 `article.md`、`x-thread.md`、`x-short.md`、`x-video-short.md`。
- `article.md` 继续作为长文主稿，新平台从主稿适配。
- 所有平台只基于原视频 / 主 `article.md`，不新增事实。
- 允许改变表达方式，但不改变观点和结论。
- 输出文件采用 `<platform>-article.md`、`<platform>-metadata.json` 这类清晰命名。
- 第一阶段先做生成规格和数据结构设计，再实现。
- 小红书语气选择：种草型、强情绪、强钩子。
- 小红书标签选择：3-5 个核心标签。
- 哔哩哔哩标题选择：强标题党 / 高冲突，但仍需忠实来源。

## 非目标

- 不删除或重命名现有 X 产物。
- 不把 `--targets all` 立即扩展到新平台，避免默认 LLM 成本和产物噪音突增。
- 不自动发布到小红书、微信公众号或哔哩哔哩。
- 不引入联网补充事实。
- 不提交真实视频 ID、下载产物、cookies、OAuth token 或 API key。

## 平台规格

权威类型定义：`packages/core/src/domain/article/platforms.ts`。

### 小红书

目标：`xiaohongshu`

输入：

```text
article.md + metadata.json + 可选 images/cover.*
```

输出：

```text
xiaohongshu-article.md
xiaohongshu-metadata.json
```

内容要求：

- 图文笔记文案 + 封面/配图建议。
- 语气偏种草型、强情绪、强钩子，同时保持信息密度。
- 生成 1 个统一主标题，不给备选标题。
- 生成 3-5 个核心标签。
- 不改变原文观点和结论，不新增事实。

### 微信公众号

目标：`wechat`

输入：

```text
article.md + metadata.json + 可选 images/cover.*
```

输出：

```text
wechat-article.md
wechat-metadata.json
```

内容要求：

- 完整 Markdown 长文，适合直接排版发布。
- 主标题 + 3 个备选标题。
- 摘要和开头导语。
- 封面图提示词 / 设计说明。
- 不改变原文观点和结论，不新增事实。

### 哔哩哔哩

目标：`bilibili`

输入：

```text
article.md + metadata.json + 可选 timestamped-cues.md
```

输出：

```text
bilibili-article.md
bilibili-metadata.json
```

内容要求：

- 视频标题 + 简介 + 分区/标签建议。
- 标题默认采用强冲突、高点击风格，但不得虚构内容。
- 生成 8-10 个标签。
- 从文章结构生成章节时间线草案；后续如果有字幕时间戳，可再对齐精确时间。
- 不改变原文观点和结论，不新增事实。

## 建议数据结构

```ts
type PlatformArticleTarget = "xiaohongshu" | "wechat" | "bilibili";

type PlatformArticleSpec = {
  target: PlatformArticleTarget;
  displayName: string;
  source: "article";
  sourcePolicy: "source-only";
  adaptationMode: "preserve-claims";
  outputs: Array<{
    path: string;
    description: string;
  }>;
  titleOptions: number;
  tags: {
    enabled: boolean;
    min: number;
    max: number;
  };
  coverSuggestion: boolean;
  timelineSuggestion: boolean;
  tone: string;
  format: string;
};
```

## 后续实现步骤

任务总览：

- [x] Task 1: Platform specs and data contract
- [x] Task 2: Platform target parsing
- [x] Task 3: Platform prompt builders
- [x] Task 4: Node platform generators and file stores
- [x] Task 5: Article command wiring
- [x] Task 6: Pipeline wiring
- [x] Task 7: Documentation and examples

### Task 1: Platform specs and data contract

状态：已完成

范围：

- 新增 `PlatformArticleTarget` 和 `PlatformArticleSpec`。
- 固化小红书、微信公众号、哔哩哔哩的默认规格。
- 文档化磁盘产物命名。

验收：

- 有单测覆盖已确认的非默认选项。
- 不改变现有 `ARTICLE_OUTPUT_TARGETS`。
- 不改变现有 `--targets all` 行为。

### Task 2: Platform target parsing

状态：已完成

范围：

- 新增独立参数 `--platform-targets xiaohongshu,wechat,bilibili`。
- 新增 `all-platforms`，避免与现有 `--targets all` 混淆。
- 默认不生成新平台产物。
- `yt2x article` 和 `yt2x pipeline` 都能解析并校验平台目标。
- 第一阶段如传入平台目标，会清晰提示生成尚未接线，避免静默成功但没有产物。

验收：

- `undefined` / 空字符串解析为空数组。
- `all-platforms` 等价于 `xiaohongshu,wechat,bilibili`。
- 重复平台目标会去重并保留顺序。
- 非法平台目标给出清晰错误。
- 有 core、pipeline args、commander flags、single-stage projection 单测覆盖。

### Task 3: Platform prompt builders

状态：已完成

范围：

- 新增 `packages/core/src/domain/article/platform-prompts.ts`。
- prompt 输入使用 `article.md`、精简 metadata 和可选 `timestamped-cues.md`。
- prompt 必须强调：只基于来源，不新增事实，不改变观点和结论。
- 每个平台输出结构化 JSON，后续由 adapter 渲染 Markdown。
- 小红书、微信公众号、哔哩哔哩各有独立 system prompt。

验收：

- 小红书 prompt 覆盖强钩子语气、统一主标题、3-5 个核心标签和封面/配图建议。
- 微信公众号 prompt 覆盖完整 Markdown 长文、主标题 + 3 个备选、摘要/导语和封面建议。
- 哔哩哔哩 prompt 覆盖强冲突标题、简介、分区、8-10 个标签和章节时间线草案。
- 单测验证 prompt 不包含重型 metadata，并保留 source-only / preserve-claims 约束。

### Task 4: Node platform generators and file stores

状态：已完成

范围：

- 新增 `packages/adapters-node/src/platform-article/`。
- 调用 LLM 时按平台选择 system prompt，输入 `article.md`、metadata 和可选时间轴。
- 解析结构化 JSON，按平台渲染 Markdown。
- 写入 `<platform>-article.md` 和 `<platform>-metadata.json`。

验收：

- 有 generator 单测覆盖 prompt 调用、JSON fence、target mismatch 和非法 JSON。
- 有 file-store 单测覆盖 Markdown 渲染、metadata 落盘和 overwrite 保护。

### Task 5: Article command wiring

状态：已完成

范围：

```bash
pnpm yt2x article --video-id <videoId> --platform-targets xiaohongshu,wechat,bilibili
```

- 保持 `--targets` 只控制 X/主稿目标。
- `--platform-targets` 从 `article.md` 适配生成平台稿。
- 如果本次没有包含 `--targets article`，则读取文章目录中已有的 `article.md`。

### Task 6: Pipeline wiring

状态：已完成

范围：

- pipeline article 阶段透传 `platformTargets`。
- 默认 `pipeline --targets all` 仍只生成现有主稿和 X 目标。
- pipeline 可使用 `--platform-targets all-platforms` 生成多平台适配。

### Task 7: Documentation and examples

状态：已完成

示例必须使用占位符：

```bash
pnpm yt2x pipeline --urls "<YOUTUBE_URL>" --platform-targets xiaohongshu,wechat,bilibili
pnpm yt2x article --video-id <videoId> --platform-targets all-platforms
```
