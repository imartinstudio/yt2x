import type { Command } from "commander";
import {
  readDeconstructArtifacts,
  runDeconstruct,
  clipCandidates,
  writeDeconstructOutput,
  createLlmAdapter,
  selectClips,
  generateClipsPosts,
  writeReports,
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

  // Step 4: Clip video segments
  logger.info({ sourceVideo: artifacts.videoPath, outputDir: `${articleDir}/clips` }, "Deconstruct: clipping video segments");

  const clipResults = await clipCandidates(
    artifacts.videoPath,
    filtered.sections,
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

  // Step 5: Write manifest
  const output = await writeDeconstructOutput(
    articleDir,
    filtered.sections,
    artifacts.videoId,
    artifacts.videoPath,
    artifacts.durationSec,
  );

  logger.info({ manifestPath: output.manifestPath, clipCount: output.clippedCount }, "Deconstruct: manifest written");

  // Step 6: Auto-select (if --select is set)
  const selectCount = selectCountOverride ?? 0;
  if (selectCount > 0 && selectCount <= filtered.sections.length) {
    logger.info({ selectCount }, "Deconstruct: auto-selecting top candidates");

    // Sort by composite score descending
    const sorted = [...filtered.sections].sort(
      (a, b) => b.scores.composite - a.scores.composite,
    );
    const top = sorted.slice(0, selectCount);

    // Get their 1-based clip IDs
    const keepIds = top.map((s) => {
      const idx = filtered.sections.indexOf(s);
      return String(idx + 1);
    });

    logger.info({ keepIds }, "Deconstruct: selecting clips");

    await selectClips({
      articleDir,
      keep: keepIds,
    });

    // Step 7: Auto-generate posts
    logger.info({ model: llmConfig.model }, "Deconstruct: generating posts for selected clips");

    // Re-create LLM (fresh rate limit context)
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

    logger.info({ postCount: genResult.postCount }, "Deconstruct: posts generated");

    // Generate reports (now with post text populated)
    await generateReports(articleDir, artifacts.articleMd);

    // Summary for auto mode
    console.log("\n" + "=".repeat(60));
    console.log(`  ✅ 全自动拆解完成`);
    console.log(`  视频: ${artifacts.videoId} (${Math.round(artifacts.durationSec / 60)} min)`);
    console.log(`  候选: ${filtered.sections.length} → 选中 Top ${selectCount}`);
    console.log(`  视频裁剪: ${successCount}/${clipResults.length}`);
    console.log(`  帖子: ${genResult.postCount} 篇`);
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
    console.log(`  帖子文件：`);
    for (const p of genResult.postPaths) {
      console.log(`    ${p}`);
    }
    console.log();
  } else {
    // Generate reports (candidates only, no post text yet)
    await generateReports(articleDir, artifacts.articleMd);

    // Standard summary (no auto-select)
    console.log("\n" + "=".repeat(60));
    console.log(`  ✅ 章节拆解完成`);
    console.log(`  视频: ${artifacts.videoId} (${Math.round(artifacts.durationSec / 60)} min)`);
    console.log(`  LLM: ${filtered.sections.length} 个候选章节`);
    console.log(`  裁剪: ${successCount}/${clipResults.length} 个视频片段`);
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
    console.log(`  提示：用 --select N 自动选 Top N 并生成帖子`);
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
