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
  generateClipsPosts,
  writeSelectedPostFiles,
  writeReports,
  deriveSeriesName,
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Deconstruct: LLM call failed");
    return 1;
  }

  // Step 3: Filter + validate
  const { filterValidSections, validateClipEndings } = await import("@yt2x/adapters-node");
  const filtered = filterValidSections(result.candidates);
  const dropped = result.candidates.sections.length - filtered.sections.length;

  if (dropped > 0) {
    logger.info({ dropped, kept: filtered.sections.length }, "Deconstruct: filtered out sections without video content");
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

  logger.info({ postCount: genResult.postCount }, "Deconstruct: posts generated for all candidates");

  // Step 6: Auto-select (if --select is set) — 基于文案质量 + 综合评分筛选
  const selectCount = selectCountOverride ?? 0;
  if (selectCount > 0 && selectCount <= filtered.sections.length) {
    logger.info({ selectCount }, "Deconstruct: selecting top candidates based on posts + scores");

    // Sort by composite score descending (posts are already generated, selection can now compare copy quality)
    const sorted = [...filtered.sections].sort(
      (a, b) => b.scores.composite - a.scores.composite,
    );
    const top = sorted.slice(0, selectCount);

    // Get their 1-based clip IDs
    const keepIds = top.map((s) => {
      const idx = filtered.sections.indexOf(s);
      return String(idx + 1);
    });

    logger.info({ keepIds }, "Deconstruct: marking selected clips");

    await selectClips({
      articleDir,
      keep: keepIds,
    });

    // Step 6b: Write .md files only for selected clips
    const manifestPath = `${articleDir}/clips/clips-manifest.json`;
    const manifestRaw = await readFile(manifestPath, "utf8");
    const postManifest = JSON.parse(manifestRaw) as DeconstructManifest;
    const articleMdForPosts = await readFile(`${articleDir}/article.md`, "utf8");
    const titleMatch2 = articleMdForPosts.match(/^#\s+(.+)$/m);
    const articleTitle2 = titleMatch2?.[1] ?? artifacts.videoId;
    const seriesName2 = deriveSeriesName(articleTitle2);

    const selectedPostPaths = await writeSelectedPostFiles(
      postManifest,
      articleTitle2,
      seriesName2,
      articleDir,
    );

    logger.info({ mdCount: selectedPostPaths.length }, "Deconstruct: .md files written for selected clips");

    // Step 7: Clip ONLY selected video segments — 节省裁剪时间和磁盘空间
    logger.info({ sourceVideo: artifacts.videoPath, outputDir: `${articleDir}/clips` }, "Deconstruct: clipping selected video segments only");

    const selectedSections = filtered.sections.filter((_, i) => keepIds.includes(String(i + 1)));
    const clipResults = await clipCandidates(
      artifacts.videoPath,
      selectedSections,
      `${articleDir}/clips`,
    );

    const successCount = clipResults.filter((r) => r.success).length;
    const failCount = clipResults.filter((r) => !r.success).length;

    if (failCount > 0) {
      logger.warn({ successCount, failCount }, "Deconstruct: some clips failed");
      for (const fail of clipResults.filter((r) => !r.success)) {
        logger.warn({ candidate: fail.candidate.title, error: fail.error }, "  clip failed");
      }
    }

    // Generate reports (now with post text populated)
    await generateReports(articleDir, artifacts.articleMd);

    // Summary for auto mode
    console.log("\n" + "=".repeat(60));
    console.log(`  ✅ 全自动拆解完成`);
    console.log(`  视频: ${artifacts.videoId} (${Math.round(artifacts.durationSec / 60)} min)`);
    console.log(`  候选: ${filtered.sections.length} → 选中 Top ${selectCount}`);
    console.log(`  文案: ${genResult.postCount} 篇 JSON（全部候选）→ 视频裁剪: ${successCount} 个（仅选中）`);
    console.log(`  .md 文件: ${selectedPostPaths.length} 个（仅选中）`);
    console.log(`  输出: ${output.manifestPath}`);
    console.log("=".repeat(60));
    console.log("\n选中章节（按评分排序）：");

    for (let i = 0; i < top.length; i++) {
      const s = top[i]!;
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
    // No auto-select: posts generated for all, no video clipping yet
    await generateReports(articleDir, artifacts.articleMd);

    // Standard summary
    console.log("\n" + "=".repeat(60));
    console.log(`  ✅ 章节拆解完成（文案已生成，视频待裁剪）`);
    console.log(`  视频: ${artifacts.videoId} (${Math.round(artifacts.durationSec / 60)} min)`);
    console.log(`  候选: ${filtered.sections.length} 个章节`);
    console.log(`  文案: ${genResult.postCount} 篇（全部候选，JSON only，未选无 .md）`);
    console.log(`  输出: ${output.manifestPath}`);
    if (selectCount > 0 && selectCount > filtered.sections.length) {
      console.log(`  ⚠️  --select ${selectCount} 超出候选数，已跳过自动选择`);
    }
    console.log("=".repeat(60));
    console.log("\n候选章节评分排序：");

    const sorted = [...filtered.sections].sort(
      (a, b) => b.scores.composite - a.scores.composite,
    );
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i]!;
      console.log(
        `  ${String(i + 1).padStart(2)}. ${String(s.scores.composite.toFixed(1))}⭐  [${s.angle}] ${s.title}`,
      );
      console.log(`      ${String(s.timecodes.startSec)}s → ${String(s.timecodes.endSec)}s  |  ${s.summary}`);
    }
    console.log();
    console.log(`  提示：用 --select N 基于文案质量选 Top N，然后裁剪视频`);
    console.log();
  }

  return 0;
};

/** 从磁盘读取当前 manifest，生成两份审核报告 */
const generateReports = async (articleDir: string, articleMd: string): Promise<void> => {
  try {
    const manifestPath = `${articleDir}/clips/clips-manifest.json`;
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
