import { mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_OUT_DIR,
  findPendingNativeArticleDirs,
  generateXArticleContent,
  generateXShortContent,
  generateXThreadContent,
  patchProcessStatus,
  patchStepRunning,
  readStructuredNotesArtifacts,
  readYoutubePageUrl,
  renderArticleImages,
  writeNativeArticleBundle,
  writeNativeShortBundle,
  writeNativeThreadBundle,
} from "@yt2x/adapters-node";
import {
  isLlmError,
  manifestToAvailableVisuals,
  parseArticleOutputTargets,
  type ArticleOutputTarget,
  type SceneManifest,
} from "@yt2x/core";
import { logger } from "../logger.js";
import type { SingleStageFlags } from "../commands/command-flags.js";
import { printCliErrorBlock } from "../diagnostics/error-format.js";
import { createCommandProgress } from "../progress/pipeline-progress.js";
import {
  NATIVE_EXIT,
  exitFromLlmKind,
  patchLlmStepFailed,
  resolveBatchVideoDirs,
  resolveNativeLlm,
} from "./native-stage-common.js";

export type ArticleFlags = SingleStageFlags & {
  videoId?: string[];
  all?: boolean;
  force?: boolean;
  articleOutDir?: string;
  showProgress?: boolean;
};

const addUsage = (
  totals: { promptTokens: number; completionTokens: number },
  usage: { promptTokens: number; completionTokens: number; totalTokens?: number } | undefined,
): void => {
  if (usage === undefined) return;
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
};

const formatTargets = (targets: readonly ArticleOutputTarget[]): string => targets.join(",");

/** 供 `pipeline` 编排器与 `yt2x article` 调用；返回进程退出码。 */
export const executeNativeArticle = async (flags: ArticleFlags): Promise<number> => {
  const notesOutDir = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
  const articleOutDir = path.resolve(flags.articleOutDir ?? DEFAULT_ARTICLE_OUT_DIR);
  await mkdir(notesOutDir, { recursive: true });
  await mkdir(articleOutDir, { recursive: true });
  const platform = flags.platform ?? "x";
  if (platform !== "x") {
    printCliErrorBlock({
      command: "article",
      reason: `Unsupported platform: ${platform}`,
      hints: ["Native article generation currently supports only --platform x."],
      retryCommand: "pnpm yt2x article --video-id <videoId> --platform x",
    });
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  let outputTargets: ArticleOutputTarget[];
  try {
    outputTargets = parseArticleOutputTargets(flags.targets);
  } catch (err: unknown) {
    printCliErrorBlock({
      command: "article",
      reason: err instanceof Error ? err.message : String(err),
      hints: ["Use --targets article,x-thread,x-short or --targets all."],
      retryCommand: "pnpm yt2x article --video-id <videoId> --targets article",
    });
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  const llm = resolveNativeLlm(flags);
  if (!llm.ok) {
    printCliErrorBlock({
      command: "article",
      reason: llm.reason,
      hints: ["Configure an LLM provider and API key before generating articles."],
      retryCommand: "pnpm yt2x llm ping",
    });
    return llm.exitCode;
  }

  const batch = await resolveBatchVideoDirs({
    outDir: notesOutDir,
    findAllPending: () => findPendingNativeArticleDirs(notesOutDir, articleOutDir),
    ...(flags.all === true ? { all: true as const } : {}),
    ...(flags.videoId !== undefined && flags.videoId.length > 0 ? { videoId: flags.videoId } : {}),
  });
  if (!batch.ok) {
    if (batch.reason === "empty_pending") {
      printCliErrorBlock({
        command: "article",
        reason: "No pending videos found.",
        details: notesOutDir,
        hints: ["Pending articles require structured-notes.md and no existing article.md."],
        retryCommand: "pnpm yt2x article --video-id <videoId>",
      });
    } else {
      printCliErrorBlock({
        command: "article",
        reason: "Missing target. Article requires --video-id <id...> or --all.",
        hints: ["Run notes first, then pass the generated video directory name."],
        retryCommand: "pnpm yt2x article --video-id <videoId>",
      });
    }
    return batch.exitCode;
  }
  const targets = batch.targets;
  const progress = flags.showProgress === false ? undefined : createCommandProgress("article", targets.length);
  let exitCode = 1;

  logger.info(
    {
      provider: llm.provider,
      model: llm.model,
      targets: targets.length,
      notesOutDir,
      articleOutDir,
      platform,
      outputTargets,
    },
    "yt2x article (native x): starting",
  );

  const tokenTotals = { promptTokens: 0, completionTokens: 0 };
  const errors: Array<{ videoDir: string; message: string }> = [];

  for (const videoDir of targets) {
    const stageT0 = performance.now();
    let progressKey = `article.${path.basename(videoDir)}`;
    try {
      const artifacts = await readStructuredNotesArtifacts(videoDir);
      progressKey = `article.${artifacts.videoId}`;
      progress?.setActive(`article · ${artifacts.videoId}`);
      const url = await readYoutubePageUrl(videoDir, artifacts.videoId);
      const identity = { videoId: artifacts.videoId, url };
      await patchStepRunning(videoDir, identity, "article").catch(() => {});
      logger.info(
        { videoId: artifacts.videoId, model: llm.model, outputTargets },
        "yt2x article: calling LLM (may take several minutes)…",
      );
      const t0 = Date.now();
      const writtenArtifacts: string[] = [];
      let articleDirForStatus: string | undefined;
      let resultFile: string | undefined;

      // 读取 scene_manifest.json → available_visuals（所有格式共享）
        const { readFile, access } = await import("node:fs/promises");
        const sceneManifestPath = path.join(videoDir, "screenshots", "scene_manifest.json");
        let availableVisuals = null;
        try {
          await access(sceneManifestPath);
          const raw = await readFile(sceneManifestPath, "utf8");
          const manifest = JSON.parse(raw) as SceneManifest;
          availableVisuals = manifestToAvailableVisuals(manifest);
        } catch {
          // 无截图清单时保持纯文本
        }

    if (outputTargets.includes("article")) {
        const result = await generateXArticleContent({
          llm: llm.adapter,
          model: llm.model,
          artifacts,
          availableVisuals,
        });

        // 渲染图片：复制截图到文章 images/ 并替换路径
        const renderedContent = await renderArticleImages(
          result.content,
          videoDir,
          path.join(articleOutDir, artifacts.videoId),
          result.visualPlan,
          availableVisuals,
        );

        const written = await writeNativeArticleBundle(
          articleOutDir,
          artifacts.videoId,
          renderedContent,
          {
            v: 1,
            platform: "x",
            videoId: artifacts.videoId,
            model: result.model,
            finishReason: result.finishReason,
            generatedAt: new Date().toISOString(),
            durationMs: result.durationMs,
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
          },
          { force: flags.force === true, notesVideoDir: videoDir },
        );
        writtenArtifacts.push("article.md", "run.json");
        articleDirForStatus = written.articleDir;
        resultFile ??= path.basename(written.articlePath);
        addUsage(tokenTotals, result.usage);
        logger.info(
          {
            videoId: result.videoId,
            articleDir: written.articleDir,
            coverPath: written.coverPath,
            model: result.model,
            finishReason: result.finishReason,
            durationMs: result.durationMs,
            usage: result.usage,
          },
          "article generated (native article)",
        );
      }

      if (outputTargets.includes("x-thread")) {
        const result = await generateXThreadContent({
          llm: llm.adapter,
          model: llm.model,
          artifacts,
          availableVisuals,
        });
        const written = await writeNativeThreadBundle(
          articleOutDir,
          artifacts.videoId,
          result.thread,
          { force: flags.force === true },
        );
        writtenArtifacts.push("x-thread.md", "x-hooks.json");
        articleDirForStatus = written.articleDir;
        resultFile ??= path.basename(written.threadPath);
        addUsage(tokenTotals, result.usage);
        logger.info(
          {
            videoId: result.videoId,
            articleDir: written.articleDir,
            model: result.model,
            finishReason: result.finishReason,
            durationMs: result.durationMs,
            usage: result.usage,
          },
          "article generated (native x thread)",
        );
      }

      if (outputTargets.includes("x-short")) {
        const result = await generateXShortContent({
          llm: llm.adapter,
          model: llm.model,
          artifacts,
          availableVisuals,
        });
        const written = await writeNativeShortBundle(
          articleOutDir,
          artifacts.videoId,
          result.shortPost,
          { force: flags.force === true },
        );
        writtenArtifacts.push("x-short.md");
        articleDirForStatus = written.articleDir;
        resultFile ??= path.basename(written.shortPath);
        addUsage(tokenTotals, result.usage);
        logger.info(
          {
            videoId: result.videoId,
            articleDir: written.articleDir,
            model: result.model,
            finishReason: result.finishReason,
            durationMs: result.durationMs,
            usage: result.usage,
          },
          "article generated (native x short)",
        );
      }

      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - t0;
      await patchProcessStatus(videoDir, identity, {
        step: "article",
        stepInfo: {
          status: "done",
          finishedAt,
          durationMs,
          artifacts: writtenArtifacts,
          resultFile: resultFile ?? formatTargets(outputTargets),
        },
        articleOutDir: articleDirForStatus ?? path.join(articleOutDir, artifacts.videoId),
      });
      progress?.record(progressKey, Math.round(performance.now() - stageT0));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ videoDir, message });
      printCliErrorBlock({
        command: "article",
        subject: path.basename(videoDir),
        reason: message,
        details: path.join(videoDir, "process-status.json"),
        hints: ["Ensure notes completed successfully before generating an article."],
        retryCommand: `pnpm yt2x article --video-id ${path.basename(videoDir)}`,
      });
      try {
        await patchLlmStepFailed(videoDir, "article", err);
      } catch {
        // ignore
      }
      if (isLlmError(err)) {
        if (flags.errorStrategy !== "skip") {
          progress?.clear();
          return exitFromLlmKind(err.kind);
        }
      } else if (flags.errorStrategy !== "skip") {
        progress?.clear();
        return 1;
      }
      progress?.record(progressKey, Math.round(performance.now() - stageT0));
    }
  }

  logger.info(
    {
      ok: targets.length - errors.length,
      failed: errors.length,
      totalPromptTokens: tokenTotals.promptTokens,
      totalCompletionTokens: tokenTotals.completionTokens,
    },
    "yt2x article (native x): done",
  );
  exitCode = errors.length > 0 ? NATIVE_EXIT.PARTIAL_FAILURE : 0;
  if (exitCode === 0) {
    progress?.printSummary();
  } else {
    progress?.clear();
  }
  return exitCode;
};
