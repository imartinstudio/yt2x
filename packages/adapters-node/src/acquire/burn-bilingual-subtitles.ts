import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ProcessRunner } from "../process/index.js";
import { validateSrtIntegrity, verifyBurnedSubtitles } from "./burn-subtitles.js";

export type BurnBilingualSubtitlesOptions = {
  /** Path to the bilingual ASS file */
  assPath: string;
  /** Path to the source video MP4 */
  videoPath: string;
  /** Output path for the burned MP4 */
  outputPath: string;
  /** Process runner for ffmpeg */
  runner: ProcessRunner;
  /** English SRT path for mtime comparison */
  enSrtPath: string;
  /** Chinese SRT path for mtime comparison */
  zhSrtPath: string;
  /** Force re-burn even if output exists and is newer */
  force?: boolean;
  /** Fonts directory for ffmpeg libass */
  fontsDir?: string;
  /** Abort signal */
  signal?: AbortSignal;
};

export type BurnBilingualSubtitlesResult = {
  burned: boolean;
  skipped: boolean;
  skipReason?: "already_exists" | "missing_ass" | "missing_video" | "stale_burned_removed";
  warnings: string[];
};

/**
 * Escape a filesystem path for use in ffmpeg's subtitles filter.
 *
 * ffmpeg subtitles filter uses `:` as the option separator. Paths containing
 * `:` must be escaped with `\:`. On Windows, drive letters like `C:\` cause
 * issues; on macOS/Linux, colons in filenames are rare but possible.
 *
 * We also replace single backslashes with forward slashes for cross-platform
 * compatibility in the filter string.
 */
const escapeFilterPath = (p: string): string => {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
};

/**
 * Burn bilingual ASS subtitles into a video using ffmpeg.
 *
 * Uses ffmpeg's subtitles filter with libass to burn styled bilingual
 * subtitles (Chinese on top, English on bottom) directly into the video.
 *
 * This is an independent ASS-burning path that does NOT replace the
 * existing PNG-based `burnSubtitles` used for single-language Chinese
 * subtitles.
 *
 * Force / mtime logic:
 * - `force: true` → unconditionally re-burn
 * - `force: false` (default) → skip if output exists and is newer than
 *   all source files (ASS, EN SRT, ZH SRT)
 * - If any source file is newer than the output, delete stale output
 *   and re-burn.
 */
export const burnBilingualSubtitles = async (
  opts: BurnBilingualSubtitlesOptions,
): Promise<BurnBilingualSubtitlesResult> => {
  const warnings: string[] = [];

  // Verify ASS file exists
  try {
    await access(opts.assPath);
  } catch {
    return { burned: false, skipped: true, skipReason: "missing_ass", warnings };
  }

  // Verify video file exists
  try {
    await access(opts.videoPath);
  } catch {
    return { burned: false, skipped: true, skipReason: "missing_video", warnings };
  }

  // Ensure output directory exists
  await mkdir(path.dirname(opts.outputPath), { recursive: true });

  const force = opts.force === true;

  // Check if we can skip the burn
  if (!force) {
    try {
      await access(opts.outputPath);
      const [outputStat, assStat, enStat, zhStat] = await Promise.all([
        stat(opts.outputPath),
        stat(opts.assPath),
        stat(opts.enSrtPath),
        stat(opts.zhSrtPath),
      ]);

      const outputMtime = outputStat.mtimeMs;
      if (
        assStat.mtimeMs <= outputMtime &&
        enStat.mtimeMs <= outputMtime &&
        zhStat.mtimeMs <= outputMtime
      ) {
        return {
          burned: false,
          skipped: true,
          skipReason: "already_exists",
          warnings,
        };
      }

      // Source is newer — remove stale output and re-burn
      const { rm } = await import("node:fs/promises");
      await rm(opts.outputPath).catch(() => {});
    } catch {
      // Output doesn't exist — proceed with burn
    }
  }

  // Validate SRT integrity before burning
  for (const srtPath of [opts.enSrtPath, opts.zhSrtPath]) {
    const integrity = await validateSrtIntegrity(srtPath);
    if (!integrity.valid) {
      const fatal = integrity.issues.filter(
        (i) => i.kind === "overlap" || i.kind === "negative_duration" || i.kind === "no_cues",
      );
      if (fatal.length > 0) {
        throw new Error(
          `SRT integrity check failed for ${path.basename(srtPath)}:\n${fatal.map((i) => `  - ${i.message}`).join("\n")}`,
        );
      }
    }
  }

  // Font discovery warning
  if (opts.fontsDir === undefined) {
    warnings.push(
      "no fontsDir provided; ffmpeg/libass may not find CJK fonts. " +
        "Specify fontsDir to ensure Chinese characters render correctly.",
    );
  }

  // Build ffmpeg subtitles filter
  // Escape the ASS path for the filter string (colons must be \:)
  const escapedAssPath = escapeFilterPath(opts.assPath);
  let subtitlesFilter = `subtitles=${escapedAssPath}`;
  if (opts.fontsDir !== undefined) {
    const escapedFontsDir = escapeFilterPath(opts.fontsDir);
    subtitlesFilter += `:fontsdir=${escapedFontsDir}`;
  }

  const ffmpegArgs = [
    "-i", opts.videoPath,
    "-vf", subtitlesFilter,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level", "4.0",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-y", opts.outputPath,
  ];

  const result = await opts.runner.run({
    command: "ffmpeg",
    args: ffmpegArgs,
    timeoutMs: 30 * 60_000,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  if (result.exitCode !== 0) {
    const excerpt = (result.stderr ?? "").split("\n").slice(-20).join("\n");
    throw new Error(`ffmpeg bilingual subtitle burn failed with exit code ${result.exitCode}: ${excerpt}`);
  }

  // Post-burn verification: compare burned output against original video
  try {
    const verification = await verifyBurnedSubtitles(
      opts.outputPath,
      opts.videoPath,
      opts.enSrtPath,
      opts.runner,
      opts.signal,
    );

    if (!verification.passed) {
      const failedChecks = verification.checks.filter((c) => !c.passed);
      const details = failedChecks
        .map((c) => `  - ${c.position} (@${c.timestamp.toFixed(1)}s): ${c.detail}`)
        .join("\n");
      warnings.push(
        `post-burn verification: ${failedChecks.length}/${verification.checks.length} check(s) did not pass:\n${details}`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`post-burn verification failed: ${message}`);
  }

  return { burned: true, skipped: false, warnings };
};
