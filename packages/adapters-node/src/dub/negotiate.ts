import { randomUUID } from "node:crypto";
import {
  DEFAULT_MIN_INTER_SENTENCE_PAUSE_MS,
  FIT_SLACK_MS,
  MIN_GAP_KEEP_MS,
  type DubNegotiatePlan,
  type DubPlacedLine,
  type DubPlacementReport,
  type TtsPort,
} from "@yt2x/core";
import type { ProcessRunner } from "../process/index.js";
import { materializeLineAudio } from "./synthesize.js";

/**
 * 执行时长协商计划：按需调速重合成，其余顺延，产出最终落点。
 *
 * keep 行直接复用 PR1 的 lines/*.mp3；speed / stretch 都要按协商的 rate 重新
 * 合成，覆盖同名文件。调速（无论加速还是放慢）后仍明显溢出目标区间时降为
 * delay，保证整条链总能跑完。落点同样遵守最小句间停顿（与 plan 层一致）。
 *
 * 原第三档 shorten（LLM 事后改短）已删除：冗余现在由长度受限翻译在生成配音稿
 * 阶段挤掉，见 docs/DUB-TASK.md。因此本函数不再需要 LLM。
 */

export type ApplyDubNegotiationInput = {
  plan: DubNegotiatePlan;
  tts: TtsPort;
  voice: string;
  dubDir: string;
  /** keep/delay 行已有的相对路径（来自 timing 报告）。 */
  existingAudioByIndex: ReadonlyMap<number, string>;
  runner?: ProcessRunner;
  ffprobePath?: string;
  ffmpegPath?: string;
  signal?: AbortSignal;
  onLineDone?: (done: number, total: number) => void;
  /** 相邻落点最小间隔；默认与 plan 层一致。 */
  minInterSentencePauseMs?: number;
};

export type ApplyDubNegotiationResult = {
  report: DubPlacementReport;
  warnings: string[];
};

const synthesizeLine = async (
  input: ApplyDubNegotiationInput,
  text: string,
  rate: number,
  index: number,
): Promise<{ durationMs: number; audioFile: string }> => {
  const result = await input.tts.synthesize({
    text,
    voice: input.voice,
    rate,
    format: "mp3",
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const measured = await materializeLineAudio({
    result,
    lineIndex: index,
    engine: input.tts.id,
    dubDir: input.dubDir,
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
    ...(input.ffmpegPath !== undefined ? { ffmpegPath: input.ffmpegPath } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  return { durationMs: measured.synthesizedMs, audioFile: measured.relativePath };
};

export const applyDubNegotiation = async (
  input: ApplyDubNegotiationInput,
): Promise<ApplyDubNegotiationResult> => {
  const warnings: string[] = [];

  const placed: DubPlacedLine[] = [];
  let drift = 0;
  let keepCount = 0;
  let speedCount = 0;
  let stretchCount = 0;
  let delayCount = 0;
  const total = input.plan.lines.length;
  const minInterSentencePauseMs =
    input.minInterSentencePauseMs ?? DEFAULT_MIN_INTER_SENTENCE_PAUSE_MS;

  for (let i = 0; i < input.plan.lines.length; i += 1) {
    const plan = input.plan.lines[i]!;
    const startMs = plan.originalStartMs + drift;
    let action = plan.action;
    const text = plan.text;
    const rate = plan.rate;
    let durationMs: number;
    let audioFile: string;

    if (action === "keep" || action === "delay") {
      const existing = input.existingAudioByIndex.get(plan.index);
      if (existing === undefined) {
        // 缺文件时重合成，避免整条链断掉
        const synth = await synthesizeLine(input, text, 1, plan.index);
        durationMs = synth.durationMs;
        audioFile = synth.audioFile;
        warnings.push(`line ${plan.index}: missing audio, re-synthesized at rate 1.0`);
      } else {
        durationMs = plan.naturalMs;
        audioFile = existing;
      }
      if (action === "keep") keepCount += 1;
      else delayCount += 1;
    } else {
      // speed（加速）或 stretch（反向放慢填充富余），都要按协商的 rate 重合成
      const synth = await synthesizeLine(input, text, rate, plan.index);
      durationMs = synth.durationMs;
      audioFile = synth.audioFile;
      // 调速后仍明显溢出目标区间 → 当 delay 处理漂移（stretch 理论上不该溢出，
      // 但引擎的调速不总是线性，保留同一道安全网）
      if (durationMs > plan.targetDurationMs + FIT_SLACK_MS) {
        warnings.push(
          `line ${plan.index}: ${action} rate ${rate.toFixed(3)} still overflowed (${durationMs}ms > ${plan.targetDurationMs}ms)`,
        );
        action = "delay";
        delayCount += 1;
      } else if (action === "stretch") {
        stretchCount += 1;
      } else {
        speedCount += 1;
      }
    }

    const endMs = startMs + durationMs;
    placed.push({
      index: plan.index,
      action,
      rate,
      text,
      startMs,
      endMs,
      durationMs,
      audioFile,
    });

    const overflow = durationMs - plan.targetDurationMs;
    drift = Math.max(0, drift + overflow);

    const next = input.plan.lines[i + 1];
    if (next !== undefined) {
      const gap = next.originalStartMs - plan.originalEndMs;
      const absorbable = Math.max(0, gap - MIN_GAP_KEEP_MS);
      drift = Math.max(0, drift - absorbable);

      const minNextStart = endMs + minInterSentencePauseMs;
      const nextStart = next.originalStartMs + drift;
      if (nextStart < minNextStart) {
        drift += minNextStart - nextStart;
      }
    }

    input.onLineDone?.(i + 1, total);
  }

  const audioEndMs = placed.length > 0 ? placed[placed.length - 1]!.endMs : 0;
  const report: DubPlacementReport = {
    version: 3,
    // 每次调用都生成新值，让落点报告能自证属于哪一次协商执行——不必靠比对文件
    // 系统修改时间推断新鲜度（见 issue #110 的事故记录）。
    runId: randomUUID(),
    generatedAt: new Date().toISOString(),
    videoId: input.plan.videoId,
    engine: input.tts.id,
    voice: input.voice,
    lines: placed,
    extendMs: Math.round(drift),
    audioEndMs,
    speedCount,
    stretchCount,
    delayCount,
    keepCount,
  };

  return { report, warnings };
};
