/**
 * 配音门禁（纯函数）。
 *
 * 阈值必须用真实素材从零标定（见 issue #113）：旧 smoke 样本已删除且曾被
 * 污染，不能在旧数上微调。分层：
 *  - hard：阻断成片（空音频、极端漂移、大比例 delay、句间零/低间隔）
 *  - advisory：写进 report，不阻断（偏高的 medianRatio、译文明显短于时长预算等）
 */

import {
  DEFAULT_MAX_EXTEND_MS,
  DEFAULT_MIN_INTER_SENTENCE_PAUSE_MS,
} from "./negotiate.js";
import { DEFAULT_SPEECH_RATE, dubTranslateCharBudget } from "./translate-prompts.js";
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
  | "dropped-utterances"
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
   * 译文相对该行**时长预算**（`dubTranslateCharBudget(targetDurationMs)`）的最低占用比例。
   *
   * PR3 之前这里比较的是 sourceText（源语言）与译文的码点数比——切到本地转录通道后
   * sourceText 变成英文，英文码点数天然是中文的 3–4 倍，忠实翻译落在 0.35–0.5 是常态，
   * 那套比例在跨语言场景下语义已经失效（见 docs/DUB-TASK.md 的 info-loss 处置）。
   * 换成"译文占用了多少可用时长预算"后，两侧单位一致，仍能捕捉"翻译明显短于预算、
   * 疑似被过度精简"的退化情况；advisory 而非 hard——**不是**因为真实素材普遍逼近阈值
   * （单位口径修好后，默认阈值 0.3 在标定素材上并不会挡住产出，见默认值注释里的最低观测
   * 0.42）。真正的原因是这个指标本身分辨不出"挤掉的是口水话"还是"砍掉的是内容"：一段
   * 8 秒、塞满填充词的发言，忠实翻译成 7 个字就可能只占用预算的 12%——占用比低完全是
   * 合理压缩的正常结果，不是翻译退化的信号，hard 拦这类行会误杀。这也意味着这个指标目前
   * 抓不住真正的退化案例（译文被过度砍削但仍非空）；见 docs/DUB-TASK.md 未决事项。
   */
  advisoryTextBudgetRetainFraction: number;
  /**
   * `script.droppedCount`（翻译失败、未进入配音稿的话语单元数）硬上限；默认 0，
   * 即一句都不允许静默丢弃。丢弃的话语单元在成片里只有 BGM、没有配音也没有字幕，
   * 且不会被 lineCount 之类的统计口径体现——必须显式拦住，而不是让门禁在完全不知情
   * 的情况下 passed（见 docs/DUB-TASK.md 对应验收记录）。
   */
  maxDroppedCount: number;
  /** 低于此间隔（毫秒）计为 low-gap；默认等于最小句间停顿。 */
  minInterSentencePauseMs: number;
  /** 句间间隔 < 1ms 的边界占比硬上限；0 表示不允许零间隔。 */
  maxZeroGapFraction: number;
  /** 句间间隔 < minInterSentencePauseMs 的边界占比硬上限。 */
  maxLowGapFraction: number;
};

/**
 * 从零标定的默认阈值（#113，最初素材 A8mokin_YOs 30s 窗实测）。
 *
 * **PR4 重标定**（2026-08-01，edge-tts + zh-CN-YunjianNeural + stretch 反向放慢，
 * 素材 `<videoId>` 全片 149 句实跑，非 30s 窗）——换音色（比旧默认云希慢约 4%）、
 * 新增 stretch 动作都会改变自然语速分布与协商结果，旧阈值是按云希、且只按 30s
 * 窗标定的，必须用真实全片重新核对：
 *
 *   medianRatio=0.921、overflowFraction=0.383（57/149）、extendMs=10、
 *   delayFraction=0.188（28/149）、zeroGap=0、lowGap=0、minGap=150、
 *   infoLossCount=0（占用比最低观测 0.407）。
 *
 * 与旧 30s 窗观测（medianRatio 无记录、overflowFraction≈0.71、delayFraction≈0.29）
 * 相比，全片实测的 overflow / delay 都明显更低——30s 窗口偏小，容易被开头一两句
 * 难压缩的内容带偏；全片分布更有代表性，本轮据此收紧而非照抄旧值：
 *
 * - advisoryMedianRatio 1.35 → **1.2**：真实全片 0.921（此前云希全片跑过 0.935，
 *   见 docs/DUB-TASK.md），两次真实观测都聚在 0.92–0.94，1.2 留约 30% 余量，
 *   仍远比 1.35 更有辨识力。
 * - advisoryOverflowFraction 0.75 → **0.5**：真实观测 0.383（云健）/ 0.369（云希，
 *   见 docs/DUB-TASK.md），1.5 倍（约 30–35%）留在最高观测之上，0.75 对这两次真实
 *   全片跑而言形同虚设。
 * - maxDelayFraction（hard）**0.35：不收紧**。上一轮曾把它从 0.35 收紧到 0.3，复审用
 *   滑窗统计推翻了这个改动：真实素材上 60s 窗口 delayFraction 中位/最大值分布很宽
 *   （max 0.500，超 0.3 的窗口占比 25%），120s 窗口收窄但仍有 9% 的窗口超过 0.3、
 *   而超过 0.35 的窗口占比是 0%——历史两次真实全片观测（0.188 / 0.2857）都落在
 *   0.3–0.35 这个新增拦截带之外，说明收紧 0.05 买到的唯一确定后果是对短样本
 *   （`AGENTS.md` 明确把 `dub --start-ms/--end-ms` 列为标准做法）的纯粹误拦，
 *   没有对应挡住任何已知的真实退化。而且这条指标在短窗上的量化噪声本就远大于
 *   0.05 的收紧幅度：历史样本只有 7 行，粒度 1/7≈0.143，比两次收紧的差值本身还粗，
 *   在这个粒度上争论 0.30 还是 0.35 没有统计意义。退回 0.35。
 * - maxExtendMs（hard）8s：不变，与协商层 DEFAULT_MAX_EXTEND_MS 对齐，是结构性
 *   安全帽而非"典型值"——真实观测 extendMs=10ms（stretch 让绝大多数漂移在句内
 *   被吸收），继续留 8s 上限本身不会挡住任何真实产出。
 * - advisoryMedianRatio 1.2、advisoryOverflowFraction 0.5：维持收紧后的值。这两条是
 *   advisory，不阻断成片，即使分布随后续改动漂移触发得更频繁，代价也只是报告多几条
 *   info 级提示，可以接受。
 * - advisoryTextBudgetRetainFraction 0.3：不变，但下面这条论证站不住，如实改写——
 *   全片重跑测出的最低观测占用比 0.407 只统计了 129 条**参与评估**的行；
 *   `targetDurationMs <= fixedOverheadMs` 时整行跳过评估（见下方 evaluateDubGate
 *   的 info-loss 分支），而这批被跳过的行正是 149 句里单字译文最集中的 17 句
 *   （占比 11.4%）。129 = 149 − 17（另外 3 句因缺少可比对的 script line 一并跳过）。
 *   也就是说 0.407 这个"最低观测"恰恰是把信息损失最惨的那批样本剔除之后剩下的，
 *   `infoLossCount=0` 不代表没有信息损失，而是门禁对损失最惨的那一批**结构性失明**。
 *   PR4 接上 `minDurationMs` 合并短话语单元后，这批盲区应会大幅缩小（单字译文改前
 *   17/149，改后见 CLI `dub` 编排层 `DEFAULT_MIN_DURATION_MS` 注释与最新实测），但
 *   `targetDurationMs <= fixedOverheadMs` 的跳过分支本身仍在，仍然是这个指标的
 *   固有盲区，不是已解决问题。
 *
 * **本轮改动（2026-08-01，"嘴动无声"根治）**——用户反馈"原片人还在说、中文已说完，
 * 既无声音也无字幕"，实测根因是译文提示词把"越短越好"当成明确指令，模型严格照办：
 * 60s 窗真实素材里最惨一行预算 76 字只用了约 27 字。修法在翻译阶段（见
 * `translate-prompts.ts` 规则改写 + `translate.ts` 新增的低于预算反向重译），门禁侧
 * 只做同步收紧，不是主因：
 *
 * - advisoryTextBudgetRetainFraction **0.3 → 0.7**：0.3 这个值本身就是本文件其他地方
 *   明确记录过的已知缺陷——"标定"从未真正发生，只是拿单次 30s 窗跑出的 `issues: []`
 *   当成合格线，而全片复查显示它连预算只用 42% 的行都不拦（advisory 都不报，见上面
 *   "0.407 只统计了参与评估的行"那段记录）。0.7 让指标真正开始起作用：结合翻译阶段的
 *   反向重译（低于 60% 会被打回重写一次），门禁在重译之后仍量到低于 70% 的行，大概率
 *   是重译也没能把内容填起来的顽固案例，这正是应该被报出来、供人工复查的信号。
 * - **仍为 advisory，不升 hard**：本文件其他地方两次记录过"拿单次样本收紧 hard 阈值"
 *   被复审推翻的教训（见 `maxDelayFraction` 0.35→0.3 那次的完整论证）；这次只用一个 60s
 *   窗口验证过新提示词 + 反向重译的效果，同样不足以支撑升级为阻断整条流水线的 hard
 *   规则。更根本的原因没变：这个指标结构性分辨不出"忠实压缩掉的是口水话"还是"翻译
 *   退化砍掉了内容"——一段填充词密集的发言忠实压缩后天然占用比低，hard 拦这类行会
 *   误杀本该通过的正常压缩。升 hard 需要在真实全片上验证反向重译后残留的低占用行
 *   究竟是哪一类，而不是先拦了再说。
 *
 * - 零间隔 / 低于最小停顿：仍不允许
 */
export const DEFAULT_DUB_GATE_THRESHOLDS: DubGateThresholds = {
  advisoryMedianRatio: 1.2,
  advisoryOverflowFraction: 0.5,
  maxExtendMs: DEFAULT_MAX_EXTEND_MS,
  maxDelayFraction: 0.35,
  advisoryTextBudgetRetainFraction: 0.7,
  maxDroppedCount: 0,
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
    droppedCount: number;
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

/**
 * 判定译文是否"退化为纯标点"：不含任何字母或数字（`\p{L}` / `\p{N}`）即视为等价于空文本。
 *
 * 原判据 `text.trim().length === 0` 抓不住这类退化——真实素材第 76 句被翻译成孤立的
 * 全角问号「？」，长度为 1，直接放行；而 edge-tts 对纯标点文本 100% 确定性失败（手测
 * 5/5 复现），会让整趟合成从这一行开始中止。标点、空白、控制字符都不构成"有内容"，
 * 必须至少出现一个字母或数字才算通过。
 */
const isEffectivelyEmptyText = (text: string): boolean => !/[\p{L}\p{N}]/u.test(text);

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
    if (isEffectivelyEmptyText(line.text)) {
      emptyTextCount += 1;
      issues.push({
        code: "empty-text",
        severity: "hard",
        message: `line ${line.index}: empty or punctuation-only spoken text (${JSON.stringify(line.text)})`,
      });
    }
  }

  let infoLossCount = 0;
  if (input.script !== undefined) {
    const byIndex = new Map(input.placement.lines.map((l) => [l.index, l]));
    for (const scriptLine of input.script.lines) {
      const placed = byIndex.get(scriptLine.index);
      if (placed === undefined) continue;
      // dubTranslateCharBudget clamps its result to >=1 (see translate-prompts.ts), so
      // checking the clamped value here would never skip anything — measured on a real
      // 149-utterance video, 13.4% of utterances have targetDurationMs at or below the
      // fixed overhead (budget genuinely unusable) and this guard must catch those
      // against the *raw* duration instead.
      if (scriptLine.targetDurationMs <= DEFAULT_SPEECH_RATE.fixedOverheadMs) continue;
      const budgetChars = dubTranslateCharBudget(scriptLine.targetDurationMs, DEFAULT_SPEECH_RATE);
      const finalLen = charLen(placed.text);
      const retain = finalLen / budgetChars;
      if (retain < thresholds.advisoryTextBudgetRetainFraction) {
        infoLossCount += 1;
        issues.push({
          code: "info-loss",
          severity: "advisory",
          message: `line ${scriptLine.index}: spoken text used ${(retain * 100).toFixed(0)}% of its time budget (${finalLen}/${budgetChars} chars) — possible over-compression`,
          value: retain,
          threshold: thresholds.advisoryTextBudgetRetainFraction,
        });
      }
    }
  }

  const droppedCount = input.script?.droppedCount ?? 0;
  if (droppedCount > thresholds.maxDroppedCount) {
    issues.push({
      code: "dropped-utterances",
      severity: "hard",
      message: `${droppedCount} utterance(s) had no usable translation and were silently dropped from the dubbing script (exceeds hard max ${thresholds.maxDroppedCount})`,
      value: droppedCount,
      threshold: thresholds.maxDroppedCount,
    });
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
      droppedCount,
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
