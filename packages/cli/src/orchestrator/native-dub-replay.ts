import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  DUB_PLACEMENT_FILE,
  EDGE_TTS_RATE_RANGE,
  ELEVENLABS_RATE_RANGE,
  defaultProcessRunner,
  dubDirFor,
  evaluateDubBilingualGate,
  readDubScript,
  readDubTimingReport,
  sanitizeVideoId,
} from "@yt2x/adapters-node";
import {
  CUE_HARD_WIDTH,
  buildNegotiateInputs,
  buildReverseSrtCues,
  formatReverseEnSrt,
  formatReverseSrt,
  formatReverseZhSrt,
  interSentenceGapsMs,
  planDubNegotiation,
  planToPlacedLines,
  summarizeCueWidths,
  summarizeGaps,
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

/**
 * 与盘上落点核对**协商决策**，不核对时间戳。
 *
 * 时间戳天生对不上，这不是异常：重放算出的是协商阶段的**预估**起止
 * （`plannedStartMs`/`plannedEndMs`），而落点报告记的是按该计划重新合成之后的**实测**
 * 位置。拿两者逐毫秒比会 100% 报警——本工具第一版就这么干过，在一份完全正常的产物上
 * 报出「68/121 行不一致」，还附了一个错误的解释。
 *
 * 真正能核的是决策本身：同样的输入、同样的参数，应当选出同样的动作序列。对不上才
 * 说明那次运行用过非默认协商参数，此时重放的相对比较仍然成立，但绝对数字不代表那次成片。
 */
const negotiationDrift = async (
  dubDir: string,
  replayed: readonly DubPlacedLine[],
): Promise<string | undefined> => {
  let persisted: { lines?: { index: number; action: string }[] };
  try {
    persisted = JSON.parse(
      await readFile(`${dubDir}/${DUB_PLACEMENT_FILE}`, "utf8"),
    ) as typeof persisted;
  } catch {
    return "盘上没有落点报告，无法核对重放是否重现了原运行的协商决策";
  }
  const lines = persisted.lines ?? [];
  if (lines.length !== replayed.length) {
    return `行数不一致：盘上 ${lines.length}，重放 ${replayed.length}`;
  }
  const byIndex = new Map(replayed.map((l) => [l.index, l]));
  const drifted = lines.filter((l) => byIndex.get(l.index)?.action !== l.action);
  return drifted.length === 0
    ? undefined
    : `${drifted.length}/${lines.length} 行协商动作与盘上不一致——原运行可能用过非默认参数，` +
      "相对比较仍然成立，但绝对数字不代表那次成片";
};

export const executeDubReplay = async (flags: DubReplayFlags): Promise<number> => {
  const raw = flags.videoId?.trim();
  if (raw === undefined || raw.length === 0) {
    logger.error("dub-replay: --video-id is required");
    return NATIVE_EXIT.NO_INPUT;
  }
  // 与 native-dub 同一道关：videoId 只能当安全目录名，绝不能把路径片段拼进 path.join。
  const videoId = sanitizeVideoId(raw);

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

  // 参数解析失败也走退出码，不让异常逃到 commander——与本文件其他失败分支一致。
  let preferredRateMin: number | undefined;
  let stretchMaxOccupancy: number | undefined;
  try {
    preferredRateMin = parseFloatFlag(flags.preferredRateMin, "--preferred-rate-min");
    stretchMaxOccupancy = parseFloatFlag(flags.stretchMaxOccupancy, "--stretch-max-occupancy");
  } catch (err: unknown) {
    logger.error(`dub-replay: ${err instanceof Error ? err.message : String(err)}`);
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  // 按时长报告里记录的引擎选 rateRange——各引擎的可调速区间差别很大，
  // 拿错会让反事实重放算出一个现实中合成不出来的落点。
  const rateRange =
    timing.engine === "elevenlabs" ? ELEVENLABS_RATE_RANGE : EDGE_TTS_RATE_RANGE;

  const overrides = [
    preferredRateMin !== undefined ? `preferredRateMin=${preferredRateMin}` : undefined,
    stretchMaxOccupancy !== undefined ? `stretchMaxOccupancy=${stretchMaxOccupancy}` : undefined,
  ].filter((o): o is string => o !== undefined);
  const overridesApplied = overrides.length > 0;

  const plan = planDubNegotiation({
    videoId,
    lines: buildNegotiateInputs(script.lines, timing.lines),
    rateRange,
    ...(preferredRateMin !== undefined ? { preferredRateMin } : {}),
    ...(stretchMaxOccupancy !== undefined ? { stretchMaxOccupancy } : {}),
  });

  const placed = planToPlacedLines(plan);
  const gaps = summarizeGaps(interSentenceGapsMs(placed));
  const cues = buildReverseSrtCues(placed, script.lines);
  const widths = summarizeCueWidths(
    cues.map((c) => c.zhText),
    CUE_HARD_WIDTH,
  );

  // 三份 SRT 走与成片同一套格式化函数，再喂给双语交付门——重放要能复现门禁结论，
  // 否则调完切分还得跑一次全片才知道过没过。
  const bilingualSrt = formatReverseSrt(placed, script.lines);
  const zhSrt = formatReverseZhSrt(placed, script.lines);
  const enSrt = formatReverseEnSrt(placed, script.lines);
  const gate = await evaluateDubBilingualGate({
    bilingualSrt,
    zhSrt,
    enSrt,
    videoWidth: 1280,
    videoHeight: 720,
    runner: defaultProcessRunner,
    utteranceBoundariesMs: placed.map((l) => l.endMs),
  });
  const byCode = new Map<string, number>();
  for (const issue of gate.issues) byCode.set(issue.code, (byCode.get(issue.code) ?? 0) + 1);

  // 无覆盖参数时才核对：给了反事实参数本来就该偏离盘上落点。
  const drift =
    overridesApplied ? undefined : await negotiationDrift(dubDir, placed);

  const lines = [
    `话语单元 ${script.lines.length} 条${overrides.length > 0 ? `   覆盖参数: ${overrides.join(" ")}` : ""}`,
    "",
    "句间静默（协商预估，非成片实测——用于横向对比参数，绝对值以真实跑为准）",
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
    `  ${widths.count} 条   中位 ${widths.medianWidth ?? "—"} 格   p90 ${widths.p90Width ?? "—"} 格   ` +
      `最宽 ${widths.maxWidth ?? "—"} 格`,
    `  超 ${CUE_HARD_WIDTH} 格预算 ${widths.overBudgetCount} 条`,
    "",
    `双语交付门  readyForBurn=${gate.readyForBurn}   issues ${gate.issues.length}`,
    ...(byCode.size === 0
      ? ["  （无）"]
      : [...byCode]
          .sort((a, b) => b[1] - a[1])
          .map(([code, n]) => `  ${code}: ${n}`)),
    ...(drift !== undefined ? ["", `⚠️ ${drift}`] : []),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  return 0;
};
