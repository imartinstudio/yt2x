# Strict semantic subtitle pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让语义双语流程成为唯一双语字幕产出与烧录入口，严格禁止旧逐 cue 路径烧录或向下载目录写入二创字幕。

**Architecture:** 双语模式先从下载目录只读解析已有源语言字幕，再在文章目录完成翻译、语义分组、定向重对齐、质量检查和烧录。集成层以机器可读 manifest 作为烧录能力凭证；任何阶段失败都非零退出，不调用旧翻译/合并/烧录分支。

**Tech Stack:** TypeScript、Vitest、现有 `LlmPort`、Node fs/crypto、Python Pillow、ffmpeg。

## Global Constraints

- `files/downloads/<videoId>/` 对双语流程严格只读；运行前后的文件清单和全部文件 SHA 必须一致。
- 双语模式不得调用会写下载目录的 `prepareSourceSubtitle`，不得在下载目录创建 `full.*.srt`、ASS、manifest、烧录 MP4 或转写临时文件。
- 双语模式只接受已下载的原始源语言 SRT/VTT；没有源字幕时失败，不接入本地 ASR。
- 翻译、对齐、断句、布局质量门必须全部完成，才能生成或复用烧录 MP4。
- 不存在 `cue-aligned-fallback`；LLM、覆盖、边界、时间轴或布局失败都不能退回旧逐 cue 烧录。
- 长句只能在可证明安全的原始 cue 边界拆分；没有安全边界时标记失败并阻止烧录，不伪造时间窗。
- 所有二创字幕、ASS、审计 manifest 和烧录视频只写 `files/articles/<videoId>/video/`。

---

## File Structure

- `packages/adapters-node/src/acquire/video-subtitles.ts`：只读源字幕解析、严格语义流程编排、文章侧原子写入和失败传播。
- `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.ts`：语义分组、边界校验、阶段状态和质量报告。
- `packages/adapters-node/src/acquire/burn-bilingual-subtitles.ts`：消费已验证的文章侧字幕；不负责决定回退。
- `packages/adapters-node/src/acquire/video-subtitles.test.ts`：真实 `auto`、缺源、目录不变和旧路径不可达的集成回归。
- `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts`：安全边界、长 cue 阻断和阶段完成状态测试。
- `packages/cli/src/args/pipeline.ts`、`packages/cli/src/commands/{pipeline,subtitle,acquire}.ts`：删除双语语义 opt-out。
- `docs/DATA-CONTRACTS.md`、`docs/USAGE.md`：记录唯一语义路径、严格失败和只读目录契约。

### Task 1: 锁死双语 CLI 与烧录前置条件

**Files:**
- Modify: `packages/cli/src/args/pipeline.ts`
- Modify: `packages/cli/src/args/pipeline.test.ts`
- Modify: `packages/cli/src/commands/pipeline.ts`
- Modify: `packages/cli/src/commands/subtitle.ts`
- Modify: `packages/cli/src/commands/acquire.ts`
- Modify: `packages/cli/src/args/commander-pipeline-flags.ts`
- Modify: `packages/cli/src/commands/command-flags.ts`
- Modify: `packages/cli/src/commands/single-stage-projection.ts`
- Modify: `packages/cli/src/orchestrator/native-acquire-from-pipeline-args.ts`
- Modify: `packages/cli/src/orchestrator/native-subtitle.ts`
- Modify: `packages/adapters-node/src/acquire/execute-native-acquire.ts`
- Modify: `packages/adapters-node/src/acquire/prepare-youtube-video.ts`

**Interfaces:**
- Consumes: `subtitleBilingual: "off" | "srt" | "ass" | "burned" | "all"`.
- Produces: 双语非 `off` 时无可关闭语义处理的参数；适配器不再接收 `subtitleSemantic`.

- [ ] **Step 1: 写入失败测试**

删除默认值和 opt-out 断言，新增 Commander 参数测试，确保 `--no-subtitle-semantic` 被拒绝；schema 不再产生 `subtitleSemantic`。

```ts
expect(parsed.acquire).not.toHaveProperty("subtitleSemantic");
expect(() => program.parse(["node", "yt2x", "pipeline", "--no-subtitle-semantic"]))
  .toThrow(/unknown option/u);
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm test packages/cli/src/args/pipeline.test.ts packages/cli/src/args/commander-pipeline-flags.test.ts packages/cli/src/commands/single-stage-projection.test.ts`

Expected: FAIL，因为字段和 CLI 选项仍然存在。

- [ ] **Step 3: 最小实现**

删除 `subtitleSemantic` schema、flags、Commander 选项和全链路透传。双语路径内部固定调用严格语义流程，不提供兼容性布尔开关。

- [ ] **Step 4: 运行定向测试**

Run: `pnpm test packages/cli/src/args/pipeline.test.ts packages/cli/src/args/commander-pipeline-flags.test.ts packages/cli/src/commands/single-stage-projection.test.ts packages/cli/src/orchestrator/native-pipeline.test.ts`

Expected: PASS。

### Task 2: 让下载目录成为真正只读的双语源

**Files:**
- Modify: `packages/adapters-node/src/acquire/video-subtitles.ts`
- Modify: `packages/adapters-node/src/acquire/video-subtitles.test.ts`

**Interfaces:**
- Produces: `resolveReadOnlyBilingualSource(videoDir, sourceLang, explicitFile?)`，只读取已有 SRT/VTT 并返回内存中的标准 SRT；不复制、不清理回写、不转写。
- Consumes: `runArticleBilingualPipeline` 直接使用上述内存源。

- [ ] **Step 1: 写入真实组合的失败测试**

建立 `downloads/<id>` 与 `articles/<id>` fixture，记录下载目录递归文件名和 SHA。分别覆盖：

```ts
// auto 没有 en 字幕：失败，下载目录不变，LLM 与 burner 均未调用
await expect(runSubtitlePipeline(options)).rejects.toThrow(/source subtitle.*required/u);
expect(await snapshotTree(downloadDir)).toEqual(before);
expect(llm.chat).not.toHaveBeenCalled();

// auto 已有 title.en.vtt：成功，只在 article/video 写 semantic 产物
expect(await snapshotTree(downloadDir)).toEqual(before);
await expect(readFile(articleVideoDir + "/full.bilingual.semantic.json", "utf8"))
  .resolves.toContain('"status": "ready"');
```

另增加 spy，断言双语模式从不调用 `prepareSourceSubtitle` 对应的本地转写 runner 命令。

- [ ] **Step 2: 运行测试验证 RED**

Run: `pnpm test packages/adapters-node/src/acquire/video-subtitles.test.ts`

Expected: FAIL；当前组合会转写并写入下载目录，或退入旧路径。

- [ ] **Step 3: 重排并收窄控制流**

在 `runSubtitlePipeline` 顶部判断双语模式：

```ts
if (bilingualMode !== "off") {
  return runStrictArticleBilingualPipeline(opts);
}
return runLegacySingleLanguagePipeline(opts);
```

严格双语函数必须先只读解析源字幕；缺源直接抛出机器可识别错误。旧 `prepareSourceSubtitle`、`translateSrt`、`mergeBilingualSrt` 和下载侧 burn 仅保留给非双语单语路径，双语控制流无法到达。

- [ ] **Step 4: 运行测试验证 GREEN**

Run: `pnpm test packages/adapters-node/src/acquire/video-subtitles.test.ts`

Expected: PASS。

### Task 3: 删除逐 cue 回退并建立不可伪造的烧录凭证

**Files:**
- Modify: `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.ts`
- Modify: `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts`
- Modify: `packages/adapters-node/src/acquire/video-subtitles.ts`
- Modify: `packages/adapters-node/src/acquire/video-subtitles.test.ts`

**Interfaces:**
- Produces manifest:

```ts
type SemanticDeliveryManifest = {
  kind: "semantic-bilingual";
  status: "ready" | "failed";
  stages: {
    translation: "done" | "failed";
    alignment: "done" | "failed";
    segmentation: "done" | "failed";
    layout: "done" | "failed";
  };
  files?: Record<"en" | "zh" | "bilingual", { sha256: string }>;
  quality: SemanticBilingualQualityReport;
  error?: { code: string; message: string };
};
```

- Consumes: 烧录分支只接受 `kind === "semantic-bilingual"`、`status === "ready"`、四阶段均 `done`、`quality.readyForBurn === true` 且三份文件 SHA 匹配。

- [ ] **Step 1: 写入失败测试**

覆盖非法 JSON、遗漏 cue、重叠范围、长句无安全边界、布局 hard、伪造 ready manifest、文件 SHA 不匹配。每个用例都断言：

```ts
expect(burnBilingualSubtitles).not.toHaveBeenCalled();
await expect(access(burnedPath)).rejects.toThrow();
await expect(readFile(failureManifest, "utf8")).resolves.toContain('"status": "failed"');
```

- [ ] **Step 2: 运行测试验证 RED**

Run: `pnpm test packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts packages/adapters-node/src/acquire/video-subtitles.test.ts`

Expected: FAIL，因为当前捕获 `SemanticProjectionError` 后生成 `cue-aligned-fallback`。

- [ ] **Step 3: 删除回退并实现阶段门**

删除 `createCueAlignedProjection` 和 `cue-aligned-fallback`。捕获语义错误时原子写入文章侧 failed manifest 后重新抛出。成功投影补齐四阶段状态；烧录前重新读取 manifest 和文件并校验状态与 SHA。任何不一致都写失败原因并拒绝烧录。

- [ ] **Step 4: 运行测试验证 GREEN**

Run: `pnpm test packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts packages/adapters-node/src/acquire/video-subtitles.test.ts packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts`

Expected: PASS。

### Task 4: 文档、全链路回归和仓库验证

**Files:**
- Modify: `docs/DATA-CONTRACTS.md`
- Modify: `docs/USAGE.md`
- Modify: `docs/superpowers/specs/2026-07-28-semantic-bilingual-subtitles-design.md`

**Interfaces:**
- Documents: 唯一语义路径、无 opt-out、无逐 cue 回退、Downloads 严格只读、失败不烧录。

- [ ] **Step 1: 更新契约文档**

删除 `--no-subtitle-semantic` 和 `cue-aligned-fallback` 描述；示例仅使用 `<YOUTUBE_URL>` 和 `<videoId>`。明确 `burned/all` 的非零失败条件与文章侧 failed manifest。

- [ ] **Step 2: 运行全部相关验证**

Run:

```bash
pnpm test packages/cli/src/args packages/cli/src/commands/single-stage-projection.test.ts packages/cli/src/orchestrator/native-pipeline.test.ts packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts packages/adapters-node/src/acquire/video-subtitles.test.ts packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts
pnpm run typecheck
pnpm format:check
git diff --check
```

Expected: 全部 PASS。

- [ ] **Step 3: 检查边界**

使用临时 fixture 重新运行成功和失败组合，断言 Downloads 递归快照完全相同；搜索生产代码确认双语严格函数不引用 `prepareSourceSubtitle`、`mergeBilingualSrt` 或下载侧 `full.*` 写路径。

## Plan Self-Review

- Spec coverage: Task 1 删除语义 opt-out；Task 2 让双语下载源严格只读并覆盖真实 auto 组合；Task 3 删除逐 cue 回退并锁死烧录凭证；Task 4 更新文档与全链路验证。
- Placeholder scan: 文档示例只使用仓库要求的 `<YOUTUBE_URL>`、`<videoId>` 占位符；没有待实现占位内容。
- Type consistency: `SemanticDeliveryManifest` 在 Task 3 定义，并由严格双语编排和烧录门共同消费。
- Boundary check: 双语与单语在 `runSubtitlePipeline` 顶部显式分流，旧路径只能服务单语，不能影响双语。
