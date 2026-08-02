import path from "node:path";
import {
  EDGE_TTS_RATE_RANGE,
  ELEVENLABS_RATE_RANGE,
  dubDirFor,
  readDubScript,
  readDubTimingReport,
} from "@yt2x/adapters-node";
import {
  CUE_HARD_WIDTH,
  buildNegotiateInputs,
  buildReverseSrtCues,
  interSentenceGapsMs,
  planDubNegotiation,
  summarizeCueWidths,
  summarizeGaps,
  type DubNegotiatePlan,
  type DubPlacedLine,
} from "@yt2x/core";
import { logger } from "../logger.js";
import { NATIVE_EXIT } from "./native-stage-common.js";

/**
 * `yt2x dub-replay`：从已落盘产物重跑时长协商与字幕生成，只做纯计算。
 *
 * 存在的理由是调参回路的成本。改一次显示单元切分或协商参数，此前要跑一遍完整的
 * `yt2x dub` 才能看到全片效果——十几分钟里绝大部分花在翻译、语音合成、人声分离和
 * 烧录上，而这些步骤与被改的那两层逻辑毫无关系。实测中曾有一轮为调切分连跑四次
 * 全片、一小时没有收敛；改成读盘上产物重放之后，同样的定位只要几次调用。
 *
 * 刻意不接受时间窗参数：短窗正是漏测的来源——曾有问题显示单元深在片子后半段，
 * 三十秒窗根本测不到。这里始终覆盖产物里的全部话语单元。
 *
 * 不写盘、不改变 `yt2x dub` 的行为。
 */

export type DubReplayFlags = {
  videoId?: string;
  articleOutDir?: string;
  /** 反事实：覆盖协商的语速下限，用于对比不同取值对句间静默的影响。 */
  preferredRateMin?: string;
  /** 反事实：覆盖触发反向放慢的占用比上限。 */
  stretchMaxOccupancy?: string;
};

const DEFAULT_ARTICLE_ROOT = "files/articles";

const parseFloatFlag = (raw: string | undefined, label: string): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${label}: expected a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
};

const fmt = (ms: number | null): string => (ms === null ? "—" : `${Math.round(ms)}ms`);

const pct = (n: number, total: number): string =>
  total === 0 ? "—" : `${((n / total) * 100).toFixed(1)}%`;

/** 从协商计划推出落点行；与 remix 消费的形状一致，但不落盘。 */
const placedLinesFromPlan = (plan: DubNegotiatePlan): DubPlacedLine[] =>
  plan.lines.map((line) => ({
    index: line.index,
    action: line.action,
    rate: line.rate,
    text: line.text,
    startMs: line.plannedStartMs,
    endMs: line.plannedEndMs,
    durationMs: line.plannedEndMs - line.plannedStartMs,
    audioFile: `lines/${String(line.index).padStart(4, "0")}.mp3`,
  }));

export const executeDubReplay = async (flags: DubReplayFlags): Promise<number> => {
  const videoId = flags.videoId?.trim();
  if (videoId === undefined || videoId.length === 0) {
    logger.error("dub-replay: --video-id is required");
    return NATIVE_EXIT.NO_INPUT;
  }

  const articleRoot = path.resolve(flags.articleOutDir ?? DEFAULT_ARTICLE_ROOT);
  const dubDir = dubDirFor(articleRoot, videoId);

  let script;
  let timing;
  try {
    [script, timing] = await Promise.all([readDubScript(dubDir), readDubTimingReport(dubDir)]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { dubDir },
      `dub-replay: cannot read the persisted dub artifacts (${message}). ` +
        "Run `yt2x dub` for this video first — replay reads what that run left behind.",
    );
    return NATIVE_EXIT.NO_INPUT;
  }

  const preferredRateMin = parseFloatFlag(flags.preferredRateMin, "--preferred-rate-min");
  const stretchMaxOccupancy = parseFloatFlag(flags.stretchMaxOccupancy, "--stretch-max-occupancy");

  // 按时长报告里记录的引擎选 rateRange——各引擎的可调速区间差别很大，
  // 拿错会让反事实重放算出一个现实中合成不出来的落点。
  const rateRange =
    timing.engine === "elevenlabs" ? ELEVENLABS_RATE_RANGE : EDGE_TTS_RATE_RANGE;

  const plan = planDubNegotiation({
    videoId,
    lines: buildNegotiateInputs(script.lines, timing.lines),
    rateRange,
    ...(preferredRateMin !== undefined ? { preferredRateMin } : {}),
    ...(stretchMaxOccupancy !== undefined ? { stretchMaxOccupancy } : {}),
  });

  const placed = placedLinesFromPlan(plan);
  const gaps = summarizeGaps(interSentenceGapsMs(placed));
  const cues = buildReverseSrtCues(placed, script.lines);
  const widths = summarizeCueWidths(
    cues.map((c) => c.zhText),
    CUE_HARD_WIDTH,
  );

  const overrides = [
    preferredRateMin !== undefined ? `preferredRateMin=${preferredRateMin}` : undefined,
    stretchMaxOccupancy !== undefined ? `stretchMaxOccupancy=${stretchMaxOccupancy}` : undefined,
  ].filter((s): s is string => s !== undefined);

  const lines = [
    `话语单元 ${script.lines.length} 条${overrides.length > 0 ? `   覆盖参数: ${overrides.join(" ")}` : ""}`,
    "",
    "句间静默",
    `  总计 ${(gaps.totalMs / 1000).toFixed(1)}s   中位 ${fmt(gaps.medianMs)}   平均 ${fmt(gaps.meanMs)}`,
    `  p90 ${fmt(gaps.p90Ms)}   p95 ${fmt(gaps.p95Ms)}   最大 ${fmt(gaps.maxMs)}`,
    `  >1s ${gaps.overOneSecondCount}/${gaps.count} (${pct(gaps.overOneSecondCount, gaps.count)})   ` +
      `>2s ${gaps.overTwoSecondsCount}/${gaps.count} (${pct(gaps.overTwoSecondsCount, gaps.count)})`,
    "",
    "协商动作",
    `  keep ${plan.keepCount}   speed ${plan.speedCount}   stretch ${plan.stretchCount}   ` +
      `delay ${plan.delayCount}   extendMs ${plan.extendMs}`,
    "",
    "显示单元",
    `  ${widths.count} 条   最宽 ${widths.maxWidth ?? "—"} 格   ` +
      `超 ${CUE_HARD_WIDTH} 格预算 ${widths.overBudgetCount} 条`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  return 0;
};
