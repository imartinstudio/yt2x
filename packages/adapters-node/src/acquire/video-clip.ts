import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProcessRunner } from "../process/index.js";
import { buildYtDlpArgs } from "./yt-dlp.js";

export type VideoClipMode = "full" | "hottest" | "range";
export type VideoClipSource = "full_video" | "youtube_heatmap" | "fallback_no_heatmap" | "user_range";

export type VideoClipOptions = {
  enabled: boolean;
  videoOnly: boolean;
  durationSeconds: number;
  start?: string;
  end?: string;
};

export type ClipRange = {
  mode: VideoClipMode;
  source: VideoClipSource;
  startSeconds: number;
  endSeconds: number;
  warnings: string[];
};

export type VideoClipManifest = {
  version: 1;
  mode: VideoClipMode;
  source: VideoClipSource;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  file: string;
  format: "mp4";
  warnings: string[];
};

export type DownloadVideoClipOptions = {
  url: string;
  videoDir: string;
  metadata: Record<string, unknown>;
  clip: VideoClipOptions;
  cookiesFromBrowser?: string;
  proxy?: string;
  runner: ProcessRunner;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type VideoClipResult = {
  manifest: VideoClipManifest;
  file: string;
};

export const X_COMPATIBLE_VIDEO_FORMAT =
  "bestvideo[height<=720][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720][ext=mp4][vcodec^=avc1]";

type HeatmapPoint = {
  start_time?: unknown;
  end_time?: unknown;
  value?: unknown;
};

export const parseClipTimestamp = (value: string): number => {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  const parts = trimmed.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(`invalid clip timestamp: ${value}`);
  }
  const numbers = parts.map((part) => {
    if (!/^\d+(?:\.\d+)?$/.test(part)) {
      throw new Error(`invalid clip timestamp: ${value}`);
    }
    return Number(part);
  });
  if (numbers.some((part) => !Number.isFinite(part))) {
    throw new Error(`invalid clip timestamp: ${value}`);
  }
  if (numbers.length === 2) {
    return numbers[0]! * 60 + numbers[1]!;
  }
  return numbers[0]! * 3600 + numbers[1]! * 60 + numbers[2]!;
};

const clampRange = (start: number, requestedDuration: number, duration?: number): { start: number; end: number } => {
  if (duration !== undefined && duration > 0 && duration <= requestedDuration) {
    return { start: 0, end: duration };
  }

  const maxStart = duration !== undefined && duration > 0 ? Math.max(0, duration - requestedDuration) : Infinity;
  const clampedStart = Math.max(0, Math.min(start, maxStart));
  const end = duration !== undefined && duration > 0
    ? Math.min(duration, clampedStart + requestedDuration)
    : clampedStart + requestedDuration;
  return { start: clampedStart, end };
};

const numberFromMetadata = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const readHeatmap = (metadata: Record<string, unknown>): HeatmapPoint[] => {
  const heatmap = metadata.heatmap;
  return Array.isArray(heatmap) ? (heatmap as HeatmapPoint[]) : [];
};

export const selectHottestClipRange = (
  metadata: Record<string, unknown>,
  durationSeconds: number,
): ClipRange => {
  const videoDuration = numberFromMetadata(metadata.duration);
  const heatmap = readHeatmap(metadata);
  let best: { start: number; end: number; value: number } | undefined;

  for (const point of heatmap) {
    const start = numberFromMetadata(point.start_time);
    const end = numberFromMetadata(point.end_time);
    const value = numberFromMetadata(point.value);
    if (start === undefined || end === undefined || value === undefined || end <= start) {
      continue;
    }
    if (best === undefined || value > best.value) {
      best = { start, end, value };
    }
  }

  if (best !== undefined) {
    const center = best.start + (best.end - best.start) / 2;
    const { start, end } = clampRange(center - durationSeconds / 2, durationSeconds, videoDuration);
    return {
      mode: "hottest",
      source: "youtube_heatmap",
      startSeconds: start,
      endSeconds: end,
      warnings: [],
    };
  }

  const fallbackStart = videoDuration !== undefined && videoDuration <= 35 ? 0 : 5;
  const { start, end } = clampRange(fallbackStart, durationSeconds, videoDuration);
  return {
    mode: "hottest",
    source: "fallback_no_heatmap",
    startSeconds: start,
    endSeconds: end,
    warnings: [
      `metadata heatmap unavailable; used fallback range ${secondsToTimestamp(start)}-${secondsToTimestamp(end)}`,
    ],
  };
};

export const resolveClipRange = (
  metadata: Record<string, unknown>,
  clip: VideoClipOptions,
): ClipRange => {
  if (clip.start !== undefined || clip.end !== undefined) {
    if (clip.start === undefined) {
      throw new Error("--video-start is required when --video-end is provided");
    }
    const start = parseClipTimestamp(clip.start);
    const requestedEnd =
      clip.end !== undefined ? parseClipTimestamp(clip.end) : start + clip.durationSeconds;
    let end = requestedEnd;
    const warnings: string[] = [];
    if (end <= start) {
      throw new Error("--video-end must be greater than --video-start");
    }
    const duration = numberFromMetadata(metadata.duration);
    if (duration !== undefined) {
      if (start >= duration) {
        throw new Error("--video-start exceeds video duration");
      }
      if (end > duration) {
        if (clip.end !== undefined) {
          throw new Error("--video-end exceeds video duration");
        }
        end = duration;
        warnings.push(
          `requested duration extends past video end; clamped range to ${secondsToTimestamp(start)}-${secondsToTimestamp(end)}`,
        );
      }
    }
    return {
      mode: "range",
      source: "user_range",
      startSeconds: start,
      endSeconds: end,
      warnings,
    };
  }

  const duration = numberFromMetadata(metadata.duration) ?? 0;
  return {
    mode: "full",
    source: "full_video",
    startSeconds: 0,
    endSeconds: duration,
    warnings:
      duration > 0
        ? []
        : ["metadata duration unavailable; downloaded full video without a fixed end timestamp"],
  };
};

const secondsToTimestamp = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const secondsForYtDlp = (seconds: number): string => {
  const rounded = Math.max(0, Math.round(seconds * 10) / 10);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

const findDownloadedVideoFile = async (videoSubdir: string, basename: string): Promise<string | undefined> => {
  const names = await readdir(videoSubdir).catch(() => []);
  return names
    .filter((name) => new RegExp(`^${basename}\\.(mp4|mkv|webm|mov)$`, "i").test(name))
    .sort((a, b) => (a === `${basename}.mp4` ? -1 : b === `${basename}.mp4` ? 1 : a.localeCompare(b)))[0];
};

const removeExistingVideoFiles = async (videoSubdir: string): Promise<void> => {
  const names = await readdir(videoSubdir).catch(() => []);
  await Promise.all(
    names
      .filter((name) => /^(?:clip|full)\./i.test(name) && name !== "clip-manifest.json")
      .map((name) => rm(path.join(videoSubdir, name), { force: true })),
  );
};

export const downloadVideoClip = async (opts: DownloadVideoClipOptions): Promise<VideoClipResult> => {
  const range = resolveClipRange(opts.metadata, opts.clip);
  const videoSubdir = path.join(opts.videoDir, "video");
  await mkdir(videoSubdir, { recursive: true });
  await removeExistingVideoFiles(videoSubdir);

  const outputBasename = range.mode === "full" ? "full" : "clip";
  const outputPattern = path.join(videoSubdir, `${outputBasename}.%(ext)s`);
  const section = `*${secondsForYtDlp(range.startSeconds)}-${secondsForYtDlp(range.endSeconds)}`;
  const ytdlpBaseArgs = buildYtDlpArgs({
    ...(opts.cookiesFromBrowser !== undefined ? { cookiesFromBrowser: opts.cookiesFromBrowser } : {}),
    ...(opts.proxy !== undefined ? { proxy: opts.proxy } : {}),
  }).slice(1);
  const sectionArgs = range.mode === "full" ? [] : ["--download-sections", section];

  const result = await opts.runner.run({
    command: "yt-dlp",
    args: [
      ...ytdlpBaseArgs,
      "-f",
      X_COMPATIBLE_VIDEO_FORMAT,
      "--merge-output-format",
      "mp4",
      ...sectionArgs,
      "--force-overwrites",
      "-o",
      outputPattern,
      opts.url,
    ],
    timeoutMs: opts.timeoutMs,
    stdio: "pipe",
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `yt-dlp video clip exited ${result.exitCode}: ${result.stderr.slice(0, 1200) || result.stdout.slice(0, 1200)}`,
    );
  }

  const fileName = await findDownloadedVideoFile(videoSubdir, outputBasename);
  if (fileName === undefined) {
    throw new Error("yt-dlp video download did not write video file");
  }
  await access(path.join(videoSubdir, fileName));

  const manifest: VideoClipManifest = {
    version: 1,
    mode: range.mode,
    source: range.source,
    start_seconds: range.startSeconds,
    end_seconds: range.endSeconds,
    duration_seconds: Math.max(0, range.endSeconds - range.startSeconds),
    file: `video/${fileName}`,
    format: "mp4",
    warnings: range.warnings,
  };
  await writeFile(
    path.join(videoSubdir, "clip-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return { manifest, file: manifest.file };
};
