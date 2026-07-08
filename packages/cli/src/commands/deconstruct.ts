import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { DeconstructManifest } from "@yt2x/core";
import {
  readDeconstructArtifacts,
  runDeconstruct,
  clipCandidates,
  writeDeconstructOutput,
  createLlmAdapter,
  selectClips,
  selectTopUniqueArticleSections,
  generateClipsPosts,
  writeSelectedPostFiles,
  writeReports,
  assertClipPublishReadiness,
} from "@yt2x/adapters-node";
import { resolveLlmConfig, defaultCliLlmProvider } from "../config/env.js";
import { logger } from "../logger.js";

export const runDeconstructCommand = async (
  videoId: string,
  selectCountOverride?: number,
): Promise<number> => {
  const { defaultMonorepoRoot } = await import("../config/monorepo-root.js");
  const monorepoRoot = defaultMonorepoRoot();
  const articleDir = videoId.includes("/")
    ? videoId
    : `${monorepoRoot}/files/articles/${videoId}`;

  logger.info({ articleDir }, "Deconstruct: reading artifacts");

  // Step 1: Read artifacts
  let artifacts;
  try {
    artifacts = await readDeconstructArtifacts(articleDir);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ articleDir, error: msg }, "Deconstruct: failed to read artifacts");
    return 1;
  }

  logger.info({ videoId: artifacts.videoId, durationSec: artifacts.durationSec }, "Deconstruct: artifacts loaded");

  // Step 2: Call LLM
  const llmConfig = resolveLlmConfig({ provider: defaultCliLlmProvider() });
  const llmCfg: Parameters<typeof createLlmAdapter>[0] = {
    provider: llmConfig.provider,
    apiKey: llmConfig.apiKey ?? "",
    baseUrl: llmConfig.baseUrl ?? "",
  };
  if (llmConfig.model !== undefined) llmCfg.defaultModel = llmConfig.model;
  const llm = createLlmAdapter(llmCfg);

  logger.info({ provider: llmConfig.provider, model: llmConfig.model }, "Deconstruct: calling LLM");

  let result;
  try {
    result = await runDeconstruct({
      llm,
      model: llmConfig.model ?? "",
      articleDir,
    });
    if (result.usage !== undefined) {
      logger.info({ usage: result.usage }, "Deconstruct: LLM usage (clip identification)");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Deconstruct: LLM call failed");
    return 1;
  }

  // Step 3: Split oversized sections + filter + validate
  const { filterValidSections, validateClipEndings, splitOversizedSections } = await import("@yt2x/adapters-node");
  const split = splitOversizedSections(result.candidates, artifacts.srtContent);
  const splitCount = split.sections.length - result.candidates.sections.length;
  if (splitCount > 0) {
    logger.info({ splitCount, totalAfterSplit: split.sections.length }, "Deconstruct: split oversized sections into sub-sections");
  }
  const filtered = filterValidSections(split);
  const skipped = split.sections.filter((s) => s.skip_reason != null).length;
  const invalid = split.sections.length - filtered.sections.length - skipped;

  if (skipped > 0 || invalid > 0) {
    logger.info({ total: split.sections.length, skipped, invalid, kept: filtered.sections.length }, "Deconstruct: filtered out");
  }

  // Log all candidates
  for (const section of filtered.sections) {
    const score = section.scores.composite;
    const stars = "⭐".repeat(Math.round(score));
    logger.info(
      {
        id: section.id,
        title: section.title,
        time: `${String(section.timecodes.startSec)}s-${String(section.timecodes.endSec)}s`,
        score: String(score.toFixed(1)),
        angle: section.angle,
      },
      `  ${stars} ${section.title}`,
    );
  }

  // Validate clip endings against SRT
  const boundaryWarnings = validateClipEndings(filtered.sections, artifacts.srtContent);
  if (boundaryWarnings.length > 0) {
    for (const w of boundaryWarnings) {
      logger.warn({ id: w.id, title: w.title, warning: w.warning }, "⚠️ 片段可能在说话中间切断");
    }
  }

  // Step 4: Write manifest — 先不裁剪视频，保存全部候选元数据
  const output = await writeDeconstructOutput(
    articleDir,
    filtered.sections,
    artifacts.videoId,
    artifacts.videoPath,
    artifacts.durationSec,
  );

  logger.info({ manifestPath: output.manifestPath, clipCount: output.clippedCount }, "Deconstruct: manifest written");

  // Step 5: Generate posts for ALL candidates — 先生成文案，基于文案质量筛选
  logger.info({ model: llmConfig.model }, "Deconstruct: generating posts for all candidates");

  const genLlmCfg: Parameters<typeof createLlmAdapter>[0] = {
    provider: llmConfig.provider,
    apiKey: llmConfig.apiKey ?? "",
    baseUrl: llmConfig.baseUrl ?? "",
  };
  if (llmConfig.model !== undefined) genLlmCfg.defaultModel = llmConfig.model;
  const genLlm = createLlmAdapter(genLlmCfg);

  const genResult = await generateClipsPosts({
    llm: genLlm,
    model: llmConfig.model ?? "",
    articleDir,
  });

  if (genResult.usage !== undefined) {
    logger.info({ usage: genResult.usage }, "Deconstruct: LLM usage (post generation)");
  }
  logger.info({ postCount: genResult.postCount }, "Deconstruct: posts generated for all candidates");

  // Step 6: Auto-select — 基于文案质量 + 综合评分筛选
  const selectCount = selectCountOverride ?? 0;
  const uniqueSections = selectTopUniqueArticleSections(filtered.sections, filtered.sections.length);
  // --select N clamps to available unique article sections; no --select flag → take all unique article sections
  const effectiveSelect = selectCount > 0
    ? Math.min(selectCount, uniqueSections.length)
    : uniqueSections.length;
  if (effectiveSelect > 0) {
    const selectSource = selectCount > 0
      ? `--select ${selectCount}` + (selectCount > uniqueSections.length ? ` (clamped to ${effectiveSelect})` : "")
      : "all unique article sections (no --select flag)";
    logger.info({ selectCount, effectiveSelect, totalCandidates: filtered.sections.length, uniqueArticleSections: uniqueSections.length, selectSource }, "Deconstruct: selecting top candidates based on posts + scores");

    const top = selectTopUniqueArticleSections(filtered.sections, effectiveSelect);

    // Get their 1-based clip IDs from the original filtered candidate order
    const keepIds = top.map((s) => String(s.originalIndex + 1));

    logger.info({ keepIds }, "Deconstruct: marking selected clips");

    await selectClips({
      articleDir,
      keep: keepIds,
    });

    // Step 6b: Write .md files only for selected clips
    const manifestPath = `${articleDir}/x-format/clips/clips-manifest.json`;
    const manifestRaw = await readFile(manifestPath, "utf8");
    const postManifest = JSON.parse(manifestRaw) as DeconstructManifest;
    const selectedPostPaths = await writeSelectedPostFiles(
      postManifest,
      articleDir,
    );

    logger.info({ mdCount: selectedPostPaths.length }, "Deconstruct: .md files written for selected clips");

    // Step 7: Clip ONLY selected video segments — 节省裁剪时间和磁盘空间
    logger.info({ sourceVideo: artifacts.videoPath, outputDir: `${articleDir}/x-format/clips` }, "Deconstruct: clipping selected video segments only");

    const selectedSections = filtered.sections.filter((_, i) => keepIds.includes(String(i + 1)));
    const clipResults = await clipCandidates(
      artifacts.videoPath,
      selectedSections,
      `${articleDir}/x-format/clips`,
    );

    const successCount = clipResults.filter((r) => r.success).length;
    const failCount = clipResults.filter((r) => !r.success).length;

    if (failCount > 0) {
      logger.warn({ successCount, failCount }, "Deconstruct: some clips failed");
      for (const fail of clipResults.filter((r) => !r.success)) {
        logger.warn({ candidate: fail.candidate.title, error: fail.error }, "  clip failed");
      }
    }

    try {
      const readiness = await assertClipPublishReadiness(articleDir);
      logger.info({ postCount: readiness.publishOrder.length }, "Deconstruct: clip publish readiness check passed");
    } catch (err: unknown) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "Deconstruct: clip publish readiness check failed",
      );
      return 1;
    }

    // Generate reports (now with post text populated)
    await generateReports(articleDir, artifacts.articleMd);

    // Summary for auto mode
    const selectLabel = selectCount > 0
      ? (selectCount > effectiveSelect
          ? `Top ${effectiveSelect} (--select ${selectCount} 超出候选数，已自动降为 ${effectiveSelect})`
          : `Top ${effectiveSelect}`)
      : `全部 ${effectiveSelect} 个`;
    console.log("\n" + "=".repeat(60));
    console.log(`  ✅ 全自动拆解完成`);
    console.log(`  视频: ${artifacts.videoId} (${Math.round(artifacts.durationSec / 60)} min)`);
    console.log(`  候选: ${filtered.sections.length} → 选中 ${selectLabel}`);
    console.log(`  文案: ${genResult.postCount} 篇 → 视频裁剪: ${successCount} 个`);
    console.log(`  .md 文件: ${selectedPostPaths.length} 个`);
    console.log(`  输出: ${output.manifestPath}`);
    console.log("=".repeat(60));
    console.log("\n选中章节（按评分排序）：");

    for (let i = 0; i < top.length; i++) {
      const s = top[i]!.section;
      console.log(
        `  ${String(i + 1).padStart(2)}. ${String(s.scores.composite.toFixed(1))}⭐  [${s.angle}] ${s.title}`,
      );
      console.log(`      ${String(s.timecodes.startSec)}s → ${String(s.timecodes.endSec)}s`);
    }
    console.log();
    console.log(`  选中文案 .md 文件：`);
    for (const p of selectedPostPaths) {
      console.log(`    ${p}`);
    }
    console.log();
  } else {
    // No candidates found — nothing to select or clip
    await generateReports(articleDir, artifacts.articleMd);

    console.log("\n" + "=".repeat(60));
    console.log(`  ⚠️  未找到有效章节候选`);
    console.log(`  视频: ${artifacts.videoId} (${Math.round(artifacts.durationSec / 60)} min)`);
    console.log(`  可能原因：文章章节在视频中缺少对应画面，或时间码无法匹配`);
    console.log(`  输出: ${output.manifestPath}`);
    console.log("=".repeat(60));
    console.log();
  }

  return 0;
};

/** 从磁盘读取当前 manifest，生成两份审核报告 */
const generateReports = async (articleDir: string, articleMd: string): Promise<void> => {
  try {
    const manifestPath = `${articleDir}/x-format/clips/clips-manifest.json`;
    const manifest = JSON.parse(
      await import("node:fs/promises").then((m) => m.readFile(manifestPath, "utf8")),
    );
    const titleMatch = articleMd.match(/^#\s+(.+)$/m);
    const articleTitle = titleMatch?.[1] ?? undefined;
    const reports = await writeReports(articleDir, manifest, articleTitle);
    logger.info(
      { decompositionPath: reports.decompositionPath, reviewPath: reports.reviewPath },
      "Reports generated for human review",
    );
  } catch (err: unknown) {
    // Non-fatal: reports are supplementary
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Failed to generate reports");
  }
};

export const registerDeconstructCommand = (program: Command): void => {
  program
    .command("deconstruct")
    .description("Deconstruct an article into candidate video clips with scoring")
    .argument(
      "<video-id>",
      "Video ID (e.g. HQGUed-e2wM) under files/articles/, or a direct path to an article dir",
    )
    .option(
      "--select <n>",
      "Auto-select top N candidates by score and generate posts (skips manual selection step)",
    )
    .action(async (videoId: string, options: { select?: string }) => {
      const selectN = options.select ? parseInt(options.select, 10) : undefined;
      process.exitCode = await runDeconstructCommand(videoId, selectN);
    });
};
