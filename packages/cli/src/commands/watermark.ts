import { access } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import {
  DEFAULT_OUT_DIR,
  DEFAULT_WATERMARK_SUBTITLER,
  defaultProcessRunner,
  overlayWatermarkOnVideo,
  resolveWatermarkUploaderId,
  sanitizeVideoId,
} from "@yt2x/adapters-node";
import { logger } from "../logger.js";

export type WatermarkFlags = {
  videoId?: string;
  outDir?: string;
  /** Explicit source video; overrides the videoId's default full.mp4. */
  input?: string;
  outputPath?: string;
  watermarkVideo?: string;
  watermarkSubtitler?: string;
  force?: boolean;
};

export type WatermarkIo = {
  inputPath: string;
  outputPath: string;
  watermarkVideo?: string;
};

const withWatermarkedSuffix = (videoPath: string): string => {
  const ext = path.extname(videoPath);
  const base = path.basename(videoPath, ext);
  return path.join(path.dirname(videoPath), `${base}.watermarked${ext || ".mp4"}`);
};

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,}$/;

/**
 * Both artifact roots nest a video one level under its id: `<root>/<videoId>/video/<file>`.
 * Recovering the id from that shape means attributing a dubbed cut does not require
 * repeating `--video-id`, which otherwise silently yields a watermark missing its
 * 「视频：」 line.
 */
const inferVideoIdFromPath = (videoPath: string): string | undefined => {
  const parent = path.dirname(videoPath);
  if (path.basename(parent) !== "video") return undefined;
  const candidate = path.basename(path.dirname(parent));
  return VIDEO_ID_RE.test(candidate) ? candidate : undefined;
};

/**
 * Resolve where the video comes from and where the attributed copy goes.
 * `--video-id` is the common case and also supplies the 「视频：」 channel credit
 * from the acquired metadata; `--input` covers a cut this pipeline did not produce.
 */
export const resolveWatermarkIo = async (flags: WatermarkFlags): Promise<WatermarkIo> => {
  const hasVideoId = (flags.videoId ?? "").trim().length > 0;
  const hasInput = (flags.input ?? "").trim().length > 0;
  if (!hasVideoId && !hasInput) {
    throw new Error("watermark needs a source: pass --video-id <id> or --input <path>");
  }

  let watermarkVideo: string | undefined;
  let inputPath: string | undefined;

  if (hasVideoId) {
    const videoId = sanitizeVideoId(flags.videoId!);
    const outRoot = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
    const videoDir = path.join(outRoot, videoId);
    watermarkVideo = await resolveWatermarkUploaderId(videoDir);
    if (!hasInput) {
      const candidate = path.join(videoDir, "video", "full.mp4");
      const exists = await access(candidate).then(
        () => true,
        () => false,
      );
      if (!exists) {
        throw new Error(
          `no source video for "${videoId}": expected ${candidate}. ` +
            "Run `yt2x acquire --video-only` first, or pass --input <path>.",
        );
      }
      inputPath = candidate;
    }
  }

  if (hasInput) inputPath = path.resolve(flags.input!);

  const resolvedInput = inputPath!;

  // No explicit --video-id: fall back to whatever the input path implies, so a
  // dubbed cut still gets its channel credit.
  if (watermarkVideo === undefined) {
    const inferred = inferVideoIdFromPath(resolvedInput);
    if (inferred !== undefined) {
      const outRoot = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
      watermarkVideo = await resolveWatermarkUploaderId(path.join(outRoot, inferred));
    }
  }
  const outputPath =
    (flags.outputPath ?? "").trim().length > 0
      ? path.resolve(flags.outputPath!)
      : withWatermarkedSuffix(resolvedInput);

  return {
    inputPath: resolvedInput,
    outputPath,
    ...(watermarkVideo !== undefined ? { watermarkVideo } : {}),
  };
};

export const executeWatermark = async (flags: WatermarkFlags): Promise<number> => {
  let io: WatermarkIo;
  try {
    io = await resolveWatermarkIo(flags);
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "watermark failed");
    return 1;
  }

  const subtitler = flags.watermarkSubtitler ?? DEFAULT_WATERMARK_SUBTITLER;
  const watermarkVideo = flags.watermarkVideo ?? io.watermarkVideo;

  try {
    const result = await overlayWatermarkOnVideo({
      inputPath: io.inputPath,
      outputPath: io.outputPath,
      runner: defaultProcessRunner,
      force: flags.force === true,
      ...(watermarkVideo !== undefined && watermarkVideo.trim().length > 0
        ? { watermarkVideo }
        : {}),
      ...(subtitler.trim().length > 0 ? { watermarkSubtitler: subtitler } : {}),
    });
    if (result.skipped) {
      logger.info(
        { outputPath: result.outputPath },
        "watermark: output already exists, skipping (use --force to overwrite)",
      );
    } else {
      logger.info(
        { inputPath: io.inputPath, outputPath: result.outputPath, watermarkVideo, subtitler },
        "watermark: written",
      );
    }
    return 0;
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "watermark failed");
    return 1;
  }
};

export const registerWatermarkCommand = (program: Command): void => {
  program
    .command("watermark")
    .description(
      "Overlay the standard top-left attribution watermark on a video, without burning subtitles. " +
        "Video track is re-encoded; audio is stream-copied.",
    )
    .option("--video-id <id>", "Video ID under --out-dir; also supplies the 「视频：」 channel credit")
    .option("--out-dir <path>", "Downloaded source root", DEFAULT_OUT_DIR)
    .option("--input <path>", "Source video path (overrides the --video-id default full.mp4)")
    .option("--output-path <path>", "Destination (default: <source>.watermarked.mp4)")
    .option("--watermark-video <handle>", "Override the 「视频：」 channel handle")
    .option(
      "--watermark-subtitler <handle>",
      `Override the 「字幕：」 attribution (default ${DEFAULT_WATERMARK_SUBTITLER}); empty string drops that line`,
    )
    .option("--force", "Overwrite an existing output")
    .action(async (flags: WatermarkFlags) => {
      process.exitCode = await executeWatermark(flags);
    });
};
