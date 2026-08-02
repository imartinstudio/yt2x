import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  DubLineTiming,
  DubScript,
  DubTimingReport,
  TtsPort,
  TtsResult,
  TtsSpeechTiming,
} from "@yt2x/core";
import { defaultProcessRunner, type ProcessRunner } from "../process/index.js";
import { writeDubLineAudio } from "./file-store.js";

/**
 * 逐句合成 + 引擎时间戳时长 + ffprobe 交叉校验 + 汇总时长报告。
 *
 * 自然语速时长取自 `TtsResult.speechTiming`（扣掉前置 padding），不再用整文件
 * ffprobe。ffprobe 只断言：时间戳语音终点不得超过文件实际时长。
 */

/**
 * 合成一律用倍率 1.0。
 *
 * 掺了调速的样本会让分布失真——一句被压到 1.3 倍才装下的话，记录下来的 ratio 会
 * 显示"刚好装下"，等于把问题藏起来。要看的是自然语速下到底超了多少。
 */
export const SYNTHESIS_RATE = 1;

const FFPROBE_TIMEOUT_MS = 15_000;
const FFMPEG_TIMEOUT_MS = 60_000;

export type ProbeAudioDurationInput = {
  filePath: string;
  runner?: ProcessRunner;
  ffprobePath?: string;
  signal?: AbortSignal;
};

/** ffprobe 实测秒数 → 毫秒。绝不用字符数估算：不同音色的语速差得很远。 */
export const probeAudioDurationMs = async (input: ProbeAudioDurationInput): Promise<number> => {
  const runner = input.runner ?? defaultProcessRunner;
  const result = await runner.run({
    command: input.ffprobePath ?? "ffprobe",
    args: [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      input.filePath,
    ],
    timeoutMs: FFPROBE_TIMEOUT_MS,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const seconds = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe returned no usable duration for ${input.filePath}`);
  }
  return Math.round(seconds * 1000);
};

/** 偶数个样本取中间两个的平均值，避免长视频里一个离群值把中位数带偏。 */
export const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export const requireTtsSpeechTiming = (
  result: TtsResult,
  context: { lineIndex: number; engine: string },
): TtsSpeechTiming => {
  if (result.speechTiming === undefined) {
    throw new Error(
      `line ${context.lineIndex}: TTS engine "${context.engine}" returned no speechTiming; ` +
        "refusing silent fallback to whole-file duration",
    );
  }
  const { speechStartMs, speechEndMs, speechDurationMs } = result.speechTiming;
  if (
    !Number.isFinite(speechStartMs) ||
    !Number.isFinite(speechEndMs) ||
    !Number.isFinite(speechDurationMs) ||
    speechStartMs < 0 ||
    speechEndMs <= speechStartMs ||
    speechDurationMs <= 0
  ) {
    throw new Error(
      `line ${context.lineIndex}: TTS speechTiming is invalid ` +
        `(start=${speechStartMs}, end=${speechEndMs}, duration=${speechDurationMs})`,
    );
  }
  return result.speechTiming;
};

/**
 * 引擎字幕时间戳与 ffprobe 文件时长各自独立取整到毫秒，因此哪怕两者测的是同一段
 * 音频，也可能相差 1ms。这个容差只吸收取整误差，不放过真实的时间戳越界。
 */
export const SPEECH_END_TOLERANCE_MS = 2;

export const assertSpeechEndWithinFile = (input: {
  lineIndex: number;
  speechEndMs: number;
  fileDurationMs: number;
}): void => {
  if (input.speechEndMs > input.fileDurationMs + SPEECH_END_TOLERANCE_MS) {
    throw new Error(
      `line ${input.lineIndex}: engine speech end ${input.speechEndMs}ms ` +
        `exceeds audio file duration ${input.fileDurationMs}ms`,
    );
  }
};

export type TrimAudioToSpeechWindowInput = {
  sourcePath: string;
  outputPath: string;
  speechStartMs: number;
  speechEndMs: number;
  runner?: ProcessRunner;
  ffmpegPath?: string;
  signal?: AbortSignal;
};

/**
 * 按引擎时间戳裁掉前置 padding 与句尾空白。不是静音检测——窗口完全来自时间戳。
 */
export const trimAudioToSpeechWindow = async (
  input: TrimAudioToSpeechWindowInput,
): Promise<void> => {
  const runner = input.runner ?? defaultProcessRunner;
  const startSec = (input.speechStartMs / 1000).toFixed(3);
  const endSec = (input.speechEndMs / 1000).toFixed(3);
  await runner.run({
    command: input.ffmpegPath ?? "ffmpeg",
    args: [
      "-y",
      "-i",
      input.sourcePath,
      "-ss",
      startSec,
      "-to",
      endSec,
      "-c:a",
      "libmp3lame",
      "-q:a",
      "2",
      input.outputPath,
    ],
    timeoutMs: FFMPEG_TIMEOUT_MS,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
};

const needsSpeechWindowTrim = (
  timing: TtsSpeechTiming,
  fileDurationMs: number,
): boolean => timing.speechStartMs > 0 || timing.speechEndMs < fileDurationMs;

export type MaterializeLineAudioInput = {
  result: TtsResult;
  lineIndex: number;
  engine: string;
  dubDir: string;
  runner?: ProcessRunner;
  ffprobePath?: string;
  ffmpegPath?: string;
  signal?: AbortSignal;
};

export type MaterializeLineAudioResult = {
  synthesizedMs: number;
  relativePath: string;
  speechTiming: TtsSpeechTiming;
};

/**
 * 写出逐句音频：引擎时间戳定时长，ffprobe 交叉校验，必要时按时间戳裁窗。
 */
export const materializeLineAudio = async (
  input: MaterializeLineAudioInput,
): Promise<MaterializeLineAudioResult> => {
  const speechTiming = requireTtsSpeechTiming(input.result, {
    lineIndex: input.lineIndex,
    engine: input.engine,
  });

  const written = await writeDubLineAudio(
    input.dubDir,
    input.lineIndex,
    input.result.audio,
    input.result.format,
  );

  const fileDurationMs = await probeAudioDurationMs({
    filePath: written.absolutePath,
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  assertSpeechEndWithinFile({
    lineIndex: input.lineIndex,
    speechEndMs: speechTiming.speechEndMs,
    fileDurationMs,
  });

  if (needsSpeechWindowTrim(speechTiming, fileDurationMs)) {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-dub-trim-"));
    const trimmedPath = path.join(workDir, `trimmed.${input.result.format}`);
    try {
      await trimAudioToSpeechWindow({
        sourcePath: written.absolutePath,
        outputPath: trimmedPath,
        speechStartMs: speechTiming.speechStartMs,
        speechEndMs: speechTiming.speechEndMs,
        ...(input.runner !== undefined ? { runner: input.runner } : {}),
        ...(input.ffmpegPath !== undefined ? { ffmpegPath: input.ffmpegPath } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      const trimmed = await readFile(trimmedPath);
      if (trimmed.byteLength === 0) {
        throw new Error(`line ${input.lineIndex}: ffmpeg speech-window trim wrote empty audio`);
      }
      await writeFile(written.absolutePath, trimmed);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    // 裁窗后再测：混音按 synthesizedMs 推 cursor，必须与真实文件时长一致
    const measuredMs = await probeAudioDurationMs({
      filePath: written.absolutePath,
      ...(input.runner !== undefined ? { runner: input.runner } : {}),
      ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    return {
      synthesizedMs: measuredMs,
      relativePath: written.relativePath,
      speechTiming,
    };
  }

  return {
    synthesizedMs: speechTiming.speechDurationMs,
    relativePath: written.relativePath,
    speechTiming,
  };
};

export type SynthesizeDubLinesInput = {
  tts: TtsPort;
  script: DubScript;
  voice: string;
  /** 配音产物目录，音频写进 <dubDir>/lines/。 */
  dubDir: string;
  runner?: ProcessRunner;
  ffprobePath?: string;
  ffmpegPath?: string;
  signal?: AbortSignal;
  onLineDone?: (done: number, total: number) => void;
};

export type SynthesizeDubLinesResult = {
  report: DubTimingReport;
  warnings: string[];
};

export const synthesizeDubLines = async (
  input: SynthesizeDubLinesInput,
): Promise<SynthesizeDubLinesResult> => {
  const warnings: string[] = [];
  const timings: DubLineTiming[] = [];
  const total = input.script.lines.length;
  let done = 0;

  for (const line of input.script.lines) {
    const result = await input.tts.synthesize({
      text: line.text,
      voice: input.voice,
      rate: SYNTHESIS_RATE,
      format: "mp3",
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (result.rate !== SYNTHESIS_RATE) {
      // rateRange 把 1.0 裁掉说明适配器配置有问题，样本已经不可比，必须留痕
      warnings.push(
        `line ${line.index}: engine used rate ${result.rate} instead of ${SYNTHESIS_RATE}; timing sample is not comparable`,
      );
    }

    const measured = await materializeLineAudio({
      result,
      lineIndex: line.index,
      engine: input.tts.id,
      dubDir: input.dubDir,
      ...(input.runner !== undefined ? { runner: input.runner } : {}),
      ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
      ...(input.ffmpegPath !== undefined ? { ffmpegPath: input.ffmpegPath } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    timings.push({
      index: line.index,
      targetDurationMs: line.targetDurationMs,
      synthesizedMs: measured.synthesizedMs,
      // 目标时长为 0 的行（字幕时间戳异常）除下去会得到 Infinity，记 0 更好排查
      ratio: line.targetDurationMs > 0 ? measured.synthesizedMs / line.targetDurationMs : 0,
      charCount: line.text.length,
      audioFile: measured.relativePath,
    });

    done += 1;
    input.onLineDone?.(done, total);
  }

  const totalTargetMs = timings.reduce((sum, t) => sum + t.targetDurationMs, 0);
  const totalSynthesizedMs = timings.reduce((sum, t) => sum + t.synthesizedMs, 0);

  const report: DubTimingReport = {
    version: 1,
    videoId: input.script.videoId,
    engine: input.tts.id,
    voice: input.voice,
    lineCount: timings.length,
    medianRatio: median(timings.map((t) => t.ratio)),
    overflowCount: timings.filter((t) => t.ratio > 1).length,
    totalDriftMs: totalSynthesizedMs - totalTargetMs,
    lines: timings,
  };

  return { report, warnings };
};
