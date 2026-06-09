import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  burnZhSubtitlesForVideo,
  collectNativePipelineVideoIds,
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_OUT_DIR,
  defaultProcessRunner,
  executeNativeAcquire,
  extractVideoId,
  listBatchVideosFromOutRoot,
  readProcessStatusMerged,
  readYoutubePageUrl,
  type ProcessRunner,
} from "@yt2x/adapters-node";
import type { PipelineArgs } from "../args/pipeline.js";
import { executeNativeArticle } from "./native-article.js";
import { executeNativeNotes } from "./native-notes.js";
import { executeNativePublish } from "./native-publish.js";
import { runDeconstructCommand } from "../commands/deconstruct.js";
import { logger } from "../logger.js";
import { createAcquireReviewPrompt } from "./acquire-review-prompt.js";
import { nativeAcquireOptionsFromPipelineArgs } from "./native-acquire-from-pipeline-args.js";
import {
  acquireSubStepProgressFromHandle,
  createPipelineProgress,
  estimatePipelineVideoCount,
} from "../progress/pipeline-progress.js";
import { resolveNativeLlm } from "./native-stage-common.js";

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

const logAcquireFailuresUnderOutRoot = async (
  outRoot: string,
  options: { updatedAfterIso?: string } = {},
): Promise<void> => {
  const rows = await listBatchVideosFromOutRoot(outRoot);
  for (const row of rows) {
    const videoDir = path.join(outRoot, row.video_id);
    const url = row.url.length > 0 ? row.url : await readYoutubePageUrl(videoDir, row.video_id);
    const merged = await readProcessStatusMerged(videoDir, { videoId: row.video_id, url });
    if (
      options.updatedAfterIso !== undefined &&
      (merged?.updatedAt === undefined || merged.updatedAt < options.updatedAfterIso)
    ) {
      continue;
    }
    const acquire = merged?.steps.acquire;
    if (acquire?.status !== "failed" || acquire.error === undefined) continue;
    const detail = typeof acquire.error === "string" ? acquire.error : acquire.error.message;
    logger.error({ videoId: row.video_id, detail }, "yt2x pipeline: acquire failed for video");
  }
};

const hasMetadata = async (outRoot: string, id: string): Promise<boolean> =>
  access(path.join(outRoot, id, "metadata.json"))
    .then(() => true)
    .catch(() => false);

const filterMaterializedVideoIds = async (outRoot: string, ids: string[]): Promise<string[]> => {
  const materialized: string[] = [];
  for (const id of ids) {
    if (await hasMetadata(outRoot, id)) {
      materialized.push(id);
    }
  }
  return materialized;
};

/** 对单个视频烧录中文字幕到 MP4，输出到 articleOutRoot/<id>/video/。 */
const burnSubtitlesForVideo = async (
  outRoot: string,
  articleOutRoot: string,
  videoId: string,
  force: boolean,
): Promise<void> => {
  const result = await burnZhSubtitlesForVideo({
    videoDir: path.join(outRoot, videoId),
    burnedVideoOutDir: articleOutRoot,
    runner: defaultProcessRunner,
    skipIfChineseBurned: true,
    ...(force ? { force } : {}),
  });

  if (result.skipReason === "chinese_burned_detected") {
    logger.info(
      { videoId, detect: result.detect },
      "original video already has burned Chinese subtitles, skipping re-burn",
    );
    return;
  }

  if (
    result.detect?.hasBurnedSubtitles === true &&
    result.detect.hasChineseBurnedSubtitles === false
  ) {
    logger.info(
      { videoId, detect: result.detect },
      "bottom overlay detected but not confirmed as Chinese burned subs; will still burn zh subtitles",
    );
  }

  if (result.burned) {
    logger.info({ videoId, burnedPath: result.burnedPath }, "subtitle burn complete");
  }
};

/** 格式化秒数为 HH:MM:SS */
const formatDuration = (seconds: number | undefined): string => {
  if (seconds === undefined || !Number.isFinite(seconds)) return "-";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

/** 截断标题（正确处理 CJK 字符边界） */
const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
};

/** 步骤状态标签 */
const stepLabel = (status: string | undefined): string => {
  if (status === "done") return "done";
  if (status === "failed") return "FAIL";
  if (status === "running") return "run";
  return "-";
};

type VideoSummaryRow = {
  videoId: string;
  title: string;
  duration: number | undefined;
  acquire: string | undefined;
  notes: string | undefined;
  article: string | undefined;
  articleThread: string | undefined;
  articleShort: string | undefined;
  publish: string | undefined;
};

const collectVideoSummary = async (
  outRoot: string,
  articleOutRoot: string,
  videoId: string,
): Promise<VideoSummaryRow> => {
  const videoDir = path.join(outRoot, videoId);
  let title = videoId;
  let duration: number | undefined;

  try {
    const metaRaw = await readFile(path.join(videoDir, "metadata.json"), "utf8");
    const meta = JSON.parse(metaRaw) as Record<string, unknown>;
    title = String(meta.title ?? videoId);
    duration = typeof meta.duration === "number" ? meta.duration : undefined;
  } catch {
    // metadata.json not found
  }

  const url = await readYoutubePageUrl(videoDir, videoId);
  const status = await readProcessStatusMerged(videoDir, { videoId, url }).catch(() => null);

  const articleDir = status?.articleOutDir ?? path.join(articleOutRoot, videoId);
  let article: string | undefined;
  let articleThread: string | undefined;
  let articleShort: string | undefined;

  if (status?.steps.article?.status === "done") {
    try {
      await access(path.join(articleDir, "article.md"));
      article = "done";
    } catch { /* */ }
    try {
      await access(path.join(articleDir, "x-thread.md"));
      articleThread = "done";
    } catch { /* */ }
    try {
      await access(path.join(articleDir, "x-short.md"));
      articleShort = "done";
    } catch { /* */ }
  } else if (status?.steps.article?.status === "failed") {
    article = "failed";
  }

  return {
    videoId,
    title,
    duration,
    acquire: status?.steps.acquire?.status,
    notes: status?.steps.notes?.status,
    article,
    articleThread,
    articleShort,
    publish: status?.steps.publish?.status,
  };
};

const printPipelineSummaryTable = async (
  outRoot: string,
  articleOutRoot: string,
  videoIds: string[],
): Promise<void> => {
  const rows = await Promise.all(
    videoIds.map((id) => collectVideoSummary(outRoot, articleOutRoot, id)),
  );

  const cols = [
    { key: "videoId" as const, header: "VIDEO ID", width: 12 },
    { key: "title" as const, header: "TITLE", width: 35, format: (r: VideoSummaryRow) => truncate(r.title, 35) },
    { key: "duration" as const, header: "DURATION", width: 9, format: (r: VideoSummaryRow) => formatDuration(r.duration) },
    { key: "acquire" as const, header: "ACQUIRE", width: 8, label: true },
    { key: "notes" as const, header: "NOTES", width: 6, label: true },
    { key: "article" as const, header: "ARTICLE", width: 8, label: true },
    { key: "articleThread" as const, header: "A-THREAD", width: 8, label: true },
    { key: "articleShort" as const, header: "A-SHORT", width: 8, label: true },
    { key: "publish" as const, header: "PUBLISH", width: 8, label: true },
  ];

  // 顶部分隔线
  const sep = "─".repeat(cols.reduce((s, c) => s + c.width + 3, 1));
  const lines: string[] = ["", `┌${sep}┐`];

  // 表头
  const header =
    "│ " + cols.map((c) => c.header.padEnd(c.width)).join(" │ ") + " │";
  lines.push(header);
  lines.push(`├${sep}┤`);

  // 数据行
  for (const row of rows) {
    const cells = cols.map((c) => {
      let val: string;
      if (c.format !== undefined) {
        val = c.format(row);
      } else if (c.label) {
        const status = (row as Record<string, unknown>)[c.key] as string | undefined;
        val = stepLabel(status);
      } else {
        val = String((row as Record<string, unknown>)[c.key] ?? "-");
      }
      return val.padEnd(c.width);
    });
    lines.push("│ " + cells.join(" │ ") + " │");
  }

  lines.push(`└${sep}┘`);
  lines.push("");

  for (const line of lines) {
    console.log(line);
  }
};

const sourceVideoIdsFromUrls = (urls: readonly string[]): string[] => {
  const ids = urls.map((url) => extractVideoId(url));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
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
  const initialVideoIds = new Set(videoIds);

  const videoCountForProgress =
    args.control.continueFlag || args.stages.acquire === "skip"
      ? Math.max(videoIds.length, 1)
      : estimatePipelineVideoCount(args, videoIds.length);

  const progress = createPipelineProgress(args, videoCountForProgress);
  let finalExitCode = 1;

  const stageTimingKey = (stage: string, videoId: string): string =>
    videoIds.length > 1 ? `${stage}.${videoId}` : stage;

  // 如果用户要求烧录字幕，推迟到 article 阶段之后执行。
  // acquire 阶段只需生成 full.zh.srt，不需要烧录（无论 acquire 是否 skip）。
  const deferredBurn =
    args.acquire.subtitleZh === "burned" || args.acquire.subtitleZh === "both";

  try {
    if (args.control.continueFlag) {
      if (videoIds.length === 0) {
        logger.error(
          { outRoot },
          "No videos under --out-dir (no subdirs with metadata.json or process-status.json). Run acquire first.",
        );
        finalExitCode = 1;
        return finalExitCode;
      }
    } else if (args.stages.acquire !== "skip") {
      logger.info({ outRoot, acquire: args.stages.acquire }, "yt2x pipeline: native acquire");

      // acquire 阶段只需生成 full.zh.srt，烧录推迟到 article 之后。
      const acquireSubtitleMode = deferredBurn ? ("srt" as const) : args.acquire.subtitleZh;
      const acquireArgs = {
        ...args,
        acquire: { ...args.acquire, subtitleZh: acquireSubtitleMode },
      };

      const base = nativeAcquireOptionsFromPipelineArgs(acquireArgs, {
        monorepoRoot,
        outDir: outRoot,
        ...(runner !== undefined ? { runner } : {}),
      });

      const needsTranslation =
        args.acquire.subtitleZh === "srt" ||
        args.acquire.subtitleZh === "burned" ||
        args.acquire.subtitleZh === "both";
      let llmResult: ReturnType<typeof resolveNativeLlm> | undefined;
      if (needsTranslation) {
        llmResult = resolveNativeLlm({
          llmProvider: args.llm.provider,
          ...(args.llm.model !== undefined ? { llmModel: args.llm.model } : {}),
          ...(args.llm.baseUrl !== undefined ? { llmBaseUrl: args.llm.baseUrl } : {}),
        });
        if (!llmResult.ok) {
          logger.error({ reason: llmResult.reason }, "LLM config missing for subtitle translation");
          finalExitCode = llmResult.exitCode;
          return finalExitCode;
        }
      }

      const acquireStartedAt = new Date(Date.now() - 1000).toISOString();
      const acquireCode = await executeNativeAcquire({
        ...base,
        progress: acquireSubStepProgressFromHandle(progress, "acquire"),
        articleOutDir: articleOutRoot,
        ...(args.stages.acquire === "review" ? { reviewPrompt: createAcquireReviewPrompt() } : {}),
        ...(llmResult?.ok === true
          ? { llm: llmResult.adapter, llmModel: llmResult.model }
          : {}),
      });
      if (acquireCode !== 0) {
        await logAcquireFailuresUnderOutRoot(outRoot, { updatedAfterIso: acquireStartedAt });
        logger.error({ outRoot, exitCode: acquireCode }, "yt2x pipeline: acquire stage failed");
        finalExitCode = acquireCode;
        return finalExitCode;
      }
      const allVideoIdsAfterAcquire = await collectNativePipelineVideoIds(outRoot);
      const newlyDiscoveredVideoIds = allVideoIdsAfterAcquire.filter((id) => !initialVideoIds.has(id));
      const sourceVideoIds = sourceVideoIdsFromUrls(args.sources.urls);
      videoIds =
        newlyDiscoveredVideoIds.length > 0
          ? newlyDiscoveredVideoIds
          : allVideoIdsAfterAcquire.filter((id) => sourceVideoIds.includes(id));
      videoIds = await filterMaterializedVideoIds(outRoot, videoIds);
      if (videoIds.length === 0) {
        logger.error(
          { outRoot },
          "No videos with metadata.json found after acquire.",
        );
        finalExitCode = 1;
        return finalExitCode;
      }
    } else {
      if (videoIds.length === 0) {
        logger.error(
          { outRoot },
          'pipeline with --acquire skip needs video subdirs under --out-dir (each with metadata.json or process-status.json).',
        );
        finalExitCode = 1;
        return finalExitCode;
      }
    }

    let pipelineExit = 0;

    if (args.stages.acquire === "skip" || args.control.continueFlag) {
      videoIds = await filterMaterializedVideoIds(outRoot, videoIds);
    }

    const notesForId = (id: string) =>
    ({
      outDir: outRoot,
      llmProvider: args.llm.provider,
      ...(args.llm.model !== undefined ? { llmModel: args.llm.model } : {}),
      ...(args.llm.baseUrl !== undefined ? { llmBaseUrl: args.llm.baseUrl } : {}),
      errorStrategy: args.control.errorStrategy,
      verbose: args.flags.verbose,
      force: args.control.force,
      showProgress: false,
      videoId: [id],
    }) as Parameters<typeof executeNativeNotes>[0];

    const articleForId = (id: string) =>
    ({
      ...notesForId(id),
      articleOutDir: articleOutRoot,
      platform: args.article.platform,
      maxChars: String(args.article.maxChars),
      rewriteMode: args.article.rewriteMode,
      targets: args.article.targets.join(","),
    }) as Parameters<typeof executeNativeArticle>[0];

    const publishForId = (id: string) =>
    ({
      outDir: outRoot,
      articleOutDir: articleOutRoot,
      maxChars: String(args.publish.maxChars),
      maxTweets: String(args.publish.maxTweets),
      threadDelay: args.publish.threadDelay,
      thread: args.publish.format === "thread",
      target: args.publish.format === "thread" ? "x-thread" : "article",
      publishDryRun: args.publish.publishDryRun || args.stages.publish === "review",
      dryRun: args.publish.publishDryRun || args.stages.publish === "review",
      verbose: args.flags.verbose,
      showProgress: false,
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
          if (args.control.errorStrategy === "stop") {
            finalExitCode = code;
            return finalExitCode;
          }
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
          if (args.control.errorStrategy === "stop") {
            finalExitCode = code;
            return finalExitCode;
          }
        }
      }
    }

    // subtitle burn stage (deferred from acquire — after article, before publish)
    if (deferredBurn) {
      for (const id of videoIds) {
        progress.setActive(`subtitle-burn · ${id}`);
        const t0 = performance.now();
        try {
          await burnSubtitlesForVideo(outRoot, articleOutRoot, id, args.control.force);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ videoId: id, err: message }, "subtitle burn failed");
          // burn 失败不影响已生成的文章
        }
        progress.record(stageTimingKey("subtitle-burn", id), Math.round(performance.now() - t0));
      }
    }

    // deconstruct stage: after article + subtitle burn, before publish
    if (args.deconstruct !== undefined) {
      logger.info(
        { videos: videoIds.length, selectTop: args.deconstruct },
        "yt2x pipeline: deconstruct stage",
      );
      const deconstructDir = path.resolve(monorepoRoot, DEFAULT_ARTICLE_OUT_DIR);
      for (const id of videoIds) {
        progress.setActive(`deconstruct · ${id}`);
        const articleDir = `${deconstructDir}/${id}`;
        const code = await runDeconstructCommand(articleDir, args.deconstruct);
        if (code !== 0) {
          pipelineExit = mergePipelineExitCode(pipelineExit, code);
          if (args.control.errorStrategy === "stop") {
            finalExitCode = code;
            return finalExitCode;
          }
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
          if (args.control.errorStrategy === "stop") {
            finalExitCode = code;
            return finalExitCode;
          }
        }
      }
    }

    logger.info(
      { videos: videoIds.length, outRoot, exitCode: pipelineExit },
      "yt2x pipeline: native orchestrator completed",
    );
    await printPipelineSummaryTable(outRoot, articleOutRoot, videoIds);
    finalExitCode = pipelineExit;
    return finalExitCode;
  } finally {
    if (finalExitCode === 0) {
      progress.printSummary();
    } else {
      progress.clear();
    }
  }
};
