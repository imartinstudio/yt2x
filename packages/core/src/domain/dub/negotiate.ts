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
 * 按句独立决策，分两个方向：
 *
 * 溢出方向（自然语速装不下目标区间）固定顺序：
 *   1. keep  — 自然语速装得进目标区间
 *   2. speed — 所需倍率落在引擎 rateRange ∩ 偏好区间内
 *   3. delay — 以上都不行，接受溢出并累积漂移
 *
 * 富余方向（PR4 新增，合成音明显短于目标区间）：
 *   stretch — 反向放慢语速去填充富余，减少句尾死寂；仅在富余超过阈值
 *   （`stretchMinUnderrunMs` 且占用比低于 `stretchMaxOccupancy`）时触发，
 *   且放慢幅度受引擎 rateRange 下限约束——下限 ≥ 1（引擎不支持放慢）时不触发，
 *   退回 keep。原因见 docs/DUB-TASK.md PR4「句间停顿过长」：「锁死原片时长」
 *   下译文短于预算的部分此前全部变成死寂，且当前协商只会加速、从不减速。
 *
 * 原第三档「shorten」（LLM 事后改短）已删除：冗余现在由长度受限翻译在生成配音稿
 * 阶段挤掉，合成完再回头砍字是顺序错误，见 docs/DUB-TASK.md。
 *
 * 句间硬约束：相邻落点间隔 ≥ minInterSentencePauseMs。
 * 停顿优先于压缩；插入停顿带来的漂移由片尾 extendMs 吸收，但 extendMs 有封顶。
 * 触顶后才允许回到压缩（从目标槽内借时间压缩语速），且优先压缩而不是砍停顿。
 */

/** 锁定决策里的偏好加速上限：超过就退到 delay，避免听感崩坏。 */
export const PREFERRED_RATE_MAX = 1.15;
/** 偏好减速下限；实际配音几乎只加速，保留对称是为了 rate 计算的边界完整。 */
export const PREFERRED_RATE_MIN = 0.95;

/** 装得下的松弛：差几十毫秒不算溢出，避免无谓调速。 */
export const FIT_SLACK_MS = 50;

/**
 * 触发反向放慢（stretch）的最小富余（毫秒）。低于这个富余不值得为填满而拖慢——
 * 实测相邻句间隔中位 402ms 本身健康，要压的是 p90/p95 那一档的长尾，不是把
 * 中位数也磨掉；见 docs/DUB-TASK.md PR4「句间停顿过长」。
 */
export const DEFAULT_STRETCH_MIN_UNDERRUN_MS = 400;

/**
 * 触发反向放慢的占用比上限：naturalMs / fitTargetMs 低于此值才触发。
 * 中位行占用预算约 93%，留在这个阈值之上不会被 stretch 碰到；真正造成长尾停顿的
 * 是占用比明显更低（部分行不足 50%）的那一批。
 *
 * 已知事实：这个阈值（0.85）比 `effectiveRateMin`（默认 `PREFERRED_RATE_MIN` 0.95）严格
 * 更松，意味着一旦触发 stretch，`Math.max(rateMin, rate)`（见 `decideLine` 内 stretchRate
 * 计算）里 `rateMin` 恒大于 `rate`（因为触发条件已经要求 occupancy < 0.85 < 0.95），于是
 * `stretchRate` 恒等于 `rateMin` 地板值，`rate` 这个分支实际从未被 `Math.max` 选中——
 * 真实全片 149 句里触发 stretch 的 54 句全部落在 0.95 地板，`Math.max` 在默认参数下是
 * 死代码。要让占用比真正影响 stretchRate（而不是全部拍平成同一个速率），需要把
 * `PREFERRED_RATE_MIN` 下探到 0.85 或更低——这正是第二个试听版本（rateMin=0.85）
 * 验证的方向，见 docs/DUB-TASK.md。
 */
export const DEFAULT_STRETCH_MAX_OCCUPANCY = 0.85;

/** 吸收漂移时每个原片自然停顿至少留这么多（与「最小句间停顿」不同：这是吸收上限保护）。 */
export const MIN_GAP_KEEP_MS = 80;

/**
 * 相邻配音落点的最小间隔。听感硬约束；默认取 120–200ms 试听区间中位，可配置。
 */
export const DEFAULT_MIN_INTER_SENTENCE_PAUSE_MS = 150;

/**
 * 片尾冻结末帧的绝对上限。停顿优先时漂移进 extendMs，但无封顶会长视频尾冻失控。
 */
export const DEFAULT_MAX_EXTEND_MS = 8_000;

/** 相对正片时长的 extend 上限比例；与绝对上限取更严者（需传入 videoDurationMs）。 */
export const DEFAULT_MAX_EXTEND_FRACTION = 0.02;

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
  /** 相邻落点最小间隔（毫秒）。 */
  minInterSentencePauseMs?: number;
  /** 触发反向放慢的最小富余（毫秒）；默认 DEFAULT_STRETCH_MIN_UNDERRUN_MS。 */
  stretchMinUnderrunMs?: number;
  /** 触发反向放慢的占用比上限；默认 DEFAULT_STRETCH_MAX_OCCUPANCY。 */
  stretchMaxOccupancy?: number;
  /** 片尾 extendMs 绝对上限。 */
  maxExtendMs?: number;
  /** 片尾 extendMs 相对正片时长上限；与 maxExtendMs 取更严。 */
  maxExtendFraction?: number;
  /** 正片时长；提供时才启用 maxExtendFraction。 */
  videoDurationMs?: number;
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

export const resolveMaxExtendMs = (input: {
  maxExtendMs?: number;
  maxExtendFraction?: number;
  videoDurationMs?: number;
}): number => {
  const absolute = input.maxExtendMs ?? DEFAULT_MAX_EXTEND_MS;
  const fraction = input.maxExtendFraction ?? DEFAULT_MAX_EXTEND_FRACTION;
  if (
    input.videoDurationMs !== undefined &&
    Number.isFinite(input.videoDurationMs) &&
    input.videoDurationMs > 0
  ) {
    return Math.min(absolute, Math.floor(input.videoDurationMs * fraction));
  }
  return absolute;
};

const decideLine = (input: {
  line: NegotiateLineInput;
  fitTargetMs: number;
  plannedStartMs: number;
  fitSlackMs: number;
  rateMax: number;
  rateMin: number;
  stretchMinUnderrunMs: number;
  stretchMaxOccupancy: number;
}): DubNegotiateLinePlan => {
  const {
    line,
    fitTargetMs,
    plannedStartMs,
    fitSlackMs,
    rateMax,
    rateMin,
    stretchMinUnderrunMs,
    stretchMaxOccupancy,
  } = input;
  const rate = requiredRate(line.naturalMs, fitTargetMs);

  // 富余方向：合成音明显短于目标区间时反向放慢填充，减少句尾死寂。
  // rateMin >= 1 表示引擎自报的 rateRange 下限不允许放慢，直接放弃，落回 keep。
  const underrunMs = fitTargetMs - line.naturalMs;
  const occupancy = fitTargetMs > 0 ? line.naturalMs / fitTargetMs : 1;
  if (rateMin < 1 && underrunMs > stretchMinUnderrunMs && occupancy < stretchMaxOccupancy) {
    const stretchRate = Math.min(1, Math.max(rateMin, rate));
    const plannedDurationMs = Math.max(1, Math.round(line.naturalMs / stretchRate));
    return {
      index: line.index,
      action: "stretch",
      rate: stretchRate,
      originalStartMs: line.startMs,
      originalEndMs: line.endMs,
      targetDurationMs: line.targetDurationMs,
      naturalMs: line.naturalMs,
      plannedStartMs,
      plannedEndMs: plannedStartMs + plannedDurationMs,
      text: line.text,
    };
  }

  if (line.naturalMs <= fitTargetMs + fitSlackMs) {
    return {
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
  }

  if (Number.isFinite(rate) && rate <= rateMax && rate >= rateMin) {
    return {
      index: line.index,
      action: "speed",
      rate: Math.min(rateMax, Math.max(rateMin, rate)),
      originalStartMs: line.startMs,
      originalEndMs: line.endMs,
      targetDurationMs: line.targetDurationMs,
      naturalMs: line.naturalMs,
      plannedStartMs,
      plannedEndMs: plannedStartMs + fitTargetMs,
      text: line.text,
    };
  }

  return {
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
};

const planOnce = (input: {
  videoId: string;
  lines: readonly NegotiateLineInput[];
  fitSlackMs: number;
  minGapKeepMs: number;
  minInterSentencePauseMs: number;
  maxExtendMs: number;
  rateMax: number;
  rateMin: number;
  stretchMinUnderrunMs: number;
  stretchMaxOccupancy: number;
  /** 触顶后从每句目标槽额外借出的毫秒，用于挤出停顿空间。 */
  slotBorrowExtraMs: number;
}): DubNegotiatePlan => {
  const lines: DubNegotiateLinePlan[] = [];
  let drift = 0;
  let keepCount = 0;
  let speedCount = 0;
  let stretchCount = 0;
  let delayCount = 0;

  for (let i = 0; i < input.lines.length; i += 1) {
    const line = input.lines[i]!;
    const next = input.lines[i + 1];
    const sourceGap = next !== undefined ? next.startMs - line.endMs : Number.POSITIVE_INFINITY;
    const pauseDeficit =
      next !== undefined ? Math.max(0, input.minInterSentencePauseMs - Math.max(0, sourceGap)) : 0;
    const extendRoom = Math.max(0, input.maxExtendMs - drift);
    const pauseBorrow = Math.max(0, pauseDeficit - extendRoom) + input.slotBorrowExtraMs;
    const fitTargetMs = Math.max(1, line.targetDurationMs - pauseBorrow);

    const plannedStartMs = line.startMs + drift;
    const plan = decideLine({
      line,
      fitTargetMs,
      plannedStartMs,
      fitSlackMs: input.fitSlackMs,
      rateMax: input.rateMax,
      rateMin: input.rateMin,
      stretchMinUnderrunMs: input.stretchMinUnderrunMs,
      stretchMaxOccupancy: input.stretchMaxOccupancy,
    });

    lines.push(plan);
    if (plan.action === "keep") keepCount += 1;
    else if (plan.action === "speed") speedCount += 1;
    else if (plan.action === "stretch") stretchCount += 1;
    else delayCount += 1;

    const plannedDuration = plan.plannedEndMs - plan.plannedStartMs;
    const overflow = plannedDuration - line.targetDurationMs;
    drift = Math.max(0, drift + overflow);

    if (next !== undefined) {
      const gap = next.startMs - line.endMs;
      const absorbable = Math.max(0, gap - input.minGapKeepMs);
      drift = Math.max(0, drift - absorbable);

      const minNextStart = plan.plannedEndMs + input.minInterSentencePauseMs;
      const nextStart = next.startMs + drift;
      if (nextStart < minNextStart) {
        drift += minNextStart - nextStart;
      }
    }
  }

  return {
    version: 3,
    videoId: input.videoId,
    lines,
    extendMs: Math.round(drift),
    plannedDriftMs: Math.round(drift),
    speedCount,
    stretchCount,
    delayCount,
    keepCount,
  };
};

export const planDubNegotiation = (input: PlanDubNegotiationInput): DubNegotiatePlan => {
  const fitSlackMs = input.fitSlackMs ?? FIT_SLACK_MS;
  const minGapKeepMs = input.minGapKeepMs ?? MIN_GAP_KEEP_MS;
  const minInterSentencePauseMs =
    input.minInterSentencePauseMs ?? DEFAULT_MIN_INTER_SENTENCE_PAUSE_MS;
  const stretchMinUnderrunMs = input.stretchMinUnderrunMs ?? DEFAULT_STRETCH_MIN_UNDERRUN_MS;
  const stretchMaxOccupancy = input.stretchMaxOccupancy ?? DEFAULT_STRETCH_MAX_OCCUPANCY;
  const maxExtendMs = resolveMaxExtendMs(input);
  const rateMax = effectiveRateMax(input.rateRange, input.preferredRateMax ?? PREFERRED_RATE_MAX);
  const rateMin = effectiveRateMin(input.rateRange, input.preferredRateMin ?? PREFERRED_RATE_MIN);

  const base = {
    videoId: input.videoId,
    lines: input.lines,
    fitSlackMs,
    minGapKeepMs,
    minInterSentencePauseMs,
    stretchMinUnderrunMs,
    stretchMaxOccupancy,
    maxExtendMs,
    rateMax,
    rateMin,
  };

  // 停顿优先：先不从槽内借时间，漂移进 extendMs
  let plan = planOnce({ ...base, slotBorrowExtraMs: 0 });
  if (plan.extendMs <= maxExtendMs) return plan;

  // 触顶：从目标槽借时间压缩，优先压缩而不是砍停顿
  const boundaries = Math.max(1, input.lines.length - 1);
  const excess = plan.extendMs - maxExtendMs;
  plan = planOnce({
    ...base,
    slotBorrowExtraMs: Math.ceil(excess / boundaries),
  });
  if (plan.extendMs <= maxExtendMs) return plan;

  // 仍触顶：按最小停顿全额从槽内借
  return planOnce({
    ...base,
    slotBorrowExtraMs: minInterSentencePauseMs,
  });
};
