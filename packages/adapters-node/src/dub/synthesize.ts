import { rename, rm } from "node:fs/promises";
import type { DubLineTiming, DubScript, DubTimingReport, TtsPort } from "@yt2x/core";
import { defaultProcessRunner, type ProcessRunner } from "../process/index.js";
import { writeDubLineAudio } from "./file-store.js";

/**
 * 逐句合成 + 裁前置静音 + ffprobe 实测 + 汇总时长报告。
 *
 * PR1 的全部意义就是这份报告：PR3 的门禁阈值必须从真实分布里定，拍脑袋的阈值会全错。
 * edge-tts / ElevenLabs 文件头常带 ~200ms 前置静音；若不裁掉，字幕会早于人声，
 * 且协商会按虚高时长做不必要的加速/改短（issue #108 / PR #112）。
 *
 * 只裁前置、保留句尾：句尾静音是自然停顿/轻声尾音，与引擎 padding 同能量口径无法区分。
 */

/**
 * 合成一律用倍率 1.0。
 *
 * 掺了调速的样本会让分布失真——一句被压到 1.3 倍才装下的话，记录下来的 ratio 会
 * 显示"刚好装下"，等于把问题藏起来。要看的是自然语速下到底超了多少。
 */
export const SYNTHESIS_RATE = 1;

/**
 * 只剥文件头的引擎 padding，不动句中气口与句尾停顿。
 * 检测口径与 issue #108 实测一致：-45dB / 50ms。
 * 不用 areverse/stop_periods：句尾轻声会被同一阈值误判成静音削掉（PR #112 听感验收）。
 */
export const TTS_LEADING_SILENCE_TRIM_FILTER =
  "silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB";

/** @deprecated 使用 {@link TTS_LEADING_SILENCE_TRIM_FILTER}；保留别名以免外部引用断裂。 */
export const TTS_EDGE_SILENCE_TRIM_FILTER = TTS_LEADING_SILENCE_TRIM_FILTER;

const FFPROBE_TIMEOUT_MS = 15_000;
const FFMPEG_TRIM_TIMEOUT_MS = 120_000;

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

/** 就地裁掉音频文件前置静音；句中与句尾保留。 */
export const trimLeadingSilence = async (input: {
  filePath: string;
  runner?: ProcessRunner;
  ffmpegPath?: string;
  signal?: AbortSignal;
}): Promise<void> => {
  const runner = input.runner ?? defaultProcessRunner;
  const ffmpegPath = input.ffmpegPath ?? "ffmpeg";
  const tmpPath = `${input.filePath}.trim-${process.pid}-${Date.now()}.mp3`;
  try {
    const result = await runner.run({
      command: ffmpegPath,
      args: [
        "-y",
        "-i",
        input.filePath,
        "-af",
        TTS_LEADING_SILENCE_TRIM_FILTER,
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        tmpPath,
      ],
      timeoutMs: FFMPEG_TRIM_TIMEOUT_MS,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `ffmpeg silence trim failed (exit ${result.exitCode}): ${result.stderr.slice(-400)}`,
      );
    }
    await rename(tmpPath, input.filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
};

/** @deprecated 使用 {@link trimLeadingSilence}。 */
export const trimLeadingTrailingSilence = trimLeadingSilence;

export type SynthesizeDubLineInput = {
  tts: TtsPort;
  text: string;
  voice: string;
  rate: number;
  index: number;
  /** 配音产物目录，音频写进 <dubDir>/lines/。 */
  dubDir: string;
  runner?: ProcessRunner;
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
};

export type SynthesizeDubLineResult = {
  durationMs: number;
  audioFile: string;
  absolutePath: string;
  /** 引擎实际使用的倍率（可能被 rateRange 裁过）。 */
  rate: number;
};

/**
 * 共享「合成单行」缝：TTS → 落盘 → 裁前置静音 → 实测裁剪后时长。
 * 初次合成与协商重合成都必须走这里，避免第三个引擎静默带回前置静音。
 */
export const synthesizeDubLine = async (
  input: SynthesizeDubLineInput,
): Promise<SynthesizeDubLineResult> => {
  const result = await input.tts.synthesize({
    text: input.text,
    voice: input.voice,
    rate: input.rate,
    format: "mp3",
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const written = await writeDubLineAudio(input.dubDir, input.index, result.audio, result.format);
  await trimLeadingSilence({
    filePath: written.absolutePath,
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    ...(input.ffmpegPath !== undefined ? { ffmpegPath: input.ffmpegPath } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const durationMs = await probeAudioDurationMs({
    filePath: written.absolutePath,
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  return {
    durationMs,
    audioFile: written.relativePath,
    absolutePath: written.absolutePath,
    rate: result.rate,
  };
};

export type SynthesizeDubLinesInput = {
  tts: TtsPort;
  script: DubScript;
  voice: string;
  /** 配音产物目录，音频写进 <dubDir>/lines/。 */
  dubDir: string;
  runner?: ProcessRunner;
  ffmpegPath?: string;
  ffprobePath?: string;
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
    const synth = await synthesizeDubLine({
      tts: input.tts,
      text: line.text,
      voice: input.voice,
      rate: SYNTHESIS_RATE,
      index: line.index,
      dubDir: input.dubDir,
      ...(input.runner !== undefined ? { runner: input.runner } : {}),
      ...(input.ffmpegPath !== undefined ? { ffmpegPath: input.ffmpegPath } : {}),
      ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (synth.rate !== SYNTHESIS_RATE) {
      // rateRange 把 1.0 裁掉说明适配器配置有问题，样本已经不可比，必须留痕
      warnings.push(
        `line ${line.index}: engine used rate ${synth.rate} instead of ${SYNTHESIS_RATE}; timing sample is not comparable`,
      );
    }

    const synthesizedMs = synth.durationMs;
    timings.push({
      index: line.index,
      targetDurationMs: line.targetDurationMs,
      synthesizedMs,
      // 目标时长为 0 的行（字幕时间戳异常）除下去会得到 Infinity，记 0 更好排查
      ratio: line.targetDurationMs > 0 ? synthesizedMs / line.targetDurationMs : 0,
      charCount: line.text.length,
      audioFile: synth.audioFile,
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
