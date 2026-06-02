import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { burnSubtitles } from "./burn-subtitles.js";
import { detectBurnedSubtitles, type DetectBurnedSubtitlesResult } from "./detect-burned-subs.js";
import type { ProcessRunner } from "../process/index.js";

export type BurnZhSubtitlesSkipReason =
  | "missing_zh_srt"
  | "missing_mp4"
  | "already_exists"
  | "chinese_burned_detected"
  | "stale_burned_removed";

export type BurnZhSubtitlesForVideoOptions = {
  /** 采集根目录，例如 files/downloads/<videoId> */
  videoDir: string;
  runner: ProcessRunner;
  /** 烧录输出根目录；默认写入 videoDir/video/ */
  burnedVideoOutDir?: string;
  /** 原片已有中文硬字幕时跳过烧录（默认 true） */
  skipIfChineseBurned?: boolean;
  signal?: AbortSignal;
  /** 强制重新烧录，覆盖已有 burnt video 并跳过硬字幕检测 */
  force?: boolean;
};

export type BurnZhSubtitlesForVideoResult = {
  burned: boolean;
  skipped: boolean;
  skipReason?: BurnZhSubtitlesSkipReason;
  burnedPath?: string;
  detect?: DetectBurnedSubtitlesResult;
};

const subtitleManifestPath = (videoDir: string): string =>
  path.join(videoDir, "video", "subtitle-manifest.json");

const updateBurnedVideoInManifest = async (
  videoDir: string,
  burnedPath: string,
): Promise<void> => {
  const manifestPath = subtitleManifestPath(videoDir);
  try {
    const existing = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    existing.burned_video = burnedPath;
    await writeFile(manifestPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
  } catch {
    /* manifest 可能不存在 */
  }
};

/**
 * 将 full.zh.srt 烧录进 MP4，输出 full.zh-burned.mp4。
 * 可选检测原片是否已有中文硬字幕并跳过。
 */
export const burnZhSubtitlesForVideo = async (
  opts: BurnZhSubtitlesForVideoOptions,
): Promise<BurnZhSubtitlesForVideoResult> => {
  const videoSubdir = path.join(opts.videoDir, "video");
  const zhSrtPath = path.join(videoSubdir, "full.zh.srt");
  const skipIfChineseBurned = opts.skipIfChineseBurned !== false;

  try {
    await access(zhSrtPath);
  } catch {
    return { burned: false, skipped: true, skipReason: "missing_zh_srt" };
  }

  const names = await readdir(videoSubdir).catch(() => [] as string[]);
  const mp4File = names.find((n) => /\.mp4$/i.test(n) && !/\.zh-burned\.mp4$/i.test(n));
  if (mp4File === undefined) {
    return { burned: false, skipped: true, skipReason: "missing_mp4" };
  }

  const videoId = path.basename(opts.videoDir);
  const burnedSubdir =
    opts.burnedVideoOutDir !== undefined
      ? path.join(opts.burnedVideoOutDir, videoId, "video")
      : videoSubdir;
  const burnedPath = path.join(burnedSubdir, "full.zh-burned.mp4");

  const force = opts.force === true;

  try {
    await access(burnedPath);
    if (force) {
      // --force: unconditionally remove stale burned video and re-burn
      await rm(burnedPath).catch(() => {});
    } else {
      // Burned video exists — check if SRT is newer (e.g. after translation fix).
      // If the SRT was updated, the stale burned video must be re-generated.
      const [srtStat, burnedStat] = await Promise.all([
        stat(zhSrtPath),
        stat(burnedPath),
      ]);
      if (srtStat.mtimeMs <= burnedStat.mtimeMs) {
        await updateBurnedVideoInManifest(opts.videoDir, burnedPath);
        return { burned: false, skipped: true, skipReason: "already_exists", burnedPath };
      }
      // SRT is newer — remove stale burned video and re-burn
      await rm(burnedPath).catch(() => {});
    }
  } catch {
    /* continue */
  }

  const videoPath = path.join(videoSubdir, mp4File);
  let detect: DetectBurnedSubtitlesResult | undefined;

  if (skipIfChineseBurned && !force) {
    detect = await detectBurnedSubtitles(videoPath, opts.runner, {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (detect.shouldSkipBurn) {
      return {
        burned: false,
        skipped: true,
        skipReason: "chinese_burned_detected",
        detect,
      };
    }
  }

  await mkdir(burnedSubdir, { recursive: true });
  await burnSubtitles({
    videoPath,
    srtPath: zhSrtPath,
    outputPath: burnedPath,
    runner: opts.runner,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  await updateBurnedVideoInManifest(opts.videoDir, burnedPath);

  return {
    burned: true,
    skipped: false,
    burnedPath,
    ...(detect !== undefined ? { detect } : {}),
  };
};
