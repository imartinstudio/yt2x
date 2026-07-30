import type { DubLineTiming, DubScript, DubTimingReport, TtsPort } from "@yt2x/core";
import { defaultProcessRunner, type ProcessRunner } from "../process/index.js";
import { writeDubLineAudio } from "./file-store.js";

/**
 * 逐句合成 + ffprobe 实测 + 汇总时长报告。
 *
 * PR1 的全部意义就是这份报告：PR3 的门禁阈值必须从真实分布里定，拍脑袋的阈值会全错。
 */

/**
 * 合成一律用倍率 1.0。
 *
 * 掺了调速的样本会让分布失真——一句被压到 1.3 倍才装下的话，记录下来的 ratio 会
 * 显示"刚好装下"，等于把问题藏起来。要看的是自然语速下到底超了多少。
 */
export const SYNTHESIS_RATE = 1;

const FFPROBE_TIMEOUT_MS = 15_000;

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

export type SynthesizeDubLinesInput = {
  tts: TtsPort;
  script: DubScript;
  voice: string;
  /** 配音产物目录，音频写进 <dubDir>/lines/。 */
  dubDir: string;
  runner?: ProcessRunner;
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

    const written = await writeDubLineAudio(input.dubDir, line.index, result.audio, result.format);
    const synthesizedMs = await probeAudioDurationMs({
      filePath: written.absolutePath,
      ...(input.runner !== undefined ? { runner: input.runner } : {}),
      ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    timings.push({
      index: line.index,
      targetDurationMs: line.targetDurationMs,
      synthesizedMs,
      // 目标时长为 0 的行（字幕时间戳异常）除下去会得到 Infinity，记 0 更好排查
      ratio: line.targetDurationMs > 0 ? synthesizedMs / line.targetDurationMs : 0,
      charCount: line.text.length,
      audioFile: written.relativePath,
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
