import { mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  collectNativePipelineVideoIds,
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_OUT_DIR,
  executeNativeAcquire,
  listBatchVideosFromOutRoot,
  readProcessStatusMerged,
  readYoutubePageUrl,
  type ProcessRunner,
} from "@yt2x/adapters-node";
import type { PipelineArgs } from "../args/pipeline.js";
import { executeNativeArticle } from "./native-article.js";
import { executeNativeNotes } from "./native-notes.js";
import { executeNativePublish } from "./native-publish.js";
import { logger } from "../logger.js";
import { createAcquireReviewPrompt } from "./acquire-review-prompt.js";
import { nativeAcquireOptionsFromPipelineArgs } from "./native-acquire-from-pipeline-args.js";
import {
  acquireSubStepProgressFromHandle,
  createPipelineProgress,
  estimatePipelineVideoCount,
} from "../progress/pipeline-progress.js";

export type NativePipelineOptions = {
  args: PipelineArgs;
  monorepoRoot: string;
  runner?: ProcessRunner;
};

/** 合并子阶段退出码：保留最严重的非零码（如 partial=4 优先于 generic=1）。 */
export const mergePipelineExitCode = (current: number, next: number): number => {
  if (next === 0) return current;
  if (current === 0) return next;
  return Math.max(current, next);
};

const resolveOutRoot = (monorepoRoot: string, outDir: string | undefined): string =>
  outDir !== undefined ? path.resolve(outDir) : path.resolve(monorepoRoot, DEFAULT_OUT_DIR);

const logAcquireFailuresUnderOutRoot = async (outRoot: string): Promise<void> => {
  const rows = await listBatchVideosFromOutRoot(outRoot);
  for (const row of rows) {
    const videoDir = path.join(outRoot, row.video_id);
    const url = row.url.length > 0 ? row.url : await readYoutubePageUrl(videoDir, row.video_id);
    const merged = await readProcessStatusMerged(videoDir, { videoId: row.video_id, url });
    const acquire = merged?.steps.acquire;
    if (acquire?.status !== "failed" || acquire.error === undefined) continue;
    const detail = typeof acquire.error === "string" ? acquire.error : acquire.error.message;
    logger.error({ videoId: row.video_id, detail }, "yt2x pipeline: acquire failed for video");
  }
};

/**
 * 默认 `yt2x pipeline` 编排：**native acquire**（`@yt2x/adapters-node` `prepareYoutubeVideo` + yt-dlp 搜索），
 * 再按 **`collectNativePipelineVideoIds`**（扫描 `--out-dir` 下含 `metadata.json` 或 `process-status.json` 的子目录，字典序）进程内调用 native `notes` → `article` → `publish`。
 *
 * - `--continue-from`：不重新跑 acquire；视频队列仍由清单或已采集目录推断。
 * - `--acquire skip`：要求 `--out-dir` 下已有清单或至少一个含 `metadata.json` 的视频目录。
 */
export const runNativePipeline = async (opts: NativePipelineOptions): Promise<number> => {
  const { args, monorepoRoot, runner } = opts;
  const outRoot = resolveOutRoot(monorepoRoot, args.control.outDir);
  const articleOutRoot = path.resolve(monorepoRoot, DEFAULT_ARTICLE_OUT_DIR);
  await mkdir(outRoot, { recursive: true });
  await mkdir(articleOutRoot, { recursive: true });

  if (args.control.continueFlag) {
    logger.warn(
      {},
      "yt2x pipeline --continue-from: skipping acquire; resolving video queue from manifest or per-video metadata.json under --out-dir.",
    );
  }

  let videoIds = await collectNativePipelineVideoIds(outRoot);

  const videoCountForProgress =
    args.control.continueFlag || args.stages.acquire === "skip"
      ? Math.max(videoIds.length, 1)
      : estimatePipelineVideoCount(args, videoIds.length);

  const progress = createPipelineProgress(args, videoCountForProgress);

  const stageTimingKey = (stage: string, videoId: string): string =>
    videoIds.length > 1 ? `${stage}.${videoId}` : stage;

  try {
    if (args.control.continueFlag) {
      if (videoIds.length === 0) {
        logger.error(
          { outRoot },
          "No videos under --out-dir (no subdirs with metadata.json or process-status.json). Run acquire first.",
        );
        return 1;
      }
    } else if (args.stages.acquire !== "skip") {
      logger.info({ outRoot, acquire: args.stages.acquire }, "yt2x pipeline: native acquire");
      const base = nativeAcquireOptionsFromPipelineArgs(args, {
        monorepoRoot,
        outDir: outRoot,
        ...(runner !== undefined ? { runner } : {}),
      });
      const acquireCode = await executeNativeAcquire({
        ...base,
        progress: acquireSubStepProgressFromHandle(progress, "acquire"),
        ...(args.stages.acquire === "review" ? { reviewPrompt: createAcquireReviewPrompt() } : {}),
      });
      if (acquireCode !== 0) {
        await logAcquireFailuresUnderOutRoot(outRoot);
        logger.error({ outRoot, exitCode: acquireCode }, "yt2x pipeline: acquire stage failed");
        return acquireCode;
      }
      videoIds = await collectNativePipelineVideoIds(outRoot);
      if (videoIds.length === 0) {
        logger.error(
          { outRoot },
          "No videos found after acquire (no subdirs with metadata.json or process-status.json).",
        );
        return 1;
      }
    } else {
      if (videoIds.length === 0) {
        logger.error(
          { outRoot },
          'pipeline with --acquire skip needs video subdirs under --out-dir (each with metadata.json or process-status.json).',
        );
        return 1;
      }
    }

    let pipelineExit = 0;

    const notesForId = (id: string) =>
    ({
      outDir: outRoot,
      llmProvider: args.llm.provider,
      ...(args.llm.model !== undefined ? { llmModel: args.llm.model } : {}),
      ...(args.llm.baseUrl !== undefined ? { llmBaseUrl: args.llm.baseUrl } : {}),
      errorStrategy: args.control.errorStrategy,
      verbose: args.flags.verbose,
      force: args.control.force,
      videoId: [id],
    }) as Parameters<typeof executeNativeNotes>[0];

    const articleForId = (id: string) =>
    ({
      ...notesForId(id),
      articleOutDir: articleOutRoot,
      platform: args.article.platform,
      maxChars: String(args.article.maxChars),
      rewriteMode: args.article.rewriteMode,
    }) as Parameters<typeof executeNativeArticle>[0];

    const publishForId = (id: string) =>
    ({
      outDir: outRoot,
      articleOutDir: articleOutRoot,
      maxChars: String(args.publish.maxChars),
      maxTweets: String(args.publish.maxTweets),
      thread: args.publish.format === "thread",
      publishDryRun: args.publish.publishDryRun || args.stages.publish === "review",
      dryRun: args.publish.publishDryRun || args.stages.publish === "review",
      verbose: args.flags.verbose,
      videoId: id,
    }) as Parameters<typeof executeNativePublish>[0];

    if (args.stages.notes !== "skip") {
      logger.info({ videos: videoIds.length, stage: "notes" }, "yt2x pipeline: native notes stage");
      for (const id of videoIds) {
        progress.setActive(`notes · ${id}`);
        const t0 = performance.now();
        const code = await executeNativeNotes(notesForId(id));
        progress.record(stageTimingKey("notes", id), Math.round(performance.now() - t0));
        if (code !== 0) {
          pipelineExit = mergePipelineExitCode(pipelineExit, code);
          if (args.control.errorStrategy === "stop") return code;
        }
      }
    }

    if (args.stages.article !== "skip") {
      logger.info({ videos: videoIds.length, stage: "article" }, "yt2x pipeline: native article stage");
      for (const id of videoIds) {
        progress.setActive(`article · ${id}`);
        const t0 = performance.now();
        const code = await executeNativeArticle(articleForId(id));
        progress.record(stageTimingKey("article", id), Math.round(performance.now() - t0));
        if (code !== 0) {
          pipelineExit = mergePipelineExitCode(pipelineExit, code);
          if (args.control.errorStrategy === "stop") return code;
        }
      }
    }

    if (args.stages.publish !== "skip") {
      logger.info({ videos: videoIds.length, stage: "publish" }, "yt2x pipeline: native publish stage");
      if (args.stages.publish === "review") {
        logger.warn(
          {},
          "yt2x pipeline: --publish review previews publish output only; use --publish auto for real posting.",
        );
      }
      for (const id of videoIds) {
        progress.setActive(`publish · ${id}`);
        const t0 = performance.now();
        const code = await executeNativePublish(publishForId(id));
        progress.record(stageTimingKey("publish", id), Math.round(performance.now() - t0));
        if (code !== 0) {
          pipelineExit = mergePipelineExitCode(pipelineExit, code);
          if (args.control.errorStrategy === "stop") return code;
        }
      }
    }

    logger.info(
      { videos: videoIds.length, outRoot, exitCode: pipelineExit },
      "yt2x pipeline: native orchestrator completed",
    );
    return pipelineExit;
  } finally {
    progress.printSummary();
  }
};
