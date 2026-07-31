/**
 * 配音门禁（纯函数）。
 *
 * 阈值取自 PR1/PR2 的设计约束与协商偏好区间，在没有大规模真实分布之前先给
 * 一组**可复现的临时硬阈值**——宁可偏松挡住明显翻车，也不拿拍脑袋的严阈值
 * 卡死调试。跑过一批真实片子后只改 `DEFAULT_DUB_GATE_THRESHOLDS` 即可。
 *
 * 分层：
 *  - hard：阻断成片（空音频、极端漂移、大比例 delay）
 *  - advisory：写进 report，不阻断（偏高的 medianRatio 等）
 */

import type {
  DubPlacementReport,
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
  | "info-loss";

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
  /** 片尾冻结时长硬上限（毫秒）。 */
  maxExtendMs: number;
  /** delay 行占比硬上限。 */
  maxDelayFraction: number;
  /**
   * 改写后文本相对 sourceText 的最低保留比例（按 Unicode 码点）。
   * 过低视为信息损失嫌疑——朗读化/改短不该砍掉大半内容。
   */
  minTextRetainFraction: number;
};

/**
 * 临时硬阈值。
 *
 * issue #108 裁掉 TTS 首尾静音后，自然语速时长整体左移（不再含 ~200ms 虚高），
 * 以 dubSmoke90 重跑分布重标 advisory：medianRatio 中枢约 0.7–1.0，overflow 约 20%。
 * hard 项（extend / delay / 文本保留）本样本未触线，暂保持原约束。
 *
 * - extend ≤ 60s：超过一分钟的末帧冻结听感已经崩了
 * - delay ≤ 25%：超过四分之一句靠顺延，对齐策略基本失效
 * - 文本保留 ≥ 45%：改短预算通常在 50–70%，再低多半是 LLM 胡砍
 */
export const DEFAULT_DUB_GATE_THRESHOLDS: DubGateThresholds = {
  advisoryMedianRatio: 1.15,
  advisoryOverflowFraction: 0.35,
  maxExtendMs: 60_000,
  maxDelayFraction: 0.25,
  minTextRetainFraction: 0.45,
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
    },
    issues,
  };
};
