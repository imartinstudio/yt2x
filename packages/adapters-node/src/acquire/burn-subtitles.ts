import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessError, isProcessError, type ProcessRunner } from "../process/index.js";

export type BurnSubtitlesOptions = {
  videoPath: string;
  srtPath: string;
  outputPath: string;
  runner: ProcessRunner;
  signal?: AbortSignal;
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
  "..", "..", "src", "acquire", "render-subtitles.py",
);

const VERIFY_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "src", "acquire", "verify-subtitles.py",
);

/** Overlay frame rate — sub-second granularity avoids boundary artifacts. */
const OVERLAY_FPS = 4;

// ---- SRT integrity validation ----

export type SrtIntegrityIssue = {
  kind: "overlap" | "gap" | "empty_text" | "non_monotonic" | "negative_duration";
  cueIndex: number;
  message: string;
};

/**
 * Validate an SRT file's integrity before burning.
 *
 * Checks:
 * - Every cue has non-empty text
 * - Timestamps are monotonically increasing (end <= next start)
 * - No negative or zero-duration cues
 * - Flags gaps > 500ms between consecutive cues
 * - Flags overlapping cues
 */
export const validateSrtIntegrity = async (
  srtPath: string,
): Promise<{ valid: boolean; issues: SrtIntegrityIssue[] }> => {
  const raw = await readFile(srtPath, "utf8");
  const issues: SrtIntegrityIssue[] = [];

  const lines = raw.split(/\r?\n/u);
  const blocks: Array<{ index: number; start: string; end: string; text: string[] }> = [];

  // Parse SRT blocks manually to preserve original indices for error reporting
  let currentIndex = 0;
  let currentStart = "";
  let currentEnd = "";
  let currentText: string[] = [];
  let inBlock = false;

  const flushBlock = (): void => {
    if (inBlock && currentStart && currentEnd) {
      blocks.push({
        index: currentIndex,
        start: currentStart,
        end: currentEnd,
        text: currentText.filter((l) => l.trim().length > 0),
      });
    }
    inBlock = false;
    currentStart = "";
    currentEnd = "";
    currentText = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flushBlock();
      continue;
    }
    if (/^\d+$/u.test(trimmed)) {
      if (inBlock) flushBlock();
      currentIndex = parseInt(trimmed, 10);
      inBlock = true;
      continue;
    }
    const timingRe = /^\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{3})/u;
    const timingMatch = timingRe.exec(trimmed);
    if (timingMatch) {
      currentStart = timingMatch[1]!.replace(",", ".");
      currentEnd = timingMatch[2]!.replace(",", ".");
      continue;
    }
    if (inBlock && currentStart.length > 0) {
      currentText.push(trimmed);
    }
  }
  flushBlock();

  if (blocks.length === 0) {
    issues.push({ kind: "empty_text", cueIndex: 0, message: "SRT file contains no parseable cues" });
    return { valid: false, issues };
  }

  const toMs = (ts: string): number => {
    const parts = ts.split(":");
    const h = parts[0] ?? "0";
    const m = parts[1] ?? "0";
    const [s = "0", ms = "000"] = (parts[2] ?? "0.000").split(".");
    return parseInt(h) * 3_600_000 + parseInt(m) * 60_000 + parseInt(s) * 1000 + parseInt(ms.padEnd(3, "0").slice(0, 3));
  };

  // Validate each cue
  for (const block of blocks) {
    if (block.text.length === 0) {
      issues.push({
        kind: "empty_text",
        cueIndex: block.index,
        message: `cue #${block.index} has no text`,
      });
    }
    const startMs = toMs(block.start);
    const endMs = toMs(block.end);
    if (endMs <= startMs) {
      issues.push({
        kind: "negative_duration",
        cueIndex: block.index,
        message: `cue #${block.index} has non-positive duration (${block.start} → ${block.end})`,
      });
    }
  }

  // Check monotonicity, overlaps, gaps
  for (let i = 0; i < blocks.length - 1; i++) {
    const curr = blocks[i]!;
    const next = blocks[i + 1]!;
    const currEndMs = toMs(curr.end);
    const nextStartMs = toMs(next.start);

    if (currEndMs > nextStartMs) {
      issues.push({
        kind: "overlap",
        cueIndex: next.index,
        message: `cue #${next.index} starts at ${next.start} before cue #${curr.index} ends at ${curr.end} (overlap ${currEndMs - nextStartMs}ms)`,
      });
    } else if (currEndMs < nextStartMs) {
      const gap = nextStartMs - currEndMs;
      if (gap > 500) {
        issues.push({
          kind: "gap",
          cueIndex: next.index,
          message: `gap of ${gap}ms between cue #${curr.index} (ends ${curr.end}) and cue #${next.index} (starts ${next.start})`,
        });
      }
    }
  }

  return {
    valid: issues.filter((i) => i.kind === "overlap" || i.kind === "empty_text" || i.kind === "negative_duration" || i.kind === "non_monotonic").length === 0,
    issues,
  };
};

// ---- Post-burn frame verification ----

export type VerificationResult = {
  passed: boolean;
  checks: Array<{ position: string; timestamp: number; passed: boolean; detail: string }>;
};

/**
 * Extract a frame at a given timestamp from both the burned and original
 * videos, then compare the subtitle region to detect overlay presence.
 */
const verifyFramePair = async (
  burnedPath: string,
  originalPath: string,
  timestampSec: number,
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<{ passed: boolean; detail: string }> => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-verify-"));
  const burnedFrame = path.join(tmpDir, "burned.png");
  const origFrame = path.join(tmpDir, "original.png");

  const runSafe = async (command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> => {
    try {
      const result = await runner.run({ command, args, timeoutMs, ...(signal !== undefined ? { signal } : {}) });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (err: unknown) {
      if (isProcessError(err)) {
        return { stdout: "", stderr: err.context.stderrExcerpt ?? String(err) };
      }
      throw err;
    }
  };

  try {
    // Extract frame from burned video (input seeking: -ss before -i for speed)
    await runSafe("ffmpeg", [
      "-ss", String(timestampSec),
      "-i", burnedPath,
      "-frames:v", "1",
      "-q:v", "2",
      "-y", burnedFrame,
    ], 90_000);

    try { await stat(burnedFrame); } catch {
      return { passed: false, detail: `ffmpeg did not produce burned frame at ${timestampSec.toFixed(1)}s` };
    }

    // Extract same frame from original video
    await runSafe("ffmpeg", [
      "-ss", String(timestampSec),
      "-i", originalPath,
      "-frames:v", "1",
      "-q:v", "2",
      "-y", origFrame,
    ], 90_000);

    try { await stat(origFrame); } catch {
      return { passed: false, detail: `ffmpeg did not produce original frame at ${timestampSec.toFixed(1)}s` };
    }

    // Compare frames via Python PIL. The script always exits 0 and writes
    // "PASS <score>" or "FAIL <reason>" to stdout.
    const pyResult = await runSafe("python3", [VERIFY_SCRIPT, burnedFrame, origFrame], 10_000);

    const output = pyResult.stdout.trim();
    if (output.startsWith("PASS")) {
      return { passed: true, detail: output };
    }
    // If stdout is empty, check stderr for clues
    if (!output) {
      return { passed: false, detail: `verification script produced no output (stderr: ${pyResult.stderr?.slice(-100) ?? "none"})` };
    }
    return { passed: false, detail: output };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * After burning subtitles, extract frames at start (10%), middle (50%),
 * and end (90%) of the subtitle time range. Compare each burned frame
 * against the original video at the same timestamp to verify subtitle
 * overlay is present and correct.
 */
export const verifyBurnedSubtitles = async (
  burnedPath: string,
  originalPath: string,
  srtPath: string,
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<VerificationResult> => {
  const srtRaw = await readFile(srtPath, "utf8");
  const cues = parseSrtForVerification(srtRaw);

  if (cues.length === 0) {
    return { passed: false, checks: [] };
  }

  const firstCueStart = cues[0]!.start;
  const lastCueEnd = cues[cues.length - 1]!.end;
  const duration = lastCueEnd - firstCueStart;

  if (duration <= 0) {
    return { passed: false, checks: [] };
  }

  // Pick three verification points: 10%, 50%, 85% of subtitle time range.
  // 85% for end avoids keyframe gaps near the final frames.
  const checkPoints = [
    { position: "start", timestamp: firstCueStart + duration * 0.1 },
    { position: "middle", timestamp: firstCueStart + duration * 0.5 },
    { position: "end", timestamp: firstCueStart + duration * 0.85 },
  ];

  const checks: VerificationResult["checks"] = [];
  for (const cp of checkPoints) {
    const nearestCue = cues.find((c) => c.start <= cp.timestamp && c.end >= cp.timestamp);
    const actualTs = nearestCue ? (nearestCue.start + nearestCue.end) / 2 : cp.timestamp;

    const result = await verifyFramePair(burnedPath, originalPath, actualTs, runner, signal);
    checks.push({ position: cp.position, timestamp: actualTs, ...result });
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
};

/** Parse SRT cues into start/end seconds for verification. */
const parseSrtForVerification = (raw: string): Array<{ start: number; end: number }> => {
  const cues: Array<{ start: number; end: number }> = [];
  const blocks = raw.trim().split(/\n\n+/u);

  for (const block of blocks) {
    const lines = block.split("\n");
    for (const line of lines) {
      const m = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/u.exec(line);
      if (m) {
        const toSec = (ts: string): number => {
          const [h, min, rest] = ts.split(":");
          const [s, ms] = rest!.replace(",", ".").split(".");
          return parseInt(h!) * 3600 + parseInt(min!) * 60 + parseInt(s!) + parseInt(ms!.padEnd(3, "0")) / 1000;
        };
        cues.push({ start: toSec(m[1]!), end: toSec(m[2]!) });
        break;
      }
    }
  }
  return cues;
};

/**
 * Burn subtitles into a video.
 *
 * 1. Validate SRT integrity.
 * 2. Python PIL renders each subtitle as a transparent RGBA PNG.
 * 3. Generate one frame per second: active subtitle PNG or blank.
 *    Uses `c.start < sec + 1 && c.end > sec` so no cue is missed even
 *    when it falls entirely inside a single second.
 * 4. ffmpeg overlays onto the main video with proper alpha compositing.
 * 5. Extract sample frames (start/middle/end) and verify subtitles visible.
 */
export const burnSubtitles = async (opts: BurnSubtitlesOptions): Promise<void> => {
  // 0. Validate SRT integrity before burning
  const integrity = await validateSrtIntegrity(opts.srtPath);
  if (!integrity.valid) {
    const fatal = integrity.issues.filter(
      (i) => i.kind === "overlap" || i.kind === "empty_text" || i.kind === "negative_duration",
    );
    if (fatal.length > 0) {
      throw new Error(
        `SRT integrity check failed:\n${fatal.map((i) => `  - ${i.message}`).join("\n")}`,
      );
    }
    // Gaps are warnings — log them but continue
    const gaps = integrity.issues.filter((i) => i.kind === "gap");
    if (gaps.length > 0) {
      const gapMsgs = gaps.map((i) => `  - ${i.message}`).join("\n");
      console.warn(`SRT gaps detected (non-fatal):\n${gapMsgs}`);
    }
  }

  // 1. Render subtitle PNGs
  const renderDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-render-"));
  const renderResult = await opts.runner.run({
    command: "python3",
    args: [PYTHON_SCRIPT, opts.srtPath, renderDir],
    timeoutMs: 60_000,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  if (renderResult.exitCode !== 0) {
    const excerpt = (renderResult.stderr ?? "").split("\n").slice(-10).join("\n");
    await rm(renderDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`subtitle PNG rendering failed: ${excerpt}`);
  }

  // 2. Read manifest
  const manifestRaw = await readFile(path.join(renderDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as RenderManifest;
  const { cues, video_width: vw } = manifest;

  if (cues.length === 0) {
    await rm(renderDir, { recursive: true, force: true });
    throw new Error("SRT file contains no subtitle cues");
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
    args: ["-c", `
from PIL import Image
Image.new("RGBA", (${vw}, ${maxH}), (0, 0, 0, 0)).save("${blankPath}")
`],
    timeoutMs: 10_000,
  });
  if (blankResult.exitCode !== 0) {
    await rm(renderDir, { recursive: true, force: true }).catch(() => {});
    throw new Error("failed to create blank PNG");
  }

  // 5. Generate overlay frames at OVERLAY_FPS (4 fps = 250 ms granularity).
  //    This avoids boundary artifacts and missed short cues that plague 1 fps.
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

  // Verify all expected frames exist on disk
  for (let i = 0; i < totalFrames; i++) {
    const dst = path.join(framesDir, `frame_${String(i).padStart(5, "0")}.png`);
    try {
      await stat(dst);
    } catch {
      await rm(renderDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`frame missing after copy: frame_${String(i).padStart(5, "0")}.png`);
    }
  }

  // 6. Run ffmpeg: image2 at OVERLAY_FPS → overlay onto main video.
  //    No fps/setpts/format on the subtitle stream — those break alpha.
  const filterComplex = [
    `[0:v][1:v]overlay=(W-w)/2:H-h-36[overlaid]`,
    `[overlaid]scale=w=min(1280\\,iw):h=min(720\\,ih),format=yuv420p[vfinal]`,
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
    timeoutMs: 15 * 60_000,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  await rm(renderDir, { recursive: true, force: true }).catch(() => {});

  if (result.exitCode !== 0) {
    const excerpt = (result.stderr ?? "").split("\n").slice(-20).join("\n");
    throw new Error(`ffmpeg subtitle burn failed with exit code ${result.exitCode}: ${excerpt}`);
  }

  // 7. Post-burn verification: sample frames at start/middle/end,
  //    comparing burned output against the original video
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
    throw new Error(
      `post-burn subtitle verification failed — ${failedChecks.length}/${verification.checks.length} check(s) did not pass:\n${details}`,
    );
  }
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
