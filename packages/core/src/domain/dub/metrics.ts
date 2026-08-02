/**
 * 配音调试指标（纯函数）。
 *
 * 与 `gate.ts` 的职责不同：门禁回答「这一版能不能交付」，这里回答「这一版比上一版
 * 好了还是坏了」。压静默、改切分这类调参工作要反复对比多组参数，需要的是分布本身，
 * 而不是一个通过/阻断的布尔值。
 *
 * 刻意给出 p90/p95 而不只是平均值：平均值会被长尾拉高，掩盖「多数句子其实衔接得很紧、
 * 问题只出在少数几处」这个真实形状——而听感上恰恰是那几处长静默最刺耳。
 */

import { visualWidth } from "./cue-split.js";

/** 长尾计数的两个门槛，与 `docs/DUB-TASK.md` 里记录的口径一致。 */
export const GAP_LONG_TAIL_MS = 1_000;
export const GAP_VERY_LONG_TAIL_MS = 2_000;

export type GapDistribution = {
  count: number;
  /** 全部间隔之和；两次运行之间最容易直接比较的一个数。 */
  totalMs: number;
  /** 空列表时为 null——不编造 0，那会和「真的一点静默都没有」混淆。 */
  medianMs: number | null;
  meanMs: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  overOneSecondCount: number;
  overTwoSecondsCount: number;
};

/** 升序数组上的分位数；空数组返回 null。 */
const percentile = (sorted: readonly number[], fraction: number): number | null => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
};

export const summarizeGaps = (gaps: readonly number[]): GapDistribution => {
  // 负间隔来自落点重叠，按 0 计——否则它会在求和时抵消掉一部分真实静默。
  const clamped = gaps.map((g) => Math.max(0, g));
  const sorted = [...clamped].sort((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((sum, g) => sum + g, 0);

  return {
    count,
    totalMs,
    medianMs: percentile(sorted, 0.5),
    meanMs: count > 0 ? totalMs / count : null,
    p90Ms: percentile(sorted, 0.9),
    p95Ms: percentile(sorted, 0.95),
    maxMs: count > 0 ? sorted[count - 1]! : null,
    overOneSecondCount: clamped.filter((g) => g > GAP_LONG_TAIL_MS).length,
    overTwoSecondsCount: clamped.filter((g) => g > GAP_VERY_LONG_TAIL_MS).length,
  };
};

export type CueWidthDistribution = {
  count: number;
  maxWidth: number | null;
  /** 超出宽度预算的显示单元条数。 */
  overBudgetCount: number;
};

/** 用与显示单元细分同一套 `visualWidth` 度量，避免两处口径打架。 */
export const summarizeCueWidths = (
  cueTexts: readonly string[],
  budget: number,
): CueWidthDistribution => {
  const widths = cueTexts.map((t) => visualWidth(t));
  return {
    count: widths.length,
    maxWidth: widths.length > 0 ? Math.max(...widths) : null,
    overBudgetCount: widths.filter((w) => w > budget).length,
  };
};
