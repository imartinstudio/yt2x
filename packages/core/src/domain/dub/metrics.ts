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
import type { DubNegotiatePlan, DubPlacedLine } from "./types.js";

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

/**
 * 升序数组上的分位数，取**最近秩**（nearest-rank）：第 ceil(p × n) 个值。
 *
 * 口径必须钉死并写出来——这些数字是用来对比两次运行的，两边算法不同会让「改善」
 * 变成算法差异。`Math.floor(n × p)` 在 n=120、p=0.95 时落在第 115 小值（约 95.8
 * 分位），系统性偏高一档；最近秩取第 114 个（索引 113），是分位数的标准定义。
 */
const percentile = (sorted: readonly number[], fraction: number): number | null => {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1]!;
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
  /** 空列表时为 null——不编造 0。 */
  medianWidth: number | null;
  p90Width: number | null;
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
  const sorted = [...widths].sort((a, b) => a - b);
  return {
    count: widths.length,
    medianWidth: percentile(sorted, 0.5),
    p90Width: percentile(sorted, 0.9),
    maxWidth: sorted.length > 0 ? sorted[sorted.length - 1]! : null,
    overBudgetCount: widths.filter((w) => w > budget).length,
  };
};

/**
 * 把协商计划投影成落点行，供重放期的指标计算使用。
 *
 * 只填指标需要的字段。`audioFile` 刻意留空：重放不读逐句音频，凭空拼一个
 * `lines/0001.mp3` 只会让人误以为那个文件被用到了，而命名规则一旦改动还要多扫一处。
 *
 * 与真实落点报告的区别在于时间取自计划的**预估**起止；这正是重放要对比的东西，
 * 所以调用方在没有覆盖参数时应当拿它与盘上落点核对一次（见 dub-replay 的一致性校验）。
 */
export const planToPlacedLines = (plan: DubNegotiatePlan): DubPlacedLine[] =>
  plan.lines.map((line) => ({
    index: line.index,
    action: line.action,
    rate: line.rate,
    text: line.text,
    startMs: line.plannedStartMs,
    endMs: line.plannedEndMs,
    durationMs: line.plannedEndMs - line.plannedStartMs,
    audioFile: "",
  }));
