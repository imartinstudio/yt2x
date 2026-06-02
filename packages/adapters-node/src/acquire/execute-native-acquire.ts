import path from "node:path";
import { access, readFile } from "node:fs/promises";
import type { LlmPort, PipelineStep } from "@yt2x/core";
import { defaultProcessRunner, isProcessError, type ProcessRunner } from "../process/index.js";
import { isStepDone, markStepDone, markStepFailed } from "../fs/process-status-store.js";
import { resolveAcquireVideoQueue, validateArtifacts } from "./batch-queue.js";
import type { AcquireSubStepProgress } from "./acquire-progress.js";
import { prepareYoutubeVideo } from "./prepare-youtube-video.js";
import { sanitizeVideoId } from "./video-id-from-url.js";
import type { SearchSort } from "../youtube/search.js";

/** 长视频采集可能较久（默认 30 分钟级超时） */
export const DEFAULT_NATIVE_ACQUIRE_TIMEOUT_MS = 30 * 60_000;

export type NativeAcquireStageModes = Record<PipelineStep, "auto" | "review" | "skip">;

export type NativeAcquireOptions = {
  monorepoRoot: string;
  /** 已 resolve 的绝对输出根目录 */
  outDir: string;
  sources: {
    urls: string[];
    urlFile?: string;
    search?: string;
    searchSort?: SearchSort;
  };
  acquire: {
    keyframes: number;
    sceneThreshold: number;
    sceneMinGap: number;
    maxWords: number;
    jobs: number;
    subLangs?: string;
    cookiesFromBrowser?: string;
    proxy?: string;
    downloadVideo?: boolean;
    videoOnly?: boolean;
    videoStart?: string;
    videoEnd?: string;
    videoDuration?: number;
    subtitleZh?: "off" | "srt" | "burned" | "both";
    subtitleSourceLang?: string;
    subtitleTargetLang?: string;
    subtitleSource?: "auto" | "youtube" | "transcribe" | "file";
    subtitleFile?: string;
  };
  stages: NativeAcquireStageModes;
  control: {
    continueFlag: boolean;
    errorStrategy: "stop" | "skip";
    force?: boolean;
  };
  flags: { verbose: boolean };
  llm?: LlmPort;
  llmModel?: string;
  runner?: ProcessRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** When set, burned subtitle video is routed here instead of outDir. */
  articleOutDir?: string;
  /**
   * `stages.acquire === "review"` 时，每完成一个视频的采集后调用。
   * 返回 `quit` / `no` 时中止后续视频（退出码 0，与 legacy 一致）。
   */
  reviewPrompt?: (videoId: string) => Promise<"yes" | "no" | "quit">;
  progress?: AcquireSubStepProgress;
};

const doneArtifacts = ["metadata.json", "chunks.md", "timestamped-cues.md"];
const videoOnlyDoneArtifacts = ["metadata.json", "video/clip-manifest.json"];

const validateVideoOnlyArtifacts = async (videoDir: string): Promise<boolean> => {
  for (const file of videoOnlyDoneArtifacts) {
    try {
      await access(path.join(videoDir, file));
    } catch {
      return false;
    }
  }
  return true;
};

const firstNonEmptyLines = (input: string, maxLines: number): string[] =>
  input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines);

const canUseColor = (): boolean => process.stderr.isTTY === true && process.env.NO_COLOR === undefined;

const style = (code: string, text: string): string =>
  canUseColor() ? `\u001b[${code}m${text}\u001b[0m` : text;

const bold = (text: string): string => style("1", text);
const red = (text: string): string => style("31;1", text);
const yellow = (text: string): string => style("33;1", text);
const cyan = (text: string): string => style("36;1", text);

const looksLikeYoutubeAuthFailure = (detail: string): boolean =>
  /sign in|not a bot|confirm.*bot|cookies-from-browser|cookies|login|age[- ]?restricted|private video/i.test(
    detail,
  );

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const retryAcquireCommand = (videoUrl: string): string =>
  `pnpm yt2x acquire --urls ${shellQuote(videoUrl)} --cookies-from-browser chrome`;

const printAcquireFailure = (
  videoId: string,
  videoDir: string,
  videoUrl: string,
  detail: string,
): void => {
  const summary = firstNonEmptyLines(detail, 5);
  const statusPath = path.join(videoDir, "process-status.json");
  const authFailure = looksLikeYoutubeAuthFailure(detail);

  if (process.stderr.isTTY === true) {
    process.stderr.write("\n");
  }
  console.error(red(`ERROR yt2x acquire failed for ${videoId}`));
  console.error("");
  console.error(bold("Reason:"));
  for (const line of summary) {
    console.error(`  ${line}`);
  }
  console.error("");
  console.error(`${bold("Details:")} ${statusPath}`);
  console.error("");
  console.error(bold("Hint:"));
  if (authFailure) {
    console.error(
      `  ${yellow(
        "YouTube requires sign-in or bot verification. This usually means yt-dlp needs browser cookies, not that yt2x crashed.",
      )}`,
    );
    console.error(`  Retry with ${cyan("--cookies-from-browser chrome")} after signing in to YouTube in Chrome.`);
    console.error("");
    console.error(cyan(retryAcquireCommand(videoUrl)));
  } else {
    console.error(`  Check the details file, or rerun with ${cyan("--verbose")} for fuller logs.`);
  }
};

const shouldSkipAcquireForVideo = async (
  outDir: string,
  rawVideoId: string,
  acquire: NativeAcquireOptions["acquire"],
  force: boolean,
): Promise<boolean> => {
  if (force) {
    return false;
  }
  const videoId = sanitizeVideoId(rawVideoId);
  const videoDir = path.join(outDir, videoId);
  const videoOnly = acquire.videoOnly ?? false;
  if (await isStepDone(videoDir, "acquire")) {
    if (videoOnly) {
      if (acquire.videoStart !== undefined || acquire.videoEnd !== undefined) {
        return false;
      }
      try {
        const raw = await readFile(path.join(videoDir, "video", "clip-manifest.json"), "utf8");
        const manifest = JSON.parse(raw) as { duration_seconds?: unknown; mode?: unknown };
        if (manifest.mode === "full") {
          return validateVideoOnlyArtifacts(videoDir);
        }
        const requestedDuration = acquire.videoDuration ?? 30;
        if (
          typeof manifest.duration_seconds === "number" &&
          Math.abs(manifest.duration_seconds - requestedDuration) > 1
        ) {
          return false;
        }
      } catch {
        return false;
      }
      return validateVideoOnlyArtifacts(videoDir);
    }
    return validateArtifacts(videoDir, "acquire");
  }
  return false;
};

/**
 * Native acquire：解析来源或扫描已有目录 → 对每个视频执行 Node 采集（yt-dlp + ffmpeg）；
 * 步骤仅写 `process-status.json`（无根级 state 文件）。
 * 由 `yt2x acquire` / `yt2x pipeline` 默认路径调用。
 */
export const executeNativeAcquire = async (opts: NativeAcquireOptions): Promise<number> => {
  const runner = opts.runner ?? defaultProcessRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_NATIVE_ACQUIRE_TIMEOUT_MS;
  const { outDir, stages, control, flags, acquire } = opts;
  const downloadVideo = acquire.downloadVideo ?? true;
  const videoOnly = acquire.videoOnly ?? false;
  const videoDuration = acquire.videoDuration ?? 30;

  if (stages.acquire === "skip") {
    return 0;
  }

  const queue = await resolveAcquireVideoQueue({
    outDir,
    continueFlag: control.continueFlag,
    sources: {
      urls: opts.sources.urls,
      ...(opts.sources.urlFile !== undefined ? { urlFile: opts.sources.urlFile } : {}),
      ...(opts.sources.search !== undefined ? { search: opts.sources.search } : {}),
      ...(opts.sources.searchSort !== undefined ? { searchSort: opts.sources.searchSort } : {}),
      ...(acquire.cookiesFromBrowser !== undefined
        ? { cookiesFromBrowser: acquire.cookiesFromBrowser }
        : {}),
    },
  });

  if (queue === null || queue.length === 0) {
    return 1;
  }

  for (const video of queue) {
    const videoId = sanitizeVideoId(video.video_id);
    if (await shouldSkipAcquireForVideo(outDir, videoId, acquire, control.force === true)) {
      continue;
    }

    const plannedVideoDir = path.join(outDir, videoId);

    if (flags.verbose) {
      console.log(`     acquire ${video.url} → ${plannedVideoDir}`);
    }

    const stepProgress =
      opts.progress !== undefined
        ? {
            onStepStart: (stepKey: string) => {
              opts.progress?.onSubStepStart?.(videoId, stepKey);
            },
            onStepEnd: (stepKey: string, durationMs: number) => {
              opts.progress?.onSubStepEnd?.(videoId, stepKey, durationMs);
            },
          }
        : undefined;

    try {
      const result = await prepareYoutubeVideo({
        url: video.url,
        outDir,
        maxWords: acquire.maxWords,
        keyframes: acquire.keyframes,
        sceneThreshold: acquire.sceneThreshold,
        sceneMinGap: acquire.sceneMinGap,
        skipPreflight: true,
        verbose: flags.verbose,
        ...(stepProgress !== undefined ? { progress: stepProgress } : {}),
        ...(acquire.subLangs !== undefined && acquire.subLangs.length > 0
          ? { subLangs: acquire.subLangs }
          : {}),
        ...(acquire.cookiesFromBrowser !== undefined && acquire.cookiesFromBrowser.length > 0
          ? { cookiesFromBrowser: acquire.cookiesFromBrowser }
          : {}),
        ...(acquire.proxy !== undefined && acquire.proxy.length > 0 ? { proxy: acquire.proxy } : {}),
        videoClip: {
          enabled: downloadVideo || videoOnly,
          videoOnly,
          durationSeconds: videoDuration,
          ...(acquire.videoStart !== undefined ? { start: acquire.videoStart } : {}),
          ...(acquire.videoEnd !== undefined ? { end: acquire.videoEnd } : {}),
        },
        videoSubtitles: {
          mode: acquire.subtitleZh ?? "off",
          sourceLang: acquire.subtitleSourceLang ?? "en",
          targetLang: acquire.subtitleTargetLang ?? "zh-CN",
          source: acquire.subtitleSource ?? "auto",
          ...(acquire.subtitleFile !== undefined ? { file: acquire.subtitleFile } : {}),
        },
        ...(opts.llm !== undefined ? { llm: opts.llm } : {}),
        ...(opts.llmModel !== undefined ? { llmModel: opts.llmModel } : {}),
        ...(opts.articleOutDir !== undefined ? { burnedVideoOutDir: opts.articleOutDir } : {}),
        ...(opts.control.force !== undefined ? { force: opts.control.force } : {}),
        runner,
        timeoutMs,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });

      const videoDir = result.dir;
      if (flags.verbose && videoDir !== plannedVideoDir) {
        console.log(
          `     acquire wrote to ${videoDir} (YouTube id from metadata differs from URL id ${videoId})`,
        );
      }

      if (!result.ok) {
        const detail =
          result.warnings.length > 0
            ? result.warnings.join("\n")
            : "prepare finished without required artifacts (metadata.json, chunks.md, timestamped-cues.md)";
        await markStepFailed(videoDir, "acquire", detail);
        printAcquireFailure(videoId, videoDir, video.url, detail);
        if (control.errorStrategy === "stop") {
          return 1;
        }
        continue;
      }

      const artifactsValid = videoOnly
        ? await validateVideoOnlyArtifacts(videoDir)
        : await validateArtifacts(videoDir, "acquire");
      if (!artifactsValid) {
        const detail = `acquire reported ok but artifacts are missing under ${videoDir}`;
        await markStepFailed(videoDir, "acquire", detail);
        printAcquireFailure(videoId, videoDir, video.url, detail);
        if (control.errorStrategy === "stop") {
          return 1;
        }
        continue;
      }

      await markStepDone(videoDir, "acquire", videoOnly ? videoOnlyDoneArtifacts : doneArtifacts);

      if (stages.acquire === "review" && opts.reviewPrompt !== undefined) {
        const answer = await opts.reviewPrompt(videoId);
        if (answer === "quit" || answer === "no") {
          return 0;
        }
      }
    } catch (err: unknown) {
      const message = isProcessError(err)
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      const stderr = isProcessError(err) ? (err.context.stderrExcerpt ?? "") : "";
      const detail = stderr.length > 0 ? `${message}\n${stderr}` : message;
      await markStepFailed(plannedVideoDir, "acquire", detail);
      printAcquireFailure(videoId, plannedVideoDir, video.url, detail);
      if (control.errorStrategy === "stop") {
        return 1;
      }
    }
  }

  return 0;
};
