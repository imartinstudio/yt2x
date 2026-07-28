# Semantic bilingual subtitles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从只读的下载原始英文字幕生成文章目录专用的语义中英双语字幕，按 BaoCut 的两阶段对齐和交付质量门安全烧录。

**Architecture:** 新增独立的语义字幕投影模块：阶段一按完整中文句将连续源 cue 组装为稳定组；阶段二只对真实渲染测量为 `hard` 的稳定组重对齐。语义与逐 cue 回退都只写 `files/articles/<videoId>/video/`；下载目录绝不写回。烧录器仅消费文章侧、通过内容与展示质量门的 `full.bilingual.srt`。

**Tech Stack:** TypeScript、Zod、Vitest、现有 `LlmPort`、Node fs/crypto、Python Pillow、ffmpeg。

## Global Constraints

- `files/downloads/<videoId>/` 是只读源资产；语义路径及 `--no-subtitle-semantic` 逐 cue 回退均不得新建、修改或删除其中的字幕文件。
- 仅在 `--subtitle-bilingual srt|ass|burned|all` 时默认语义投影；`--no-subtitle-semantic` 选择文章侧逐 cue 投影。
- 文章侧固定产物是 `full.en.srt`、`full.zh.srt`、`full.bilingual.srt`；双语块中文第一行、英文第二行、时间完全相同。
- 不接入本地 ASR；输入继续使用已下载的原始字幕时间轴。
- 视觉基线：底部、80% 宽、译文在上、原文在下、两行间距 0、分开背景；仅渲染投影时将中文 `，。` 替换为空格。
- 720p 样式：两行 `Lexend Deca` 粗体、白色；译文 30px、黑色 8px 描边；原文 16px、行高 1.20、左对齐、无描边；两行均使用 `#404040` 阴影（100%、0.08、0.10、45°）。字体链为 `Lexend Deca → PingFang SC → Hiragino Sans GB → STHeiti`。
- 内容错误无覆盖、索引、时间、来源 SHA 或 LLM 格式错误时，记录 warning 并生成文章侧逐 cue 回退；`hard` 宽度、超过 32 视觉单元 × 2 行、或中文投影 CPS 超过 9 时保留语义资产但阻止 burned MP4。

---

## File Structure

- `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.ts` — 稳定语义组、LLM 两阶段请求、覆盖/时间/质量校验、文章侧 SRT 序列化与两层缓存指纹。
- `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts` — 纯逻辑、LLM 合约、回退和指纹测试。
- `packages/adapters-node/src/acquire/video-subtitles.ts` — 在双语分支选择语义投影或旧逐 cue 路径；只将新产物写到 article 目录。
- `packages/adapters-node/src/acquire/video-subtitles.test.ts` — 文章目录写入、下载目录不变、集成回退和重建测试。
- `packages/adapters-node/src/acquire/render-bilingual-subtitles.py` — 固化 BaoCut 风格、字体回退链、80% 宽度与只测量模式，复用同一字体度量给第二阶段。
- `packages/adapters-node/src/acquire/burn-bilingual-subtitles.ts` — 传递测量调用、读取实际字体结果，并只烧录文章侧通过质量门的双语 SRT。
- `packages/cli/src/args/pipeline.ts`、`packages/cli/src/args/commander-pipeline-flags.ts`、`packages/cli/src/commands/pipeline.ts`、`packages/cli/src/commands/subtitle.ts`、`packages/cli/src/orchestrator/native-*.ts`、`packages/adapters-node/src/acquire/{execute-native-acquire.ts,prepare-youtube-video.ts}` — `subtitleSemantic` 参数从 CLI 贯通到适配器。
- `docs/DATA-CONTRACTS.md`、`docs/USAGE.md` — 补充文章侧字幕资产、开关和回退语义。

## Task 1: 增加语义字幕开关并贯通调用链

**Files:**

- Modify: `packages/cli/src/args/pipeline.ts`
- Modify: `packages/cli/src/args/pipeline.test.ts`
- Modify: `packages/cli/src/args/commander-pipeline-flags.ts`
- Modify: `packages/cli/src/commands/pipeline.ts`
- Modify: `packages/cli/src/commands/subtitle.ts`
- Modify: `packages/cli/src/orchestrator/native-subtitle.ts`
- Modify: `packages/cli/src/orchestrator/native-acquire-from-pipeline-args.ts`
- Modify: `packages/adapters-node/src/acquire/execute-native-acquire.ts`
- Modify: `packages/adapters-node/src/acquire/prepare-youtube-video.ts`

**Interfaces:**

- Produces `subtitleSemantic: boolean`，默认 `true`，并只由双语路径消费。
- `RunSubtitlePipelineOptions` 新增 `subtitleSemantic?: boolean`。

- [ ] **Step 1: 写入参数解析失败测试**

在 `pipeline.test.ts` 增加：默认值为 `true`；`false` 可解析；非布尔 CLI 值被 Zod 拒绝。

```ts
const validFixture = {
  sources: { urls: [] },
  stages: {},
  deconstruct: undefined,
  acquire: {},
  article: {},
  publish: {},
  control: {},
  llm: {},
  flags: {},
};
expect(
  PipelineArgsSchema.parse({ ...validFixture, acquire: { subtitleBilingual: "burned" } }).acquire
    .subtitleSemantic,
).toBe(true);
expect(
  PipelineArgsSchema.parse({ ...validFixture, acquire: { subtitleSemantic: false } }).acquire
    .subtitleSemantic,
).toBe(false);
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm test packages/cli/src/args/pipeline.test.ts`

Expected: FAIL，因为 schema 尚未声明 `subtitleSemantic`。

- [ ] **Step 3: 最小化实现参数与透传**

在 `AcquireOptionsSchema` 添加 `subtitleSemantic: z.boolean().default(true)`；Commander 增加：

```ts
.option("--no-subtitle-semantic", "Disable semantic grouping for bilingual subtitles")
```

在 flags、pipeline 压缩器、native acquire、`PrepareYoutubeVideoOptions`、`RunSubtitlePipelineOptions` 中使用同名布尔字段；不要为单语路径改变默认翻译行为。

- [ ] **Step 4: 运行参数与调用链测试**

Run: `pnpm test packages/cli/src/args/pipeline.test.ts packages/cli/src/orchestrator/native-pipeline.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add packages/cli/src/args packages/cli/src/commands packages/cli/src/orchestrator packages/adapters-node/src/acquire/execute-native-acquire.ts packages/adapters-node/src/acquire/prepare-youtube-video.ts
git commit -m "Add semantic bilingual subtitle option" -m "Expose the default-on semantic subtitle switch through the CLI and native acquisition path.\n\nIncluded:\n\n- add a validated subtitleSemantic option\n- forward it to the subtitle pipeline\n- cover default and opt-out parsing"
```

## Task 2: 构建可验证的语义双语投影模块

**Files:**

- Create: `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.ts`
- Create: `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts`
- Modify: `packages/adapters-node/src/acquire/index.ts`

**Interfaces:**

- Consumes: 原始英文 SRT、`LlmPort`、模型名、布局测量结果。
- Produces:

```ts
export type SemanticSubtitleGroup = {
  groupId: string;
  sourceStartIndex: number;
  sourceEndIndex: number;
  sourceText: string;
  zhText: string;
};
export type SubtitleLayoutMeasurement = {
  groupId: string;
  zhWidth: number;
  fitWidth: number;
  lineCount: number;
  severity: "fit" | "aim" | "hard";
  resolvedFonts: { zh: string; en: string };
};
export type SemanticProjectionOptions = {
  sourceSrt: string;
  llm: LlmPort;
  model: string;
  measureLayout: (provisionalBilingualSrt: string) => Promise<SubtitleLayoutMeasurement[]>;
};
export class SemanticProjectionError extends Error {
  readonly code:
    | "invalid-json"
    | "invalid-contiguous-coverage"
    | "invalid-layout-measurement"
    | "invalid-second-pass"
    | "invalid-source-sha";
}
export type SemanticBilingualProjection = {
  enSrt: string;
  zhSrt: string;
  bilingualSrt: string;
  sourceSha256: string;
  groups: SemanticSubtitleGroup[];
  quality: SemanticBilingualQualityReport;
};
export type SemanticBilingualQualityIssue = {
  code:
    | "coverage"
    | "source-sha"
    | "timing"
    | "bilingual-timing"
    | "hard-layout"
    | "line-count"
    | "cps"
    | "unsafe-layout";
  groupId?: string;
  severity: "content" | "presentation";
  message: string;
};
export type SemanticBilingualQualityReport = {
  readyForBurn: boolean;
  issues: SemanticBilingualQualityIssue[];
};
export const evaluateSemanticBilingualDelivery: (input: {
  projection: SemanticBilingualProjection;
  measurements: SubtitleLayoutMeasurement[];
}) => SemanticBilingualQualityReport;
export const projectSemanticBilingualSubtitles: (
  opts: SemanticProjectionOptions,
) => Promise<SemanticBilingualProjection>;
```

- [ ] **Step 1: 写入阶段一的失败测试**

用 4 条连续英文 cue fixture，mock LLM 返回两组 `{ sourceStartIndex, sourceEndIndex, zhText }`。断言生成两条英文、中文与双语 SRT；第一条英文合并 cue 1–2、时间取 cue 1 开始和 cue 2 结束。

```ts
expect(parseSubtitleBlocks(result.bilingualSrt)).toEqual([
  expect.objectContaining({
    start: "00:00:00,000",
    end: "00:00:03,000",
    text: ["自然中文句", "First half second half"],
  }),
  expect.any(Object),
]);
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm test packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts`

Expected: FAIL，因为模块尚不存在。

- [ ] **Step 3: 实现阶段一 LLM 合约与覆盖校验**

让 LLM 返回严格 JSON 数组；提示词要求：完整自然中文、专有名词/代码/数字原样保留、每组仅连续索引范围、所有 cue 恰好一次。实现 `validateSemanticGroups`：首组从第一个 cue 开始，后续 `start === previous.end + 1`，最后一组覆盖最后一个 cue，且中文非空。实现者必须从已验证的原始 cue 计算 `groupId`（`sha256(sourceStartIndex:sourceEndIndex:sourceText)`）和 `sourceText`，不得信任 LLM 回传的英文或 ID。

```ts
const expectedStart = previous === undefined ? sourceCues[0]!.index : previous.sourceEndIndex + 1;
if (group.sourceStartIndex !== expectedStart || group.sourceEndIndex < group.sourceStartIndex) {
  throw new SemanticProjectionError("invalid-contiguous-coverage", details);
}
```

以每组首尾 cue 时间序列化三份 SRT；双语文本固定 `[zhText, sourceText]`。通过 `createHash("sha256")` 记录原始 SRT 指纹，并为阶段一缓存写入 `sourceSha256`、`translationRuleVersion`、`llmModel`。

- [ ] **Step 4: 增加无效输出测试并运行**

覆盖非连续索引、遗漏、重复、空中文、非 JSON、来源 SHA 变化；均断言抛出可机读 `SemanticProjectionError.code`。另断言同一源范围的 `groupId` 稳定、不同范围的 `groupId` 不同。

Run: `pnpm test packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add packages/adapters-node/src/acquire/semantic-bilingual-subtitles.ts packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts packages/adapters-node/src/acquire/index.ts
git commit -m "Project bilingual subtitles by semantic groups" -m "Create a validated LLM-backed projection from source cues to article-ready Chinese, English, and bilingual subtitles.\n\nIncluded:\n\n- validate contiguous one-time cue coverage\n- serialize shared bilingual timing\n- fingerprint source subtitles and test malformed responses"
```

## Task 3: 以 BaoCut fit/aim/hard 规则驱动第二阶段定向重对齐

**Files:**

- Modify: `packages/adapters-node/src/acquire/render-bilingual-subtitles.py`
- Modify: `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.ts`
- Modify: `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts`

**Interfaces:**

- `render-bilingual-subtitles.py --measure <input.srt> --output <metrics.json> --video-width W --video-height H` 返回每条 provisional cue 的 `zhWidth`、`fitWidth`、`lineCount`、`severity` 与实际解析的中英文字体。
- `projectSemanticBilingualSubtitles` 接收 `measureLayout(srt: string): Promise<SubtitleLayoutMeasurement[]>`，只将 `severity === "hard"` 的稳定 `groupId` 发送给阶段二。

- [ ] **Step 1: 写入超宽句测试**

mock 布局测量使第 1 组为 `hard`、第 2 组为 `fit`，mock 第二次 LLM 返回第 1 组的两条替代组。断言只发送第 1 组的 `groupId`，最终时间连续，未命中的第 2 组 SRT 块保持字节相同。

```ts
expect(secondPassPayload.groups.map((g) => g.groupId)).toEqual([firstGroup.groupId]);
expect(parseSubtitleBlocks(result.zhSrt)).toHaveLength(3);
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm test packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts`

Expected: FAIL，因为没有布局测量与阶段二实现。

- [ ] **Step 3: 在现有 Pillow 渲染器加入无 PNG 的测量模式**

将 `MAX_WIDTH_FRAC` 改为 `0.80`。增加 `--measure` 分支：复用 `_fit_zh_lines`、`wrap_text`、同一字体解析和视频尺寸，输出 JSON，不创建 cue PNG。720p 基准使用译文 30px、原文 16px；按视频高度同比缩放；按 `Lexend Deca → PingFang SC → Hiragino Sans GB → STHeiti` 解析字体。测量以一行舒适宽度分类 `fit`、接近目标的 `aim`、超过两行或安全区的 `hard`，并输出实际字体文件路径。

- [ ] **Step 4: 实现第二阶段重对齐**

阶段二提示只允许拆分指定 `hard` 组，禁止改写未命中的翻译。每个返回子组必须覆盖原组内连续 cue，并提供其父 `groupId`；按每个子组覆盖 cue 的原始时间窗序列化。只接受可映射到 cue 边界的自然源语义断点（句末、分号、冒号、破折号）；普通逗号、任意 cue 边界或少于 1 秒的展示片段均不可作为拆分点。若没有安全边界，保留原组，向质量报告写入 `unsafe-layout`，不伪造时间；二阶段格式/覆盖错误仍抛出 `SemanticProjectionError`，交由集成层进行文章侧逐 cue 回退。

- [ ] **Step 5: 运行测试**

Run: `pnpm test packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交本任务**

```bash
git add packages/adapters-node/src/acquire/render-bilingual-subtitles.py packages/adapters-node/src/acquire/semantic-bilingual-subtitles.ts packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts
git commit -m "Align hard-fit semantic subtitles" -m "Add BaoCut-style layout classification and targeted re-alignment for only hard-fit semantic groups.\n\nIncluded:\n\n- use the 80 percent visual width baseline\n- retain fit and aim groups byte-for-byte\n- preserve real source timing without inventing split windows"
```

## Task 4: 集成文章侧产物、两层缓存、质量门与逐 cue 回退

**Files:**

- Modify: `packages/adapters-node/src/acquire/video-subtitles.ts`
- Modify: `packages/adapters-node/src/acquire/video-subtitles.test.ts`
- Modify: `packages/adapters-node/src/acquire/burn-bilingual-subtitles.ts`
- Modify: `packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts`

**Interfaces:**

- Consumes `projectSemanticBilingualSubtitles` 和 article 输出根目录。
- Produces文章侧 `full.en.srt`、`full.zh.srt`、`full.bilingual.srt` 与 `full.bilingual.semantic.json` 指纹记录；只在质量门 ready 时输出 `full.bilingual-burned.mp4`。

- [ ] **Step 1: 写入文章目录与源目录不变的失败测试**

用临时 `downloads/<id>` 和 `articles/<id>` fixture。运行双语 semantic 模式后断言：

```ts
await expect(readFile(downloadSourceSrt)).resolves.toBe(originalSource);
await expect(readFile(articleVideoDir + "/full.en.srt")).resolves.toContain("merged English");
await expect(readFile(articleVideoDir + "/full.zh.srt")).resolves.toContain("自然中文句");
await expect(readFile(articleVideoDir + "/full.bilingual.srt")).resolves.toContain(
  "自然中文句\nmerged English",
);
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm test packages/adapters-node/src/acquire/video-subtitles.test.ts packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts`

Expected: FAIL，因为当前逻辑将 `full.zh.srt` 和中间双语资产写进下载目录。

- [ ] **Step 3: 在双语 semantic 分支改为文章侧写入**

当 `subtitleSemantic !== false` 且双语模式开启时，读取下载源 SRT，调用投影模块，原子写入 article `video/`；写入 `full.bilingual.semantic.json`：`kind: "semantic-bilingual"`、`version`、`sourceSha256`、`translationRuleVersion`、`llmModel`、`layoutRuleVersion`、`resolvedFonts`、`videoWidth`、`videoHeight`、`videoWidthFraction: 0.8` 与质量报告。烧录器的 `enSrtPath`、`zhSrtPath` 与 `srtPath` 都改指向文章目录对应文件。

`subtitleSemantic === false` 或捕获 `SemanticProjectionError` 时，调用新的文章侧 cue-aligned projector：它从下载目录读取原始英文 SRT、在 article `video/` 写入三份逐 cue SRT 和 `kind: "cue-aligned-fallback"` manifest，不得调用当前会写下载目录的 `prepareSourceSubtitle` / `mergeBilingualSrt` 写路径。回退 warning 必须带错误码，例如 `semantic bilingual fallback: invalid-contiguous-coverage`。

- [ ] **Step 4: 实现缓存失效并补充回退测试**

实现两个缓存层。阶段一仅当 `sourceSha256`、`translationRuleVersion` 与 `llmModel` 全等，且三个 article SRT SHA 与 manifest 一致时复用；阶段二/烧录仅当阶段一产物 SHA、`layoutRuleVersion`、`resolvedFonts`、视频尺寸、宽度比例与样式版本全等时复用。改变字体、尺寸或宽度时只重测量/重对齐/重烧录，不得重翻译。覆盖非法 LLM 输出的文章侧回退、`--no-subtitle-semantic`、字体回退变更、缓存有效时不调用 LLM，以及 `hard`/两行/CPS 质量阻断时不调用 `burnBilingualSubtitles`。

- [ ] **Step 5: 运行集成测试**

Run: `pnpm test packages/adapters-node/src/acquire/video-subtitles.test.ts packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交本任务**

```bash
git add packages/adapters-node/src/acquire/video-subtitles.ts packages/adapters-node/src/acquire/video-subtitles.test.ts packages/adapters-node/src/acquire/burn-bilingual-subtitles.ts packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts
git commit -m "Write semantic subtitles to article outputs" -m "Route semantic bilingual assets and burn inputs to the article directory while preserving an audited fallback path.\n\nIncluded:\n\n- keep downloaded subtitles immutable\n- cache article-side semantic projections\n- re-burn when source or rendering rules change"
```

## Task 5: 固化 BaoCut 样式、交付质量门与文档

**Files:**

- Modify: `packages/adapters-node/src/acquire/render-bilingual-subtitles.py`
- Modify: `packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts`
- Modify: `docs/DATA-CONTRACTS.md`
- Modify: `docs/USAGE.md`

**Interfaces:**

- 双语烧录固定使用 80% 宽度、底部布局、译文上原文下、两行间距 0、分开背景；渲染时才把中文 `，。` 转为空格。只有内容与展示质量门均 ready 时才烧录。

- [ ] **Step 1: 写入渲染规则测试**

为双语渲染命令构造包含 `，。` 的中文 fixture，断言测量/渲染输入保留原 SRT 文本、Python 输出布局度量 `fitWidth === floor(videoWidth * 0.8)`，并断言生成的画面文本清理结果不含中文逗号和句号。加入 720p fixture，断言译文 30px/黑色 8px 描边、原文 16px/行高 1.20/左对齐、阴影参数和字体链；模拟缺失 Lexend Deca，断言回退到 PingFang SC 且布局指纹变化。

```ts
expect(
  evaluateSemanticBilingualDelivery({ projection, measurements: [hardMeasurement] }),
).toMatchObject({
  readyForBurn: false,
  issues: [expect.objectContaining({ code: "hard-layout", severity: "presentation" })],
});
expect(
  evaluateSemanticBilingualDelivery({ projection, measurements: [fitMeasurement] }),
).toMatchObject({
  readyForBurn: true,
  issues: [],
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm test packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts`

Expected: FAIL，因为当前渲染宽度为 98%，且仍使用黄中文、旧字体与统一描边。

- [ ] **Step 3: 完成渲染规则与文档**

保留 `clean_subtitle_text` 仅在 Python 渲染内调用，不写回 SRT。实现 `evaluateSemanticBilingualDelivery()`：内容检查覆盖、来源 SHA、时间单调/无重叠、双语时间一致；展示检查 `hard`、两行、CPS 和安全布局。内容失败进入文章侧逐 cue 回退；展示失败写入 manifest、保留 SRT、但不烧录 MP4。更新 `DATA-CONTRACTS.md` 的文章目录 video 表、`kind`、两层缓存与质量报告；在 `USAGE.md` 写明 `--no-subtitle-semantic`、双语三份文章侧字幕、回退、质量门和下载源只读边界。示例视频 URL 与 videoId 均使用占位符。

- [ ] **Step 4: 运行定向测试与静态检查**

Run: `pnpm test packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts packages/adapters-node/src/acquire/video-subtitles.test.ts packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts && pnpm run typecheck && pnpm format:check && git diff --check`

Expected: 全部 PASS，且没有空白符错误。

- [ ] **Step 5: 提交本任务**

```bash
git add packages/adapters-node/src/acquire/render-bilingual-subtitles.py packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts docs/DATA-CONTRACTS.md docs/USAGE.md
git commit -m "Document semantic bilingual subtitle delivery" -m "Finalize BaoCut-inspired rendering defaults and document article-side semantic subtitle artifacts.\n\nIncluded:\n\n- keep punctuation cleanup render-only\n- document the semantic opt-out and fallback\n- verify subtitle rendering and repository checks"
```

## Plan Self-Review

- Spec coverage: Task 1 covers default-on opt-out; Tasks 2–3 cover BaoCut-like two-stage semantic grouping and 80% real layout measurement; Task 4 guarantees article-only outputs, immutable downloads, fallback and cache invalidation; Task 5 captures fixed visual rules and documentation.
- Placeholder scan: no implementation placeholders remain; `<videoId>` appears only in the global path contract, where it is intentionally a documented placeholder.
- Type consistency: all later tasks consume `SemanticSubtitleGroup`, `SemanticBilingualProjection`, `SemanticProjectionError`, `subtitleSemantic`, and `full.bilingual.semantic.json` defined in Tasks 1–2.
