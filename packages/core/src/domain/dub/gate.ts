/**
 * 配音门禁（纯函数）。
 *
 * 阈值必须用真实素材从零标定（见 issue #113）：旧 smoke 样本已删除且曾被
 * 污染，不能在旧数上微调。分层：
 *  - hard：阻断成片（空音频、极端漂移、大比例 delay、句间零/低间隔）
 *  - advisory：写进 report，不阻断（偏高的 medianRatio 等）
 */

import {
  DEFAULT_MAX_EXTEND_MS,
  DEFAULT_MIN_INTER_SENTENCE_PAUSE_MS,
} from "./negotiate.js";
import type {
  DubPlacementReport,
  DubPlacedLine,
  DubScript,
  DubTimingReport,
} from "./types.js";

export type DubGateSeverity = "hard" | "advisory";

export type DubGateIssueCode =
  | "empty-audio"
  | "empty-text"
  | "high-median-ratio"
  | "high-overflow-fraction"
  | "high-extend-ms"
  | "high-delay-fraction"
  | "info-loss"
  | "zero-inter-sentence-pause"
  | "low-inter-sentence-pause";

export type DubGateIssue = {
  code: DubGateIssueCode;
  severity: DubGateSeverity;
  message: string;
  /** 触发该问题的度量值（便于报告）。 */
  value?: number;
  threshold?: number;
};

export type DubGateThresholds = {
  /** 自然语速 medianRatio 的 advisory 上限。 */
  advisoryMedianRatio: number;
  /** 自然语速 overflow 行占比的 advisory 上限。 */
  advisoryOverflowFraction: number;
  /** 片尾冻结时长硬上限（毫秒）；与协商层 DEFAULT_MAX_EXTEND_MS 对齐。 */
  maxExtendMs: number;
  /** delay 行占比硬上限。 */
  maxDelayFraction: number;
  /**
   * 改写后文本相对 sourceText 的最低保留比例（按 Unicode 码点）。
   * 过低视为信息损失嫌疑——朗读化/改短不该砍掉大半内容。
   */
  minTextRetainFraction: number;
  /** 低于此间隔（毫秒）计为 low-gap；默认等于最小句间停顿。 */
  minInterSentencePauseMs: number;
  /** 句间间隔 < 1ms 的边界占比硬上限；0 表示不允许零间隔。 */
  maxZeroGapFraction: number;
  /** 句间间隔 < minInterSentencePauseMs 的边界占比硬上限。 */
  maxLowGapFraction: number;
};

/**
 * 从零标定的默认阈值（#113，素材 A8mokin_YOs 30s 窗实测）。
 *
 * 观测（2026-07-31，edge-tts，窗 0–30s）：
 *   minGap=150、zeroGap=0、extendMs≈1.4s、delayFraction≈0.29、
 *   overflowFraction≈0.71（中文自然语速偏长，先 advisory）、
 *   改短偶发压到 ~44% 源长 → 仍用 45% 硬拦信息损失。
 *
 * - extend ≤ 8s：与协商层封顶一致
 * - delay ≤ 35%：覆盖真实窗上缩短失败后的顺延占比，仍拦住大面积放弃对齐
 * - 零间隔 / 低于最小停顿：不允许
 * - medianRatio / overflow：advisory
 * - 文本保留 ≥ 45%
 */
export const DEFAULT_DUB_GATE_THRESHOLDS: DubGateThresholds = {
  advisoryMedianRatio: 1.35,
  advisoryOverflowFraction: 0.75,
  maxExtendMs: DEFAULT_MAX_EXTEND_MS,
  maxDelayFraction: 0.35,
  minTextRetainFraction: 0.45,
  minInterSentencePauseMs: DEFAULT_MIN_INTER_SENTENCE_PAUSE_MS,
  maxZeroGapFraction: 0,
  maxLowGapFraction: 0,
};

export type DubGateReport = {
  version: 1;
  videoId: string;
  engine: string;
  voice: string;
  passed: boolean;
  /** 任一 hard issue 即为 true。 */
  blocked: boolean;
  thresholds: DubGateThresholds;
  metrics: {
    lineCount: number;
    medianRatio: number;
    overflowCount: number;
    overflowFraction: number;
    totalDriftMs: number;
    extendMs: number;
    delayCount: number;
    delayFraction: number;
    emptyAudioCount: number;
    emptyTextCount: number;
    infoLossCount: number;
    boundaryCount: number;
    zeroGapCount: number;
    zeroGapFraction: number;
    lowGapCount: number;
    lowGapFraction: number;
    minObservedGapMs: number | null;
  };
  issues: readonly DubGateIssue[];
};

export type EvaluateDubGateInput = {
  videoId: string;
  timing: DubTimingReport;
  placement: DubPlacementReport;
  script?: DubScript;
  thresholds?: Partial<DubGateThresholds>;
};

const charLen = (text: string): number => [...text.trim()].length;

/** 相邻落点间隔（下一句 start − 上一句 end）。 */
export const interSentenceGapsMs = (lines: readonly DubPlacedLine[]): number[] => {
  const gaps: number[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    gaps.push(lines[i + 1]!.startMs - lines[i]!.endMs);
  }
  return gaps;
};

export const evaluateDubGate = (input: EvaluateDubGateInput): DubGateReport => {
  const thresholds: DubGateThresholds = {
    ...DEFAULT_DUB_GATE_THRESHOLDS,
    ...input.thresholds,
  };
  const issues: DubGateIssue[] = [];

  const timingLineCount = input.timing.lineCount;
  const lineCount = Math.max(timingLineCount, input.placement.lines.length);
  const overflowFraction =
    timingLineCount > 0 ? input.timing.overflowCount / timingLineCount : 0;
  const delayFraction = lineCount > 0 ? input.placement.delayCount / lineCount : 0;

  let emptyAudioCount = 0;
  let emptyTextCount = 0;
  for (const line of input.placement.lines) {
    if (line.durationMs <= 0 || line.audioFile.trim().length === 0) {
      emptyAudioCount += 1;
      issues.push({
        code: "empty-audio",
        severity: "hard",
        message: `line ${line.index}: empty or missing audio`,
        value: line.durationMs,
      });
    }
    if (line.text.trim().length === 0) {
      emptyTextCount += 1;
      issues.push({
        code: "empty-text",
        severity: "hard",
        message: `line ${line.index}: empty spoken text`,
      });
    }
  }

  let infoLossCount = 0;
  if (input.script !== undefined) {
    const byIndex = new Map(input.placement.lines.map((l) => [l.index, l]));
    for (const scriptLine of input.script.lines) {
      const placed = byIndex.get(scriptLine.index);
      if (placed === undefined) continue;
      const sourceLen = charLen(scriptLine.sourceText);
      const finalLen = charLen(placed.text);
      if (sourceLen <= 0) continue;
      const retain = finalLen / sourceLen;
      if (retain < thresholds.minTextRetainFraction) {
        infoLossCount += 1;
        issues.push({
          code: "info-loss",
          severity: "hard",
          message: `line ${scriptLine.index}: spoken text retained ${(retain * 100).toFixed(0)}% of source (${finalLen}/${sourceLen})`,
          value: retain,
          threshold: thresholds.minTextRetainFraction,
        });
      }
    }
  }

  const gaps = interSentenceGapsMs(input.placement.lines);
  const boundaryCount = gaps.length;
  const zeroGapCount = gaps.filter((g) => g < 1).length;
  const lowGapCount = gaps.filter((g) => g < thresholds.minInterSentencePauseMs).length;
  const zeroGapFraction = boundaryCount > 0 ? zeroGapCount / boundaryCount : 0;
  const lowGapFraction = boundaryCount > 0 ? lowGapCount / boundaryCount : 0;
  const minObservedGapMs = gaps.length > 0 ? Math.min(...gaps) : null;

  if (zeroGapFraction > thresholds.maxZeroGapFraction) {
    issues.push({
      code: "zero-inter-sentence-pause",
      severity: "hard",
      message: `zero inter-sentence gaps ${zeroGapCount}/${boundaryCount} (fraction ${zeroGapFraction.toFixed(2)}) exceed hard max ${thresholds.maxZeroGapFraction}`,
      value: zeroGapFraction,
      threshold: thresholds.maxZeroGapFraction,
    });
  }

  if (lowGapFraction > thresholds.maxLowGapFraction) {
    issues.push({
      code: "low-inter-sentence-pause",
      severity: "hard",
      message: `low inter-sentence gaps (<${thresholds.minInterSentencePauseMs}ms) ${lowGapCount}/${boundaryCount} (fraction ${lowGapFraction.toFixed(2)}) exceed hard max ${thresholds.maxLowGapFraction}`,
      value: lowGapFraction,
      threshold: thresholds.maxLowGapFraction,
    });
  }

  if (input.timing.medianRatio > thresholds.advisoryMedianRatio) {
    issues.push({
      code: "high-median-ratio",
      severity: "advisory",
      message: `median natural-rate ratio ${input.timing.medianRatio.toFixed(3)} exceeds advisory ${thresholds.advisoryMedianRatio}`,
      value: input.timing.medianRatio,
      threshold: thresholds.advisoryMedianRatio,
    });
  }

  if (overflowFraction > thresholds.advisoryOverflowFraction) {
    issues.push({
      code: "high-overflow-fraction",
      severity: "advisory",
      message: `overflow fraction ${(overflowFraction * 100).toFixed(1)}% exceeds advisory ${(thresholds.advisoryOverflowFraction * 100).toFixed(0)}%`,
      value: overflowFraction,
      threshold: thresholds.advisoryOverflowFraction,
    });
  }

  if (input.placement.extendMs > thresholds.maxExtendMs) {
    issues.push({
      code: "high-extend-ms",
      severity: "hard",
      message: `end-freeze extendMs ${input.placement.extendMs} exceeds hard max ${thresholds.maxExtendMs}`,
      value: input.placement.extendMs,
      threshold: thresholds.maxExtendMs,
    });
  }

  if (delayFraction > thresholds.maxDelayFraction) {
    issues.push({
      code: "high-delay-fraction",
      severity: "hard",
      message: `delay fraction ${(delayFraction * 100).toFixed(1)}% exceeds hard max ${(thresholds.maxDelayFraction * 100).toFixed(0)}%`,
      value: delayFraction,
      threshold: thresholds.maxDelayFraction,
    });
  }

  const blocked = issues.some((i) => i.severity === "hard");

  return {
    version: 1,
    videoId: input.videoId,
    engine: input.placement.engine,
    voice: input.placement.voice,
    passed: !blocked,
    blocked,
    thresholds,
    metrics: {
      lineCount,
      medianRatio: input.timing.medianRatio,
      overflowCount: input.timing.overflowCount,
      overflowFraction,
      totalDriftMs: input.timing.totalDriftMs,
      extendMs: input.placement.extendMs,
      delayCount: input.placement.delayCount,
      delayFraction,
      emptyAudioCount,
      emptyTextCount,
      infoLossCount,
      boundaryCount,
      zeroGapCount,
      zeroGapFraction,
      lowGapCount,
      lowGapFraction,
      minObservedGapMs,
    },
    issues,
  };
};
