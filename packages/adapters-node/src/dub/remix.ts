import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DubPlacedLine } from "@yt2x/core";
import { burnSubtitles } from "../acquire/burn-subtitles.js";
import { detectBurnedSubtitles } from "../acquire/detect-burned-subs.js";
import { defaultProcessRunner, type ProcessRunner } from "../process/index.js";
import { probeAudioDurationMs } from "./synthesize.js";

/**
 * 混音 + 可选字幕重烧 → full.zh-dubbed.mp4。
 *
 * 1. 按落点把逐句 mp3 拼成完整人声轨（句间补静音）
 * 2. 与 Demucs no_vocals 混合；音轨长度对齐「原片 + 冻结延长」，不是止于最后一句人声
 * 3. 画面 tpad 冻结末帧补到同一长度（决策 #11）
 * 4. 换成混合音轨；若原片无中文硬字幕，再烧反向 SRT
 *
 * 注意：绝不用 `-shortest` 收尾——它会把刚 tpad 出的冻结帧按短音频砍掉，
 * 使决策 #11 变成死代码。改用显式 `-t` 锁定成片时长。
 */

export const DUBBED_VIDEO_NAME = "full.zh-dubbed.mp4";
export const DUB_REVERSE_SRT_NAME = "full.zh-dub.srt";

const FFMPEG_TIMEOUT_MS = 60 * 60 * 1000;

/** 成片时长：覆盖完整原片（含片尾 BGM），并容纳协商残留漂移。 */
export const computeDubbedOutputDurationMs = (input: {
  voiceEndMs: number;
  videoDurationMs: number;
  extendMs: number;
}): number => {
  const extend = Math.max(0, input.extendMs);
  return Math.max(input.voiceEndMs, input.videoDurationMs + extend);
};

/** 人声与 BGM 都 apad 到成片时长，避免 amix duration=first 被人声截断。 */
export const mixVoiceAndBgmFilterComplex = (durationSec: number): string => {
  const whole = durationSec.toFixed(3);
  return [
    `[0:a]aformat=sample_rates=44100:channel_layouts=mono,volume=1.0,apad=whole_dur=${whole}[voice]`,
    `[1:a]aformat=sample_rates=44100:channel_layouts=mono,volume=0.7,apad=whole_dur=${whole}[bgm]`,
    `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
  ].join(";");
};

export const buildMuxDubbedVideoArgs = (input: {
  videoPath: string;
  audioPath: string;
  outputPath: string;
  /** 画面需要冻结的毫秒数（outputMs - videoDurationMs）。 */
  videoPadMs: number;
  /** 成片总时长；与音轨对齐，用 -t 锁定，不用 -shortest。 */
  outputDurationMs: number;
}): string[] => {
  const outputSec = (input.outputDurationMs / 1000).toFixed(3);
  const args = ["-y", "-i", input.videoPath, "-i", input.audioPath];
  if (input.videoPadMs > 0) {
    const padSec = (input.videoPadMs / 1000).toFixed(3);
    args.push(
      "-filter_complex",
      `[0:v]tpad=stop_mode=clone:stop_duration=${padSec}[v]`,
      "-map",
      "[v]",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-c:a",
      "copy",
      "-t",
      outputSec,
      input.outputPath,
    );
  } else {
    args.push(
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-t",
      outputSec,
      input.outputPath,
    );
  }
  return args;
};

export type RemixDubbedVideoInput = {
  videoPath: string;
  noVocalsPath: string;
  placedLines: readonly DubPlacedLine[];
  /** 配音目录，用于解析 audioFile 相对路径。 */
  dubDir: string;
  /** 反向 SRT 文本（可空——空则不烧字幕）。 */
  reverseSrt?: string;
  /** 成片输出路径，通常 article/.../video/full.zh-dubbed.mp4。 */
  outputPath: string;
  /** 反向 SRT 落盘路径；提供且 reverseSrt 非空时写入。 */
  reverseSrtPath?: string;
  extendMs: number;
  runner?: ProcessRunner;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** 原片已有中文硬字幕时跳过烧录（默认 true）。 */
  skipBurnIfChineseBurned?: boolean;
  /** 强制不烧字幕。 */
  skipBurn?: boolean;
  signal?: AbortSignal;
  watermarkVideo?: string;
  watermarkXlate?: string;
};

export type RemixDubbedVideoResult = {
  outputPath: string;
  burned: boolean;
  skippedBurnReason?: string;
  voiceTrackPath: string;
  mixedAudioPath: string;
  extendMs: number;
};

const runFfmpeg = async (
  runner: ProcessRunner,
  ffmpegPath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<void> => {
  const result = await runner.run({
    command: ffmpegPath,
    args: [...args],
    timeoutMs: FFMPEG_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`);
  }
};

/**
 * 用 concat demuxer 拼人声轨：前导静音 + 句 + 句间静音 + …
 * 总时长至少覆盖到最后一句 endMs。
 */
export const buildVoiceTrack = async (input: {
  placedLines: readonly DubPlacedLine[];
  dubDir: string;
  outputPath: string;
  runner: ProcessRunner;
  ffmpegPath: string;
  workDir: string;
  signal?: AbortSignal;
}): Promise<number> => {
  if (input.placedLines.length === 0) {
    throw new Error("cannot build voice track: no placed lines");
  }

  const listPath = path.join(input.workDir, "voice-concat.txt");
  const silenceDir = path.join(input.workDir, "silence");
  await mkdir(silenceDir, { recursive: true });

  const entries: string[] = [];
  let cursor = 0;
  let silenceSeq = 0;

  const pushSilence = async (durationMs: number): Promise<void> => {
    if (durationMs <= 0) return;
    const sec = (durationMs / 1000).toFixed(3);
    const silencePath = path.join(silenceDir, `s${silenceSeq}.wav`);
    silenceSeq += 1;
    await runFfmpeg(input.runner, input.ffmpegPath, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=44100:cl=mono`,
      "-t",
      sec,
      "-c:a",
      "pcm_s16le",
      silencePath,
    ], input.signal);
    entries.push(`file '${silencePath.replace(/'/g, "'\\''")}'`);
    cursor += durationMs;
  };

  for (const line of input.placedLines) {
    const gap = Math.round(line.startMs) - cursor;
    if (gap > 0) await pushSilence(gap);
    else if (gap < 0) {
      // 重叠：仍拼接，听感上会叠字，但比丢句强；上层 reverse-srt 已尽量推开
    }
    const audioPath = path.resolve(input.dubDir, line.audioFile);
    entries.push(`file '${audioPath.replace(/'/g, "'\\''")}'`);
    cursor = Math.max(cursor, Math.round(line.startMs)) + Math.round(line.durationMs);
  }

  await writeFile(listPath, `${entries.join("\n")}\n`, "utf8");
  await runFfmpeg(input.runner, input.ffmpegPath, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c:a",
    "pcm_s16le",
    "-ar",
    "44100",
    "-ac",
    "1",
    input.outputPath,
  ], input.signal);

  return cursor;
};

/** 人声 + BGM 混合为单一音轨；`durationMs` 必须是成片目标时长（含原片尾 + 冻结）。 */
export const mixVoiceAndBgm = async (input: {
  voicePath: string;
  noVocalsPath: string;
  outputPath: string;
  durationMs: number;
  runner: ProcessRunner;
  ffmpegPath: string;
  signal?: AbortSignal;
}): Promise<void> => {
  const durationSec = (input.durationMs / 1000).toFixed(3);
  await runFfmpeg(input.runner, input.ffmpegPath, [
    "-y",
    "-i",
    input.voicePath,
    "-i",
    input.noVocalsPath,
    "-filter_complex",
    mixVoiceAndBgmFilterComplex(Number.parseFloat(durationSec)),
    "-map",
    "[mix]",
    "-t",
    durationSec,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    input.outputPath,
  ], input.signal);
};

/**
 * 把混合音轨接到画面上；`videoPadMs > 0` 时用 tpad 冻结末帧。
 * 成片时长由 `-t outputDurationMs` 锁定，故意不用 `-shortest`。
 */
export const muxDubbedVideo = async (input: {
  videoPath: string;
  audioPath: string;
  outputPath: string;
  videoPadMs: number;
  outputDurationMs: number;
  runner: ProcessRunner;
  ffmpegPath: string;
  signal?: AbortSignal;
}): Promise<void> => {
  await runFfmpeg(
    input.runner,
    input.ffmpegPath,
    buildMuxDubbedVideoArgs({
      videoPath: input.videoPath,
      audioPath: input.audioPath,
      outputPath: input.outputPath,
      videoPadMs: input.videoPadMs,
      outputDurationMs: input.outputDurationMs,
    }),
    input.signal,
  );
};

export const remixDubbedVideo = async (
  input: RemixDubbedVideoInput,
): Promise<RemixDubbedVideoResult> => {
  const runner = input.runner ?? defaultProcessRunner;
  const ffmpegPath = input.ffmpegPath ?? "ffmpeg";
  const skipBurnIfChineseBurned = input.skipBurnIfChineseBurned !== false;

  await mkdir(path.dirname(input.outputPath), { recursive: true });

  if (input.reverseSrt !== undefined && input.reverseSrtPath !== undefined && input.reverseSrt.length > 0) {
    await mkdir(path.dirname(input.reverseSrtPath), { recursive: true });
    await writeFile(input.reverseSrtPath, input.reverseSrt.endsWith("\n") ? input.reverseSrt : `${input.reverseSrt}\n`, "utf8");
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-dub-remix-"));
  const voiceTrackPath = path.join(input.dubDir, "voice.wav");
  const mixedAudioPath = path.join(input.dubDir, "mixed.m4a");
  const muxedPath = path.join(workDir, "muxed.mp4");
  await mkdir(input.dubDir, { recursive: true });

  try {
    const voiceEndMs = await buildVoiceTrack({
      placedLines: input.placedLines,
      dubDir: input.dubDir,
      outputPath: voiceTrackPath,
      runner,
      ffmpegPath,
      workDir,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    const videoDurationMs = await probeAudioDurationMs({
      filePath: input.videoPath,
      runner,
      ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    const outputDurationMs = computeDubbedOutputDurationMs({
      voiceEndMs: Math.max(
        voiceEndMs,
        input.placedLines.length > 0 ? input.placedLines[input.placedLines.length - 1]!.endMs : 0,
      ),
      videoDurationMs,
      extendMs: Math.max(0, input.extendMs),
    });
    const videoPadMs = Math.max(0, outputDurationMs - videoDurationMs);

    await mixVoiceAndBgm({
      voicePath: voiceTrackPath,
      noVocalsPath: input.noVocalsPath,
      outputPath: mixedAudioPath,
      durationMs: outputDurationMs,
      runner,
      ffmpegPath,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    await muxDubbedVideo({
      videoPath: input.videoPath,
      audioPath: mixedAudioPath,
      outputPath: muxedPath,
      videoPadMs,
      outputDurationMs,
      runner,
      ffmpegPath,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    let burned = false;
    let skippedBurnReason: string | undefined;
    const shouldConsiderBurn =
      input.skipBurn !== true &&
      input.reverseSrtPath !== undefined &&
      input.reverseSrt !== undefined &&
      input.reverseSrt.trim().length > 0;

    if (shouldConsiderBurn) {
      let skipBurn = false;
      if (skipBurnIfChineseBurned) {
        const detect = await detectBurnedSubtitles(input.videoPath, runner, {
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
        if (detect.shouldSkipBurn) {
          skipBurn = true;
          skippedBurnReason = "chinese_burned_detected";
        }
      }
      if (!skipBurn) {
        await burnSubtitles({
          videoPath: muxedPath,
          srtPath: input.reverseSrtPath!,
          outputPath: input.outputPath,
          runner,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          ...(input.watermarkVideo !== undefined ? { watermarkVideo: input.watermarkVideo } : {}),
          ...(input.watermarkXlate !== undefined ? { watermarkXlate: input.watermarkXlate } : {}),
        });
        burned = true;
      } else {
        await runFfmpeg(runner, ffmpegPath, ["-y", "-i", muxedPath, "-c", "copy", input.outputPath], input.signal);
      }
    } else {
      skippedBurnReason = input.skipBurn === true ? "skip_burn_flag" : "no_reverse_srt";
      await runFfmpeg(runner, ffmpegPath, ["-y", "-i", muxedPath, "-c", "copy", input.outputPath], input.signal);
    }

    // 校验成片存在且时长可读——防止 ffmpeg 写出 0 字节文件还当成功
    await probeAudioDurationMs({
      filePath: input.outputPath,
      runner,
      ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }).catch(async () => {
      // 视频用 format=duration 也行；probeAudioDurationMs 对 mp4 同样适用
      throw new Error(`dubbed video was not produced or has no duration: ${input.outputPath}`);
    });

    return {
      outputPath: input.outputPath,
      burned,
      ...(skippedBurnReason !== undefined ? { skippedBurnReason } : {}),
      voiceTrackPath,
      mixedAudioPath,
      extendMs: Math.max(0, input.extendMs),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};
