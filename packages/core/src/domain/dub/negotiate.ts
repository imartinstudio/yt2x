import type { TtsRateRange } from "../../ports/tts.js";
import type {
  DubLineTiming,
  DubNegotiateLinePlan,
  DubNegotiatePlan,
  DubScriptLine,
} from "./types.js";

/**
 * 时长协商规划（纯函数）。
 *
 * 混合策略，按句独立决策，顺序固定：
 *   1. keep  — 自然语速装得进目标区间
 *   2. speed — 所需倍率落在引擎 rateRange ∩ 偏好区间内
 *   3. shorten — 需要 LLM 改短（本函数只标记，改写在 adapter 层）
 *   4. delay — 以上都不行，接受溢出并累积漂移
 *
 * 累积漂移在相邻句的原片自然停顿（gap）处吸收；片尾剩多少就 extendMs 多少，
 * 混音时冻结末帧补齐。
 */

/** 锁定决策里的偏好加速上限：超过就改短，避免听感崩坏。 */
export const PREFERRED_RATE_MAX = 1.15;
/** 偏好减速下限；实际配音几乎只加速，保留对称是为了 rate 计算的边界完整。 */
export const PREFERRED_RATE_MIN = 0.95;

/** 装得下的松弛：差几十毫秒不算溢出，避免无谓调速。 */
export const FIT_SLACK_MS = 50;

/** 吸收漂移时每个自然停顿至少留这么多，避免句与句粘在一起。 */
export const MIN_GAP_KEEP_MS = 80;

export type NegotiateLineInput = {
  index: number;
  startMs: number;
  endMs: number;
  targetDurationMs: number;
  text: string;
  /** 倍率 1.0 实测时长。 */
  naturalMs: number;
};

export type PlanDubNegotiationInput = {
  videoId: string;
  lines: readonly NegotiateLineInput[];
  rateRange: TtsRateRange;
  preferredRateMax?: number;
  preferredRateMin?: number;
  fitSlackMs?: number;
  minGapKeepMs?: number;
};

/**
 * 从配音稿 + PR1 时长报告拼出协商输入。缺行的 timing 会被跳过——
 * 合成失败的行不能拿 0 去规划，否则会把后面全部时间轴扯乱。
 */
export const buildNegotiateInputs = (
  scriptLines: readonly DubScriptLine[],
  timings: readonly DubLineTiming[],
): NegotiateLineInput[] => {
  const byIndex = new Map(timings.map((t) => [t.index, t]));
  const inputs: NegotiateLineInput[] = [];
  for (const line of scriptLines) {
    const timing = byIndex.get(line.index);
    if (timing === undefined || timing.synthesizedMs <= 0) continue;
    inputs.push({
      index: line.index,
      startMs: line.startMs,
      endMs: line.endMs,
      targetDurationMs: line.targetDurationMs,
      text: line.text,
      naturalMs: timing.synthesizedMs,
    });
  }
  return inputs;
};

/** 所需倍率 = 自然时长 / 目标时长。目标为 0 时返回 Infinity，走 delay。 */
export const requiredRate = (naturalMs: number, targetDurationMs: number): number => {
  if (targetDurationMs <= 0) return Number.POSITIVE_INFINITY;
  return naturalMs / targetDurationMs;
};

/** 有效加速上限：偏好 ∩ 引擎。 */
export const effectiveRateMax = (
  rateRange: TtsRateRange,
  preferredMax: number = PREFERRED_RATE_MAX,
): number => Math.min(rateRange.max, preferredMax);

export const effectiveRateMin = (
  rateRange: TtsRateRange,
  preferredMin: number = PREFERRED_RATE_MIN,
): number => Math.max(rateRange.min, preferredMin);

/**
 * shorten 的字符上限：按时长比缩放，再留 5% 余量。
 * 下限 4——再短 LLM 也写不出还能保留信息点的句子，不如直接 delay。
 */
export const shortenCharBudget = (text: string, naturalMs: number, targetDurationMs: number): number => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  if (naturalMs <= 0 || targetDurationMs <= 0) return Math.max(4, trimmed.length);
  const ratio = (targetDurationMs / naturalMs) * 0.95;
  return Math.max(4, Math.floor(trimmed.length * ratio));
};

export const planDubNegotiation = (input: PlanDubNegotiationInput): DubNegotiatePlan => {
  const fitSlackMs = input.fitSlackMs ?? FIT_SLACK_MS;
  const minGapKeepMs = input.minGapKeepMs ?? MIN_GAP_KEEP_MS;
  const rateMax = effectiveRateMax(input.rateRange, input.preferredRateMax ?? PREFERRED_RATE_MAX);
  const rateMin = effectiveRateMin(input.rateRange, input.preferredRateMin ?? PREFERRED_RATE_MIN);

  const lines: DubNegotiateLinePlan[] = [];
  let drift = 0;
  let keepCount = 0;
  let speedCount = 0;
  let shortenCount = 0;
  let delayCount = 0;

  for (let i = 0; i < input.lines.length; i += 1) {
    const line = input.lines[i]!;
    const plannedStartMs = line.startMs + drift;
    const rate = requiredRate(line.naturalMs, line.targetDurationMs);

    let plan: DubNegotiateLinePlan;

    if (line.naturalMs <= line.targetDurationMs + fitSlackMs) {
      // 装得进：按实测时长落点，多出来的空隙留给下一句的 gap 吸收
      plan = {
        index: line.index,
        action: "keep",
        rate: 1,
        originalStartMs: line.startMs,
        originalEndMs: line.endMs,
        targetDurationMs: line.targetDurationMs,
        naturalMs: line.naturalMs,
        plannedStartMs,
        plannedEndMs: plannedStartMs + line.naturalMs,
        text: line.text,
      };
      keepCount += 1;
    } else if (Number.isFinite(rate) && rate <= rateMax && rate >= rateMin) {
      // 调速能压进目标区间：落点按目标时长估（真正合成后再 ffprobe 校正）
      plan = {
        index: line.index,
        action: "speed",
        rate: Math.min(rateMax, Math.max(rateMin, rate)),
        originalStartMs: line.startMs,
        originalEndMs: line.endMs,
        targetDurationMs: line.targetDurationMs,
        naturalMs: line.naturalMs,
        plannedStartMs,
        plannedEndMs: plannedStartMs + line.targetDurationMs,
        text: line.text,
      };
      speedCount += 1;
    } else if (shortenCharBudget(line.text, line.naturalMs, line.targetDurationMs) < line.text.trim().length) {
      // 还有改短空间：标记 shorten，落点先按目标估；执行失败再降为 delay
      const maxChars = shortenCharBudget(line.text, line.naturalMs, line.targetDurationMs);
      plan = {
        index: line.index,
        action: "shorten",
        rate: 1,
        originalStartMs: line.startMs,
        originalEndMs: line.endMs,
        targetDurationMs: line.targetDurationMs,
        naturalMs: line.naturalMs,
        plannedStartMs,
        plannedEndMs: plannedStartMs + line.targetDurationMs,
        text: line.text,
        shortenMaxChars: maxChars,
      };
      shortenCount += 1;
    } else {
      // 改短也救不了（预算 ≥ 原文）：直接顺延
      plan = {
        index: line.index,
        action: "delay",
        rate: 1,
        originalStartMs: line.startMs,
        originalEndMs: line.endMs,
        targetDurationMs: line.targetDurationMs,
        naturalMs: line.naturalMs,
        plannedStartMs,
        plannedEndMs: plannedStartMs + line.naturalMs,
        text: line.text,
      };
      delayCount += 1;
    }

    lines.push(plan);

    // 用规划落点更新漂移：实际时长相对目标区间的溢出（可负，表示提前结束能还债）
    const plannedDuration = plan.plannedEndMs - plan.plannedStartMs;
    const overflow = plannedDuration - line.targetDurationMs;
    drift = Math.max(0, drift + overflow);

    // 在与下一句之间的原片自然停顿处吸收
    const next = input.lines[i + 1];
    if (next !== undefined) {
      const gap = next.startMs - line.endMs;
      const absorbable = Math.max(0, gap - minGapKeepMs);
      drift = Math.max(0, drift - absorbable);
    }
  }

  return {
    version: 1,
    videoId: input.videoId,
    lines,
    extendMs: Math.round(drift),
    plannedDriftMs: Math.round(drift),
    speedCount,
    shortenCount,
    delayCount,
    keepCount,
  };
};
