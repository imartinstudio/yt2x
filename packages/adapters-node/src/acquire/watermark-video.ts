import { access, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessRunner } from "../process/index.js";
import { resolvePythonWithPillow } from "./resolve-python.js";
import {
  formatProcessFailure,
  WATERMARK_SCRIPT,
  WATERMARK_X,
  WATERMARK_Y,
} from "./burn-bilingual-subtitles.js";

export type OverlayWatermarkOptions = {
  /** Source video to attribute. Never written to. */
  inputPath: string;
  /** Destination path; re-encoded video only, audio is stream-copied. */
  outputPath: string;
  runner: ProcessRunner;
  /** Source channel handle, rendered as 「视频：」 (e.g. @nateherk) */
  watermarkVideo?: string;
  /** Subtitle author handle, rendered as 「字幕：」 (e.g. @php_martin) */
  watermarkSubtitler?: string;
  /** Overwrite an existing output instead of skipping. */
  force?: boolean;
  signal?: AbortSignal;
};

export type OverlayWatermarkResult = {
  outputPath: string;
  /** True when an existing output was kept and ffmpeg never ran. */
  skipped: boolean;
};

/**
 * Composite the standard top-left watermark onto a video on its own, without the
 * subtitle strips `burnBilingualSubtitles` would also render. Same PNG generator,
 * same overlay offset, so a video attributed here is indistinguishable from one
 * attributed during a subtitle or dub burn.
 */
export const overlayWatermarkOnVideo = async (
  opts: OverlayWatermarkOptions,
): Promise<OverlayWatermarkResult> => {
  const hasVideo = (opts.watermarkVideo ?? "").trim().length > 0;
  const hasSubtitler = (opts.watermarkSubtitler ?? "").trim().length > 0;
  if (!hasVideo && !hasSubtitler) {
    throw new Error(
      "watermark needs at least one handle: pass --watermark-video and/or --watermark-subtitler",
    );
  }

  if (opts.force !== true) {
    const exists = await access(opts.outputPath).then(
      () => true,
      () => false,
    );
    if (exists) return { outputPath: opts.outputPath, skipped: true };
  }

  const workDir = path.join(os.tmpdir(), `yt2x-watermark-${process.pid}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  const pngPath = path.join(workDir, "watermark.png");

  try {
    const pythonBin = await resolvePythonWithPillow();
    const wmArgs = [WATERMARK_SCRIPT, pngPath];
    if (hasVideo) wmArgs.push("--watermark-video", opts.watermarkVideo!);
    if (hasSubtitler) wmArgs.push("--watermark-subtitler", opts.watermarkSubtitler!);

    let wmResult;
    try {
      wmResult = await opts.runner.run({
        command: pythonBin,
        args: wmArgs,
        timeoutMs: 15_000,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    } catch (err: unknown) {
      throw new Error(`watermark generation failed: ${formatProcessFailure(err)}`, { cause: err });
    }
    if (wmResult.exitCode !== 0) {
      throw new Error(`watermark generation failed: ${wmResult.stderr ?? "unknown error"}`);
    }

    await mkdir(path.dirname(opts.outputPath), { recursive: true });

    // `-loop 1` produces an endless stream; `-shortest` is the obvious bound but
    // hangs/aborts on macOS in this combination (same reason the subtitle burn
    // passes an explicit `-t`), so take the duration from the source instead.
    const probe = await opts.runner.run({
      command: "ffprobe",
      args: [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        opts.inputPath,
      ],
      timeoutMs: 15_000,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const duration = parseFloat((probe.stdout ?? "").trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`could not read a duration for ${opts.inputPath} — refusing to encode an unbounded stream`);
    }

    // Audio is stream-copied: this pass only touches the video track, so a dubbed
    // or remixed track keeps whatever encoding it already had.
    const ffmpegArgs = [
      "-i", opts.inputPath,
      "-loop", "1", "-i", pngPath,
      "-filter_complex",
      `[0:v][1:v]overlay=${WATERMARK_X}:${WATERMARK_Y}[v];[v]format=yuv420p[vfinal]`,
      "-map", "[vfinal]", "-map", "0:a?",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-profile:v", "high", "-level", "4.0",
      "-c:a", "copy",
      "-t", String(duration),
      "-movflags", "+faststart",
      "-y", opts.outputPath,
    ];

    let result;
    try {
      result = await opts.runner.run({
        command: "ffmpeg",
        args: ffmpegArgs,
        timeoutMs: 30 * 60_000,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    } catch (err: unknown) {
      throw new Error(`ffmpeg watermark overlay failed: ${formatProcessFailure(err)}`, { cause: err });
    }
    if (result.exitCode !== 0) {
      const excerpt = (result.stderr ?? "").split("\n").slice(-20).join("\n");
      throw new Error(`ffmpeg watermark overlay failed with exit code ${result.exitCode}: ${excerpt}`);
    }

    return { outputPath: opts.outputPath, skipped: false };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};
