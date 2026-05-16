import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { ProcessRunner } from "../process/index.js";
import { transcriptToChunksMarkdown } from "./clean-chunk-transcript.js";
import { slimVideoMetadata } from "./metadata-slim.js";
import { extractSceneKeyframes } from "./scene-keyframes.js";
import { cuesToMarkdown, parseSubtitleCues } from "./subtitle-to-cues.js";
import { chooseSubtitleFile } from "./subtitle-files.js";
import { downloadSubtitlesTwoPhase } from "./yt-dlp.js";
import { normalizeYoutubeUrl, sanitizeVideoId, videoIdFromUrl } from "./video-id-from-url.js";
import { youtubeSubLangBase } from "./youtube-sub-lang.js";
import { ensureOfficialYoutubeThumbnail, fetchVideoMetadata, type YtDlpOptions } from "./yt-dlp.js";
import type { AcquireProgressCallbacks } from "./acquire-progress.js";

export type PrepareYoutubeVideoOptions = {
  url: string;
  outDir: string;
  maxWords: number;
  keyframes: number;
  sceneThreshold: number;
  sceneMinGap: number;
  subLangs?: string;
  cookiesFromBrowser?: string;
  proxy?: string;
  skipPreflight?: boolean;
  runner: ProcessRunner;
  timeoutMs: number;
  signal?: AbortSignal;
  verbose?: boolean;
  progress?: AcquireProgressCallbacks;
};

export type PrepareYoutubeVideoResult = {
  url: string;
  dir: string;
  ok: boolean;
  warnings: string[];
  video_id?: string;
  title?: unknown;
  subtitle?: string;
  youtube_cover?: string;
  /** 各子步骤耗时（毫秒），便于排查慢点 */
  timingsMs?: Record<string, number>;
};

const logStep = (opts: PrepareYoutubeVideoOptions, message: string): void => {
  if (opts.verbose === true) {
    console.log(`     ${message}`);
  }
};

const timedStep = async <T>(
  opts: PrepareYoutubeVideoOptions,
  label: string,
  timings: Record<string, number>,
  fn: () => Promise<T>,
): Promise<T> => {
  logStep(opts, `${label}…`);
  opts.progress?.onStepStart?.(label);
  const t0 = performance.now();
  try {
    const value = await fn();
    const ms = Math.round(performance.now() - t0);
    timings[label] = ms;
    opts.progress?.onStepEnd?.(label, ms);
    if (opts.verbose === true) {
      console.log(`     ${label} done (${(ms / 1000).toFixed(1)}s)`);
    }
    return value;
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    timings[label] = ms;
    opts.progress?.onStepEnd?.(label, ms);
    if (opts.verbose === true) {
      console.error(`     ${label} failed (${(ms / 1000).toFixed(1)}s)`);
    }
    throw err;
  }
};

const writeTranscriptArtifacts = async (
  subtitlePath: string,
  videoDir: string,
  maxWords: number,
): Promise<void> => {
  const text = await readFile(subtitlePath, "utf8");
  const cues = parseSubtitleCues(text);
  await writeFile(path.join(videoDir, "timestamped-cues.md"), cuesToMarkdown(cues), "utf8");
  await writeFile(
    path.join(videoDir, "chunks.md"),
    transcriptToChunksMarkdown(text, maxWords),
    "utf8",
  );
};

const removeOrphanVideoDir = async (dir: string): Promise<void> => {
  try {
    await access(path.join(dir, "metadata.json"));
  } catch {
    await rm(dir, { recursive: true, force: true });
  }
};

export const prepareYoutubeVideo = async (
  opts: PrepareYoutubeVideoOptions,
): Promise<PrepareYoutubeVideoResult> => {
  const timingsMs: Record<string, number> = {};
  const pageUrl = normalizeYoutubeUrl(opts.url);
  const fallbackId = videoIdFromUrl(pageUrl);
  let videoId = fallbackId;
  let videoDir = path.join(opts.outDir, videoId);

  const result: PrepareYoutubeVideoResult = {
    url: pageUrl,
    dir: videoDir,
    ok: false,
    warnings: [],
    timingsMs,
  };

  const ytdlpOpts: YtDlpOptions = {
    runner: opts.runner,
    timeoutMs: opts.timeoutMs,
    ...(opts.cookiesFromBrowser !== undefined && opts.cookiesFromBrowser.length > 0
      ? { cookiesFromBrowser: opts.cookiesFromBrowser }
      : {}),
    ...(opts.proxy !== undefined && opts.proxy.length > 0 ? { proxy: opts.proxy } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };

  let metadata: Record<string, unknown> = {};
  try {
    metadata = await timedStep(opts, "metadata", timingsMs, () =>
      fetchVideoMetadata(pageUrl, ytdlpOpts),
    );
    videoId = sanitizeVideoId(String(metadata.id ?? fallbackId));
    const previousDir = videoDir;
    videoDir = path.join(opts.outDir, videoId);
    result.dir = videoDir;
    await mkdir(videoDir, { recursive: true });
    if (previousDir !== videoDir) {
      await removeOrphanVideoDir(previousDir);
    }
    const slim = slimVideoMetadata(metadata);
    await writeFile(
      path.join(videoDir, "metadata.json"),
      `${JSON.stringify(slim, null, 2)}\n`,
      "utf8",
    );
    result.video_id = videoId;
    result.title = slim.title;
  } catch (err: unknown) {
    await mkdir(videoDir, { recursive: true });
    const message = err instanceof Error ? err.message : String(err);
    result.warnings.push(`metadata failed: ${message}`);
  }

  const videoLanguage = String(metadata.language ?? "en").trim() || "en";
  const subLangBase = youtubeSubLangBase(videoLanguage);
  let manualSubLangs = (opts.subLangs ?? "").trim();
  if (manualSubLangs.length === 0) {
    // 当 language 缺失时（YouTube 常见），多试几种常见语言提高命中率
    const langs = [...new Set([`${subLangBase}-orig`, subLangBase, "zh-Hans", "zh", "en"])];
    manualSubLangs = langs.join(",");
  }

  try {
    await timedStep(opts, "subtitles", timingsMs, async () => {
      const { manualOk, autoOk } = await downloadSubtitlesTwoPhase(pageUrl, videoDir, {
        ...ytdlpOpts,
        videoLanguage,
        manualSubLangs,
      });
      if (!manualOk && !autoOk) {
        result.warnings.push(
          "no subtitles were downloaded (manual and automatic attempts produced no new files)",
        );
      } else if (!manualOk && autoOk) {
        result.warnings.push("manual captions missing; used automatic captions as fallback");
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.warnings.push(`subtitle download failed: ${message}`);
  }

  const subtitle = await chooseSubtitleFile(videoDir, videoLanguage);
  if (subtitle !== null) {
    result.subtitle = subtitle;
    try {
      await timedStep(opts, "transcript", timingsMs, () =>
        writeTranscriptArtifacts(subtitle, videoDir, opts.maxWords),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.warnings.push(`transcript processing failed: ${message}`);
    }
  } else {
    result.warnings.push("no subtitle file found");
  }

  if (opts.keyframes > 0) {
    const cuesPath = path.join(videoDir, "timestamped-cues.md");
    let cuesFile: string | undefined;
    try {
      await access(cuesPath);
      cuesFile = cuesPath;
    } catch {
      cuesFile = undefined;
    }
    const videoDuration =
      typeof metadata.duration === "number" ? metadata.duration : undefined;
    const sceneWarnings = await timedStep(opts, "scene-keyframes", timingsMs, () =>
      extractSceneKeyframes({
        source: pageUrl,
        outputDir: path.join(videoDir, "screenshots"),
        ...(cuesFile !== undefined ? { cuesPath: cuesFile } : {}),
        ...(videoDuration !== undefined ? { duration: videoDuration } : {}),
        threshold: opts.sceneThreshold,
        minGap: opts.sceneMinGap,
        maxFrames: opts.keyframes,
        runner: opts.runner,
        timeoutMs: opts.timeoutMs,
        ...(opts.cookiesFromBrowser !== undefined && opts.cookiesFromBrowser.length > 0
          ? { cookiesFromBrowser: opts.cookiesFromBrowser }
          : {}),
        ...(opts.proxy !== undefined && opts.proxy.length > 0 ? { proxy: opts.proxy } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      }),
    );
    result.warnings.push(...sceneWarnings);
  }

  await timedStep(opts, "thumbnail", timingsMs, async () => {
    const cover = await ensureOfficialYoutubeThumbnail(pageUrl, videoDir, ytdlpOpts, result.warnings);
    if (cover !== undefined) {
      result.youtube_cover = cover;
    }
  });

  const required = ["metadata.json", "chunks.md", "timestamped-cues.md"] as const;
  const missing: string[] = [];
  for (const name of required) {
    try {
      await access(path.join(videoDir, name));
    } catch {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    result.warnings.push(`missing required artifacts: ${missing.join(", ")}`);
    result.ok = false;
  } else {
    result.ok = true;
  }

  await writeFile(
    path.join(videoDir, "prepare-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );

  if (opts.verbose === true && Object.keys(timingsMs).length > 0) {
    const parts = Object.entries(timingsMs)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}s`);
    console.log(`     acquire timings: ${parts.join(", ")}`);
  }

  return result;
};
