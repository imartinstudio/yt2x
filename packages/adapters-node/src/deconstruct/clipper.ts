import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { SectionCandidate } from "@yt2x/core";
import { defaultProcessRunner } from "../process/runner.js";
import { secondsToTimecode, candidateVideoFilename } from "./generator.js";

/**
 * 清除输出目录中旧的候选视频文件。
 */
const cleanOldCandidates = async (outputDir: string): Promise<void> => {
  try {
    const files = await readdir(outputDir);
    const oldCandidates = files.filter((f) => f.startsWith("candidate-") && f.endsWith(".mp4"));
    await Promise.all(oldCandidates.map((f) => unlink(path.join(outputDir, f)).catch(() => {})));
  } catch {
    // Directory doesn't exist yet — that's fine
  }
};

export type ClipResult = {
  /** 裁剪后的视频文件路径 */
  path: string;
  /** 候选信息 */
  candidate: SectionCandidate;
  /** 裁剪是否成功 */
  success: boolean;
  /** 错误信息（如有） */
  error?: string;
};

/**
 * 使用 ffmpeg 从源视频裁剪多个候选视频片段。
 *
 * @param videoPath 源视频文件路径
 * @param candidates 要裁剪的候选章节列表
 * @param outputDir 输出目录（clips/）
 * @param signal 可选的 AbortSignal
 * @returns 裁剪结果列表
 */
export const clipCandidates = async (
  videoPath: string,
  candidates: SectionCandidate[],
  outputDir: string,
  signal?: AbortSignal,
): Promise<ClipResult[]> => {
  await mkdir(outputDir, { recursive: true });

  // 清除旧的候选文件，避免混合残留
  await cleanOldCandidates(outputDir);

  const results: ClipResult[] = [];

  for (const candidate of candidates) {
    const filename = candidateVideoFilename(candidate);
    const outPath = path.join(outputDir, filename);

    // Calculate duration from timecodes
    const startSec = candidate.timecodes.startSec;
    const endSec = candidate.timecodes.endSec;
    const durationSec = endSec - startSec;

    if (durationSec <= 0) {
      results.push({
        path: outPath,
        candidate,
        success: false,
        error: `Invalid duration: ${durationSec}s (start=${startSec}, end=${endSec})`,
      });
      continue;
    }

    const processSpec: Parameters<typeof defaultProcessRunner.run>[0] = {
      command: "ffmpeg",
      args: [
        "-y",
        "-ss", secondsToTimecode(startSec),
        "-i", videoPath,
        "-t", String(Math.ceil(durationSec)),
        "-map", "0:v:0",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        outPath,
      ],
      timeoutMs: Math.min(durationSec * 5000 + 60_000, 900_000),
    };
    if (signal !== undefined) {
      (processSpec as { signal?: AbortSignal }).signal = signal;
    }

    try {
      await defaultProcessRunner.run(processSpec);

      results.push({
        path: outPath,
        candidate,
        success: true,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        path: outPath,
        candidate,
        success: false,
        error: message,
      });
    }
  }

  return results;
};
