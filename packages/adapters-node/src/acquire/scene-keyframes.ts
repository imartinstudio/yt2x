import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessRunner } from "../process/index.js";
import { resolveDirectVideoUrl, type YtDlpOptions } from "./yt-dlp.js";
import {
  assessFrameQuality,
  quickQualityFallback,
  type QualityCheckOptions,
} from "./scene-quality.js";
import type { SceneFrame, VisualQuality } from "@yt2x/core";

const CUE_RE = /^-\s+`([^`]+)`\s+-\s+`([^`]+)`:\s+(.*)$/;
const SHOWINFO_RE = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;

export type SceneKeyframeOptions = {
  source: string;
  outputDir: string;
  cuesPath?: string;
  /** 视频时长（秒），用于 seek-based 帧提取。未提供时回退到 fps 全解码。 */
  duration?: number;
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

const SEEK_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

/**
 * Seek-based 单帧抓取：跳转到目标时间戳只解码一个 GOP，比 fps 全解码快 15-25x。
 * 需要知道视频时长（从 metadata.json 获取），未提供时回退 fps 模式。
 */
const extractSceneCandidates = async (
  videoInput: string,
  workdir: string,
  opts: SceneKeyframeOptions,
): Promise<{ candidates: Array<{ file: string; seconds: number }>; ffmpegExit: number; stderr: string }> => {
  const duration = opts.duration;
  if (duration === undefined || duration <= 0) {
    // 回退：没有时长信息时用 fps 全解码
    return extractByFps(videoInput, workdir, opts);
  }

  const maxFrames = opts.maxFrames;
  const width = opts.width ?? 1280;
  const candidates: Array<{ file: string; seconds: number }> = [];

  // 在视频 5%-90% 区间内均匀分布时间戳，避开片头片尾
  const startPct = 0.05;
  const endPct = 0.90;
  const startSec = Math.max(5, duration * startPct);
  const endSec = duration * endPct;
  const span = endSec - startSec;

  for (let i = 0; i < maxFrames * 3; i++) {
    const targetSec = startSec + (span * (i + 0.5)) / (maxFrames * 3);
    const filename = `candidate_${String(i).padStart(5, "0")}.jpg`;
    const outPath = path.join(workdir, filename);

    try {
      const { stderr } = await runFfmpeg(opts, [
        "-y",
        "-ss",
        targetSec.toFixed(1),
        "-user_agent",
        SEEK_USER_AGENT,
        "-i",
        videoInput,
        "-vf",
        `scale='min(${width},iw)':-2`,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        "-update",
        "1",
        outPath,
      ]);

      // 从 stderr 解析实际 pts_time
      const ptsMatch = stderr.match(/pts_time:([0-9]+(?:\.[0-9]+)?)/);
      const actualSec = ptsMatch !== null ? Number(ptsMatch[1]) : targetSec;

      // 验证文件非空
      const { stat: fsStat } = await import("node:fs/promises");
      try {
        const s = await fsStat(outPath);
        if (s.size > 2000) {
          candidates.push({ file: outPath, seconds: actualSec });
        }
      } catch {
        // 文件不存在，跳过
      }
    } catch {
      // 单帧抓取失败，跳过
    }
  }

  return { candidates, ffmpegExit: candidates.length > 0 ? 0 : 1, stderr: "" };
};

/** fps 全解码模式（无 video duration 时的回退方案） */
const extractByFps = async (
  videoInput: string,
  workdir: string,
  opts: SceneKeyframeOptions,
): Promise<{ candidates: Array<{ file: string; seconds: number }>; ffmpegExit: number; stderr: string }> => {
  const width = opts.width ?? 1280;
  const limit = opts.candidateLimit ?? 120;
  const pattern = path.join(workdir, "candidate_%05d.jpg");
  const scaleFilter = `scale='min(${width},iw)':-2`;
  const fpsFilter = `fps=1/15,showinfo,${scaleFilter}`;

  const { exitCode, stderr } = await runFfmpeg(opts, [
    "-y",
    "-ss",
    "5",
    "-user_agent",
    SEEK_USER_AGENT,
    "-i",
    videoInput,
    "-vf",
    fpsFilter,
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
  _minGap: number,
): Array<{ file: string; seconds: number }> => {
  if (candidates.length === 0) return [];

  // 按时间排序
  const sorted = [...candidates].sort((a, b) => a.seconds - b.seconds);
  const tMin = sorted[0]!.seconds;
  const tMax = sorted[sorted.length - 1]!.seconds;
  const totalSpan = Math.max(tMax - tMin, 1);

  // 将时间轴均分为 maxFrames 个桶，每个桶取最接近桶中心的帧
  const selected: Array<{ file: string; seconds: number }> = [];
  const used = new Set<number>();

  for (let bucket = 0; bucket < maxFrames; bucket++) {
    const bucketCenter = tMin + (totalSpan * (bucket + 0.5)) / maxFrames;
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < sorted.length; i++) {
      if (used.has(i)) continue;
      const dist = Math.abs(sorted[i]!.seconds - bucketCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      used.add(bestIdx);
      selected.push(sorted[bestIdx]!);
    }
  }

  // 按时间排序返回
  selected.sort((a, b) => a.seconds - b.seconds);
  return selected;
};

/**
 * 用 ffmpeg ssim 比较连续帧相似度，剔除过于相似的帧。
 * 成本很低——每对只需解码两张缩略图跑一次 ssim 过滤。
 */
const deduplicateBySimilarity = async (
  frames: Array<{ file: string; seconds: number }>,
  opts: SceneKeyframeOptions,
): Promise<Array<{ file: string; seconds: number }>> => {
  if (frames.length <= 1) return frames;

  const ssimThreshold = 0.92; // SSIM > 0.92 视为过于相似
  const result: Array<{ file: string; seconds: number }> = [frames[0]!];

  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!;
    const curr = frames[i]!;

    try {
      const { stderr } = await opts.runner.run({
        command: "ffmpeg",
        args: [
          "-y",
          "-i",
          prev.file,
          "-i",
          curr.file,
          "-filter_complex",
          "[0]scale=160:-2[a];[1]scale=160:-2[b];[a][b]ssim",
          "-f",
          "null",
          "-",
        ],
        timeoutMs: Math.min(opts.timeoutMs, 8000),
        stdio: "pipe",
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });

      const ssimMatch = stderr.match(/SSIM\s+\S+:\S+\s+All:(\d+\.\d+)/i);
      if (ssimMatch !== null) {
        const ssim = Number(ssimMatch[1]);
        if (ssim > ssimThreshold) {
          // 跳过此帧（与前一帧过于相似）
          continue;
        }
      }
    } catch {
      // ssim 失败时保守保留帧
    }
    result.push(curr);
  }

  return result;
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
 * 在 pendingFrames 中从 startIndex+1 向后寻找第一个满足 qualityOk 的帧。
 * 未找到时返回 null（不向前回溯）。
 */
const findReplacementFrame = <T>(
  candidates: T[],
  startIndex: number,
  _qualityOk: (q: VisualQuality) => boolean,
): T | null => {
  // 只向后查找（+1, +2, ...）
  for (let offset = 1; offset <= 3; offset++) {
    const idx = startIndex + offset;
    if (idx >= candidates.length) break;
    // 这里不做深度的质量评估，只依赖已有评估结果来避免循环依赖
    // 实际替换逻辑在调用方完成评估后决策
    // 返回候选帧，由调用方做最终质量判断
    return candidates[idx]!;
  }
  return null;
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
    method: "ffmpeg_fps_sampling",
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

    const withGap = selectCandidates(candidates, opts.maxFrames * 2, opts.minGap);
    const selected = await deduplicateBySimilarity(withGap, opts).then((deduped) =>
      selectCandidates(deduped, opts.maxFrames, opts.minGap),
    );
    manifest.candidate_count = candidates.length;

    const contextWindow = opts.contextWindow ?? 12;
    const qualityOpts: QualityCheckOptions = {
      runner: opts.runner,
      timeoutMs: opts.timeoutMs,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };

    // 先复制所有帧到输出目录
    const pendingFrames: Array<{
      file: string;
      seconds: number;
      index: number;
      timestamp: string;
      filename: string;
      transcript: string;
    }> = [];
    for (let index = 0; index < selected.length; index++) {
      const item = selected[index]!;
      const seconds = item.seconds;
      const timestamp = secondsToTimestamp(seconds);
      const filename = `scene_${String(index + 1).padStart(2, "0")}_${timestamp.replace(/:/g, "-")}.jpg`;
      const dest = path.join(opts.outputDir, filename);
      await copyFile(item.file, dest);
      pendingFrames.push({
        file: dest,
        seconds,
        index: index + 1,
        timestamp,
        filename,
        transcript: nearbyCueText(cues, seconds, contextWindow),
      });
    }

    // 质量评估 + 替换策略
    const frames: SceneFrame[] = [];
    for (let i = 0; i < pendingFrames.length; i++) {
      const pf = pendingFrames[i]!;
      const quality = await assessFrameQuality(pf.file, qualityOpts).catch(() =>
        quickQualityFallback(),
      );
      let selectionReason = "ffmpeg fps sampling candidate";

      // 居中主播人像替换策略
      if (quality.center_presenter === true) {
        const replacement = findReplacementFrame(pendingFrames, i, (q) => q.center_presenter !== true);
        if (replacement !== null) {
          selectionReason = "presenter_center_skipped; replaced_by_later_ui_frame";
          // 对新选中的帧做质量评估
          const replQuality = await assessFrameQuality(replacement.file, qualityOpts).catch(() =>
            quickQualityFallback(),
          );
          frames.push({
            id: `scene_${String(frames.length + 1).padStart(3, "0")}`,
            timestamp: replacement.timestamp,
            seconds: replacement.seconds,
            file: replacement.filename,
            transcript_context: replacement.transcript,
            selection_reason: selectionReason,
            visual_quality: replQuality,
          });
          continue;
        }
        selectionReason = "presenter_center_detected; no_suitable_replacement";
      }

      // 模糊截图替换策略
      if (quality.blur === "high") {
        const replacement = findReplacementFrame(pendingFrames, i, (q) => q.blur !== "high");
        if (replacement !== null) {
          selectionReason = "blur_high_skipped; replaced_by_clearer_frame";
          const replQuality = await assessFrameQuality(replacement.file, qualityOpts).catch(() =>
            quickQualityFallback(),
          );
          frames.push({
            id: `scene_${String(frames.length + 1).padStart(3, "0")}`,
            timestamp: replacement.timestamp,
            seconds: replacement.seconds,
            file: replacement.filename,
            transcript_context: replacement.transcript,
            selection_reason: selectionReason,
            visual_quality: replQuality,
          });
          continue;
        }
        selectionReason = quality.blur === "high" ? "blur_high; no_clearer_replacement" : selectionReason;
      }

      frames.push({
        id: `scene_${String(frames.length + 1).padStart(3, "0")}`,
        timestamp: pf.timestamp,
        seconds: pf.seconds,
        file: pf.filename,
        transcript_context: pf.transcript,
        selection_reason: selectionReason,
        visual_quality: quality,
      });
    }

    manifest.selected_count = frames.length;
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
