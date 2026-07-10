import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessError, type ProcessRunner } from "../process/index.js";
import { validateSrtIntegrity, verifyBurnedSubtitles } from "./burn-subtitles.js";
import { resolvePythonWithPillow } from "./resolve-python.js";

export type BurnBilingualSubtitlesOptions = {
  /** Path to the bilingual SRT file (for PNG rendering) */
  srtPath: string;
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
  /** Abort signal */
  signal?: AbortSignal;
  /** YouTube channel handle for watermark (e.g. @nateherk) */
  watermarkVideo?: string;
  /** Translator handle for watermark (e.g. @php_martin) */
  watermarkXlate?: string;
};

export type BurnBilingualSubtitlesResult = {
  burned: boolean;
  skipped: boolean;
  skipReason?: "already_exists" | "missing_srt" | "missing_video";
  warnings: string[];
};

type CueManifestEntry = {
  index: number;
  filename: string;
  start: number;
  end: number;
  width: number;
  height: number;
};

type RenderManifest = {
  cues: CueManifestEntry[];
  video_width: number;
  video_height: number;
};

const PYTHON_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "src", "acquire", "render-bilingual-subtitles.py",
);

const WATERMARK_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "src", "acquire", "gen-watermark.py",
);

/**
 * Overlay frame rate for subtitle strip sequence.
 * 4 fps = 250 ms granularity — matches the Chinese burn path and avoids the
 * multi-hour cost of writing full-frame PNGs at source video FPS.
 */
const OVERLAY_FPS = 4;

/** Watermark placement (top-left), matching generate-overlay-frames.py. */
const WATERMARK_X = 24;
const WATERMARK_Y = 16;

/**
 * PIL bilingual cue rendering is CPU-heavy at 1080p (≈1s/cue on recent Macs).
 * A 25-minute video with ~300 cues already takes ~6 minutes; give long videos
 * enough headroom without waiting forever on a hung process.
 */
const RENDER_TIMEOUT_MS = 20 * 60_000;

/**
 * Burn bilingual subtitles into a video using Python PIL rendering + ffmpeg overlay.
 *
 * Falls back to PNG-based rendering since many ffmpeg distributions lack
 * libass (--enable-libass) for the subtitles/ass filter.
 *
 * 1. Validate SRT integrity.
 * 2. Python PIL renders each bilingual cue as a transparent RGBA strip PNG
 *    (Chinese yellow bold on top, English white italic on bottom).
 * 3. Build a low-FPS strip sequence (cue / blank copies) for ffmpeg overlay.
 * 4. Optionally generate a static watermark PNG and overlay it separately
 *    (avoids baking watermark into tens of thousands of full-frame PNGs).
 * 5. ffmpeg single-pass overlay onto the main video.
 * 6. Post-burn frame verification.
 *
 * Force / mtime logic:
 * - `force: true` → unconditionally re-burn
 * - `force: false` → skip if output exists and is newer than all sources
 */
export const burnBilingualSubtitles = async (
  opts: BurnBilingualSubtitlesOptions,
): Promise<BurnBilingualSubtitlesResult> => {
  const warnings: string[] = [];

  // Verify SRT file exists
  try {
    await access(opts.srtPath);
  } catch {
    return { burned: false, skipped: true, skipReason: "missing_srt", warnings };
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
      const [outputStat, srtStat, enStat, zhStat] = await Promise.all([
        stat(opts.outputPath),
        stat(opts.srtPath),
        stat(opts.enSrtPath),
        stat(opts.zhSrtPath),
      ]);

      const outputMtime = outputStat.mtimeMs;
      if (
        srtStat.mtimeMs <= outputMtime &&
        enStat.mtimeMs <= outputMtime &&
        zhStat.mtimeMs <= outputMtime
      ) {
        return { burned: false, skipped: true, skipReason: "already_exists", warnings };
      }

      // Source is newer — remove stale output and re-burn
      await rm(opts.outputPath).catch(() => {});
    } catch {
      // Output doesn't exist — proceed with burn
    }
  }

  // Validate SRT integrity before burning
  for (const p of [opts.enSrtPath, opts.zhSrtPath, opts.srtPath]) {
    const integrity = await validateSrtIntegrity(p);
    if (!integrity.valid) {
      const fatal = integrity.issues.filter(
        (i) => i.kind === "overlap" || i.kind === "negative_duration" || i.kind === "no_cues",
      );
      if (fatal.length > 0) {
        throw new Error(
          `SRT integrity check failed for ${path.basename(p)}:\n${fatal.map((i) => `  - ${i.message}`).join("\n")}`,
        );
      }
    }
  }

  // 1. Probe video dimensions (used for font scaling + bottom margin)
  const videoWidth = await probeVideoWidth(opts.videoPath, opts.runner);
  const videoHeight = await probeVideoHeight(opts.videoPath, opts.runner);
  const pythonBin = await resolvePythonWithPillow();

  // 2. Render bilingual subtitle PNGs via Python PIL
  const renderDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-bilingual-render-"));
  const pyArgs: string[] = [
    PYTHON_SCRIPT,
    opts.srtPath,
    renderDir,
    "--video-width", String(videoWidth),
    "--video-height", String(videoHeight),
  ];
  let renderResult;
  try {
    renderResult = await opts.runner.run({
      command: pythonBin,
      args: pyArgs,
      timeoutMs: RENDER_TIMEOUT_MS,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err: unknown) {
    await rm(renderDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`bilingual subtitle PNG rendering failed: ${formatProcessFailure(err)}`);
  }

  if (renderResult.exitCode !== 0) {
    const excerpt = (renderResult.stderr ?? "").split("\n").slice(-10).join("\n");
    await rm(renderDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`bilingual subtitle PNG rendering failed: ${excerpt}`);
  }

  // 3. Read manifest
  const manifestRaw = await readFile(path.join(renderDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as RenderManifest;
  const { cues, video_width: vw } = manifest;

  if (cues.length === 0) {
    await rm(renderDir, { recursive: true, force: true });
    throw new Error("bilingual SRT file contains no subtitle cues");
  }

  // 4. Compute dimensions & duration
  const maxH = Math.max(...cues.map((c) => c.height), 40);
  const lastEnd = cues[cues.length - 1]!.end;
  const videoDuration = await probeVideoDuration(opts.videoPath, opts.runner, lastEnd);
  const totalSec = Math.ceil(Math.max(lastEnd + 5, videoDuration + 2));

  // 5. Create blank subtitle strip for gaps between cues
  const blankPath = path.join(renderDir, "blank.png");
  try {
    const blankResult = await opts.runner.run({
      command: pythonBin,
      args: [
        "-c",
        `from PIL import Image\nImage.new("RGBA", (${vw}, ${maxH}), (0, 0, 0, 0)).save("${blankPath}")`,
      ],
      timeoutMs: 10_000,
    });
    if (blankResult.exitCode !== 0) {
      await rm(renderDir, { recursive: true, force: true }).catch(() => {});
      throw new Error("failed to create blank PNG for bilingual burn");
    }
  } catch (err: unknown) {
    await rm(renderDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`failed to create blank PNG for bilingual burn: ${formatProcessFailure(err)}`);
  }

  // 6. Optional static watermark PNG (composited by ffmpeg, not pre-baked frames)
  let watermarkPath: string | null = null;
  if (opts.watermarkVideo || opts.watermarkXlate) {
    const wmPath = path.join(renderDir, "watermark.png");
    const wmArgs = [WATERMARK_SCRIPT, wmPath];
    if (opts.watermarkVideo) {
      wmArgs.push("--watermark-video", opts.watermarkVideo);
    }
    if (opts.watermarkXlate) {
      wmArgs.push("--watermark-xlate", opts.watermarkXlate);
    }
    try {
      const wmResult = await opts.runner.run({
        command: pythonBin,
        args: wmArgs,
        timeoutMs: 15_000,
      });
      if (wmResult.exitCode === 0) {
        watermarkPath = wmPath;
      } else {
        warnings.push(`watermark generation failed: ${wmResult.stderr ?? "unknown error"}`);
      }
    } catch (err: unknown) {
      warnings.push(`watermark generation failed: ${formatProcessFailure(err)}`);
    }
  }

  // 7. Build low-FPS subtitle strip sequence via file copies (same strategy as zh burn)
  const framesDir = path.join(renderDir, "frames");
  await mkdir(framesDir, { recursive: true });

  const totalFrames = totalSec * OVERLAY_FPS;
  const frameInterval = 1 / OVERLAY_FPS;

  for (let i = 0; i < totalFrames; i++) {
    const t = i * frameInterval;
    const active = cues.find((c) => c.start <= t && c.end > t);
    const src = active ? path.join(renderDir, active.filename) : blankPath;
    const dst = path.join(framesDir, `frame_${String(i).padStart(5, "0")}.png`);
    await copyFile(src, dst);
  }

  // Verify every cue has frame coverage
  for (const cue of cues) {
    const firstFrame = Math.floor(cue.start * OVERLAY_FPS);
    const lastFrame = Math.ceil(cue.end * OVERLAY_FPS) - 1;
    let hasFrame = false;
    for (let f = firstFrame; f <= lastFrame && f < totalFrames; f++) {
      const t = f * frameInterval;
      if (cue.start <= t && cue.end > t) {
        hasFrame = true;
        break;
      }
    }
    if (!hasFrame && cue.end - cue.start >= frameInterval / 2) {
      await rm(renderDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `cue #${cue.index} (${cue.start.toFixed(2)}s–${cue.end.toFixed(2)}s) too short for ${OVERLAY_FPS}fps overlay`,
      );
    }
  }

  // 8. ffmpeg overlay: subtitle strip at bottom + optional static watermark top-left
  const bottomMargin = Math.round(36 * (videoHeight / 720));
  const filterComplex = watermarkPath !== null
    ? [
        `[0:v][1:v]overlay=(W-w)/2:H-h-${bottomMargin}[sub]`,
        `[sub][2:v]overlay=${WATERMARK_X}:${WATERMARK_Y}[overlaid]`,
        `[overlaid]format=yuv420p[vfinal]`,
      ].join(";")
    : [
        `[0:v][1:v]overlay=(W-w)/2:H-h-${bottomMargin}[overlaid]`,
        `[overlaid]format=yuv420p[vfinal]`,
      ].join(";");

  const ffmpegArgs: string[] = [
    "-i", opts.videoPath,
    "-framerate", String(OVERLAY_FPS),
    "-i", path.join(framesDir, "frame_%05d.png"),
  ];
  if (watermarkPath !== null) {
    // Loop a single-frame watermark for the full video duration.
    ffmpegArgs.push("-loop", "1", "-i", watermarkPath);
  }
  ffmpegArgs.push(
    "-filter_complex", filterComplex,
    "-map", "[vfinal]", "-map", "0:a",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-profile:v", "high", "-level", "4.0",
    "-c:a", "aac", "-b:a", "128k",
    // End when the main video ends (watermark is looped).
    "-shortest",
    "-movflags", "+faststart", "-y", opts.outputPath,
  );

  let result;
  try {
    result = await opts.runner.run({
      command: "ffmpeg",
      args: ffmpegArgs,
      timeoutMs: 30 * 60_000,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err: unknown) {
    await rm(renderDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`ffmpeg bilingual subtitle burn failed: ${formatProcessFailure(err)}`);
  }

  await rm(renderDir, { recursive: true, force: true }).catch(() => {});

  if (result.exitCode !== 0) {
    const excerpt = (result.stderr ?? "").split("\n").slice(-20).join("\n");
    throw new Error(`ffmpeg bilingual subtitle burn failed with exit code ${result.exitCode}: ${excerpt}`);
  }

  // 9. Post-burn verification
  try {
    const verification = await verifyBurnedSubtitles(
      opts.outputPath,
      opts.videoPath,
      opts.srtPath,
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

/** Format ProcessError / generic errors with stderr when available. */
const formatProcessFailure = (err: unknown): string => {
  if (isProcessError(err)) {
    const excerpt = err.context.stderrExcerpt?.trim();
    return excerpt && excerpt.length > 0 ? `${err.message}\n${excerpt}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
};

/** Probe video width. */
const probeVideoWidth = async (
  videoPath: string,
  runner: ProcessRunner,
): Promise<number> => {
  const result = await runner.run({
    command: "ffprobe",
    args: [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    timeoutMs: 15_000,
  });
  const w = parseInt((result.stdout ?? "1280").trim(), 10);
  return Number.isFinite(w) && w > 0 ? w : 1280;
};

/** Probe video height. */
const probeVideoHeight = async (
  videoPath: string,
  runner: ProcessRunner,
): Promise<number> => {
  const result = await runner.run({
    command: "ffprobe",
    args: [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=height",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    timeoutMs: 15_000,
  });
  const h = parseInt((result.stdout ?? "720").trim(), 10);
  return Number.isFinite(h) && h > 0 ? h : 720;
};

/** Probe video duration in seconds, falling back to lastEnd + 10. */
const probeVideoDuration = async (
  videoPath: string,
  runner: ProcessRunner,
  fallbackEnd: number,
): Promise<number> => {
  const probeResult = await runner.run({
    command: "ffprobe",
    args: [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    timeoutMs: 15_000,
  });
  return parseFloat((probeResult.stdout ?? "0").trim()) || (fallbackEnd + 10);
};
