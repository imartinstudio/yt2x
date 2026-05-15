import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessRunner } from "../process/index.js";
import { resolveDirectVideoUrl, type YtDlpOptions } from "./yt-dlp.js";

const CUE_RE = /^-\s+`([^`]+)`\s+-\s+`([^`]+)`:\s+(.*)$/;
const SHOWINFO_RE = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;

export type SceneKeyframeOptions = {
  source: string;
  outputDir: string;
  cuesPath?: string;
  threshold: number;
  minGap: number;
  maxFrames: number;
  candidateLimit?: number;
  contextWindow?: number;
  width?: number;
  cookiesFromBrowser?: string;
  proxy?: string;
  runner: ProcessRunner;
  timeoutMs: number;
  signal?: AbortSignal;
};

const timestampToSeconds = (value: string): number => {
  const v = value.replace(",", ".").trim();
  if (/^\d+(?:\.\d+)?$/.test(v)) {
    return Number(v);
  }
  const parts = v.split(":");
  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  throw new Error(`invalid timestamp: ${value}`);
};

const secondsToTimestamp = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const isUrl = (source: string): boolean => /^https?:\/\//.test(source);

const parseCuesFromMarkdown = async (cuesPath: string | undefined): Promise<
  Array<{ start_seconds: number; end_seconds: number; text: string }>
> => {
  if (cuesPath === undefined) {
    return [];
  }
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(cuesPath, "utf8");
  } catch {
    return [];
  }
  const cues: Array<{ start_seconds: number; end_seconds: number; text: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = CUE_RE.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, start, end, body] = match;
    cues.push({
      start_seconds: timestampToSeconds(start!),
      end_seconds: timestampToSeconds(end!),
      text: body!.trim(),
    });
  }
  return cues;
};

const nearbyCueText = (
  cues: Array<{ start_seconds: number; end_seconds: number; text: string }>,
  seconds: number,
  window: number,
): string => {
  if (cues.length === 0) {
    return "";
  }
  const texts: string[] = [];
  for (const cue of cues) {
    if (cue.end_seconds >= seconds - window && cue.start_seconds <= seconds + window) {
      if (cue.text && (texts.length === 0 || texts[texts.length - 1] !== cue.text)) {
        texts.push(cue.text);
      }
    }
  }
  return texts.join(" ").slice(0, 900);
};

const runFfmpeg = async (
  opts: SceneKeyframeOptions,
  args: string[],
): Promise<{ exitCode: number; stderr: string }> => {
  const result = await opts.runner.run({
    command: "ffmpeg",
    args,
    timeoutMs: opts.timeoutMs,
    stdio: "pipe",
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  return { exitCode: result.exitCode, stderr: result.stderr };
};

const ytdlpOptsFromScene = (opts: SceneKeyframeOptions): YtDlpOptions => ({
  runner: opts.runner,
  timeoutMs: opts.timeoutMs,
  ...(opts.cookiesFromBrowser !== undefined && opts.cookiesFromBrowser.length > 0
    ? { cookiesFromBrowser: opts.cookiesFromBrowser }
    : {}),
  ...(opts.proxy !== undefined && opts.proxy.length > 0 ? { proxy: opts.proxy } : {}),
  ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
});

const extractSceneCandidates = async (
  videoInput: string,
  workdir: string,
  opts: SceneKeyframeOptions,
): Promise<{ candidates: Array<{ file: string; seconds: number }>; ffmpegExit: number; stderr: string }> => {
  const width = opts.width ?? 1280;
  const limit = opts.candidateLimit ?? 120;
  const pattern = path.join(workdir, "candidate_%05d.jpg");
  const scaleFilter = `scale='min(${width},iw)':-2`;
  const sceneFilter = `select='gt(scene,${opts.threshold})',showinfo,${scaleFilter}`;

  const { exitCode, stderr } = await runFfmpeg(opts, [
    "-y",
    "-i",
    videoInput,
    "-vf",
    sceneFilter,
    "-vsync",
    "vfr",
    "-frames:v",
    String(limit),
    "-q:v",
    "3",
    pattern,
  ]);

  const timestamps: number[] = [];
  for (const match of stderr.matchAll(SHOWINFO_RE)) {
    timestamps.push(Number(match[1]));
  }

  const files = (await readdir(workdir))
    .filter((n) => n.startsWith("candidate_") && n.endsWith(".jpg"))
    .sort()
    .map((n) => path.join(workdir, n));

  const candidates = files.map((file, index) => ({
    file,
    seconds: timestamps[index] ?? 0,
  }));

  return { candidates, ffmpegExit: exitCode, stderr };
};

const selectCandidates = (
  candidates: Array<{ file: string; seconds: number }>,
  maxFrames: number,
  minGap: number,
): Array<{ file: string; seconds: number }> => {
  const selected: Array<{ file: string; seconds: number }> = [];
  let last = -1e9;
  for (const candidate of candidates) {
    if (candidate.seconds - last < minGap) {
      continue;
    }
    selected.push(candidate);
    last = candidate.seconds;
    if (selected.length >= maxFrames) {
      break;
    }
  }
  return selected;
};

const buildContactSheet = async (
  outputDir: string,
  opts: SceneKeyframeOptions,
): Promise<string | undefined> => {
  const files = (await readdir(outputDir)).filter((n) => n.startsWith("scene_") && n.endsWith(".jpg"));
  if (files.length === 0) {
    return undefined;
  }
  const tileCols = 4;
  const tileRows = Math.max(1, Math.ceil(files.length / tileCols));
  const out = path.join(outputDir, "contact_sheet.jpg");
  const { exitCode } = await runFfmpeg(opts, [
    "-y",
    "-pattern_type",
    "glob",
    "-i",
    path.join(outputDir, "scene_*.jpg"),
    "-vf",
    `scale=320:-2,tile=${tileCols}x${tileRows}`,
    "-q:v",
    "3",
    out,
  ]);
  return exitCode === 0 ? "contact_sheet.jpg" : undefined;
};

/**
 * 场景关键帧：优先 yt-dlp 直链 + ffmpeg 流式 scene 检测（不下载整段视频）。
 * 失败时仅写 manifest 警告，不抛错、不回退整片下载。
 */
export const extractSceneKeyframes = async (opts: SceneKeyframeOptions): Promise<string[]> => {
  const warnings: string[] = [];
  await mkdir(opts.outputDir, { recursive: true });

  const manifest: Record<string, unknown> = {
    source: opts.source,
    method: "ffmpeg_scene_detection_stream",
    threshold: opts.threshold,
    min_gap: opts.minGap,
    max_frames: opts.maxFrames,
    frames: [] as unknown[],
    warnings: [] as string[],
  };

  const ffmpegCheck = await opts.runner.run({
    command: "ffmpeg",
    args: ["-version"],
    timeoutMs: 10_000,
    stdio: "pipe",
  });
  if (ffmpegCheck.exitCode !== 0) {
    const msg = "ffmpeg not found; scene keyframe extraction skipped";
    warnings.push(msg);
    manifest.warnings = [msg];
    await writeFile(
      path.join(opts.outputDir, "scene_manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    return warnings;
  }

  const cues = await parseCuesFromMarkdown(opts.cuesPath);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "youtube-scenes-"));

  try {
    let videoInput: string;
    if (isUrl(opts.source)) {
      try {
        videoInput = await resolveDirectVideoUrl(opts.source, ytdlpOptsFromScene(opts));
        manifest.stream_url_resolved = true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const msg = `scene keyframes: could not resolve stream URL: ${message}`;
        warnings.push(msg);
        manifest.warnings = [msg];
        await writeFile(
          path.join(opts.outputDir, "scene_manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        );
        return warnings;
      }
    } else {
      videoInput = path.resolve(opts.source);
      const { access } = await import("node:fs/promises");
      try {
        await access(videoInput);
      } catch {
        const msg = `video path does not exist: ${videoInput}`;
        warnings.push(msg);
        manifest.warnings = [msg];
        await writeFile(
          path.join(opts.outputDir, "scene_manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        );
        return warnings;
      }
    }

    const { candidates, ffmpegExit, stderr } = await extractSceneCandidates(videoInput, tempDir, opts);
    if (ffmpegExit !== 0) {
      const excerpt = stderr.trim().slice(-400);
      const msg = `ffmpeg scene detection exited ${ffmpegExit}${excerpt.length > 0 ? `: ${excerpt}` : ""}`;
      warnings.push(msg);
      manifest.warnings = [msg];
      manifest.candidate_count = candidates.length;
      manifest.selected_count = 0;
      await writeFile(
        path.join(opts.outputDir, "scene_manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      return warnings;
    }

    const selected = selectCandidates(candidates, opts.maxFrames, opts.minGap);
    manifest.candidate_count = candidates.length;
    manifest.selected_count = selected.length;

    const contextWindow = opts.contextWindow ?? 12;
    const frames: unknown[] = [];
    for (let index = 0; index < selected.length; index++) {
      const item = selected[index]!;
      const seconds = item.seconds;
      const timestamp = secondsToTimestamp(seconds);
      const filename = `scene_${String(index + 1).padStart(2, "0")}_${timestamp.replace(/:/g, "-")}.jpg`;
      const dest = path.join(opts.outputDir, filename);
      await copyFile(item.file, dest);
      frames.push({
        index: index + 1,
        timestamp,
        seconds,
        file: filename,
        transcript_context: nearbyCueText(cues, seconds, contextWindow),
        selection_reason: "ffmpeg scene-change candidate; review visually before publishing",
      });
    }
    manifest.frames = frames;

    const contactSheet = await buildContactSheet(opts.outputDir, opts);
    if (contactSheet !== undefined) {
      manifest.contact_sheet = contactSheet;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  await writeFile(
    path.join(opts.outputDir, "scene_manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return warnings;
};
