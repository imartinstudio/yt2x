import { mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_OUT_DIR,
  findPendingNativeArticleDirs,
  generateXArticleContent,
  patchProcessStatus,
  patchStepRunning,
  readStructuredNotesArtifacts,
  readYoutubePageUrl,
  writeNativeArticleBundle,
} from "@yt2x/adapters-node";
import { isLlmError } from "@yt2x/core";
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
    },
    "yt2x article (native x): starting",
  );

  let promptTokens = 0;
  let completionTokens = 0;
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
        { videoId: artifacts.videoId, model: llm.model },
        "yt2x article: calling LLM (may take several minutes)…",
      );
      const t0 = Date.now();
      const result = await generateXArticleContent({
        llm: llm.adapter,
        model: llm.model,
        artifacts,
      });
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - t0;
      const written = await writeNativeArticleBundle(
        articleOutDir,
        artifacts.videoId,
        result.content,
        {
          v: 1,
          platform: "x",
          videoId: artifacts.videoId,
          model: result.model,
          finishReason: result.finishReason,
          generatedAt: finishedAt,
          durationMs,
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
        },
        { force: flags.force === true, notesVideoDir: videoDir },
      );
      await patchProcessStatus(videoDir, identity, {
        step: "article",
        stepInfo: {
          status: "done",
          finishedAt,
          durationMs,
          artifacts: ["article.md", "run.json"],
          resultFile: path.basename(written.articlePath),
        },
        articleOutDir: written.articleDir,
      });
      if (result.usage !== undefined) {
        promptTokens += result.usage.promptTokens;
        completionTokens += result.usage.completionTokens;
      }
      logger.info(
        {
          videoId: result.videoId,
          articleDir: written.articleDir,
          coverPath: written.coverPath,
          model: result.model,
          finishReason: result.finishReason,
          durationMs,
          usage: result.usage,
        },
        "article generated (native x)",
      );
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
      totalPromptTokens: promptTokens,
      totalCompletionTokens: completionTokens,
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
