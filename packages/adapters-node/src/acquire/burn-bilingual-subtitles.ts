import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ProcessRunner } from "../process/index.js";
import { validateSrtIntegrity, verifyBurnedSubtitles } from "./burn-subtitles.js";

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

/** Overlay frame rate — sub-second granularity avoids boundary artifacts. */
const OVERLAY_FPS = 4;

/**
 * Burn bilingual subtitles into a video using Python PIL rendering + ffmpeg overlay.
 *
 * Falls back to PNG-based rendering since many ffmpeg distributions lack
 * libass (--enable-libass) for the subtitles/ass filter.
 *
 * 1. Validate SRT integrity.
 * 2. Python PIL renders each bilingual cue as a transparent RGBA PNG
 *    (Chinese yellow bold on top, English white italic on bottom).
 * 3. Generate one frame per OVERLAY_FPS second.
 * 4. ffmpeg overlays onto the main video.
 * 5. Post-burn frame verification.
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

  // 1. Probe video dimensions
  const videoWidth = await probeVideoWidth(opts.videoPath, opts.runner);
  const videoHeight = await probeVideoHeight(opts.videoPath, opts.runner);

  // 2. Render bilingual subtitle PNGs via Python PIL
  const renderDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-bilingual-render-"));
  const pyArgs: string[] = [
    PYTHON_SCRIPT,
    opts.srtPath,
    renderDir,
    "--video-width", String(videoWidth),
    "--video-height", String(videoHeight),
  ];
  if (opts.watermarkVideo) {
    pyArgs.push("--watermark-video", opts.watermarkVideo);
  }
  if (opts.watermarkXlate) {
    pyArgs.push("--watermark-xlate", opts.watermarkXlate);
  }
  const renderResult = await opts.runner.run({
    command: "python3",
    args: pyArgs,
    timeoutMs: 120_000,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  if (renderResult.exitCode !== 0) {
    const excerpt = (renderResult.stderr ?? "").split("\n").slice(-10).join("\n");
    await rm(renderDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`bilingual subtitle PNG rendering failed: ${excerpt}`);
  }

  // 2. Read manifest
  const manifestRaw = await readFile(path.join(renderDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as RenderManifest;
  const { cues, video_width: vw } = manifest;

  if (cues.length === 0) {
    await rm(renderDir, { recursive: true, force: true });
    throw new Error("bilingual SRT file contains no subtitle cues");
  }

  // 3. Compute dimensions & duration
  const maxH = Math.max(...cues.map((c) => c.height), 40);
  const lastEnd = cues[cues.length - 1]!.end;
  const videoDuration = await probeVideoDuration(opts.videoPath, opts.runner, lastEnd);
  const totalSec = Math.ceil(Math.max(lastEnd + 5, videoDuration + 2));

  // 4. Create blank frame matching max subtitle height
  const blankPath = path.join(renderDir, "blank.png");
  const blankResult = await opts.runner.run({
    command: "python3",
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

  // 5. Generate overlay frames at OVERLAY_FPS
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

  // 6. ffmpeg overlay onto main video — preserve source resolution
  const filterComplex = [
    `[0:v][1:v]overlay=(W-w)/2:H-h-36[overlaid]`,
    `[overlaid]format=yuv420p[vfinal]`,
  ].join(";");

  const ffmpegArgs = [
    "-i", opts.videoPath,
    "-framerate", String(OVERLAY_FPS),
    "-i", path.join(framesDir, "frame_%05d.png"),
    "-filter_complex", filterComplex,
    "-map", "[vfinal]",
    "-map", "0:a",
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

  await rm(renderDir, { recursive: true, force: true }).catch(() => {});

  if (result.exitCode !== 0) {
    const excerpt = (result.stderr ?? "").split("\n").slice(-20).join("\n");
    throw new Error(`ffmpeg bilingual subtitle burn failed with exit code ${result.exitCode}: ${excerpt}`);
  }

  // 7. Post-burn verification
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
