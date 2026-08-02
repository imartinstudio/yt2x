import { createHash } from "node:crypto";
import {
  HARD_CJK,
  PROTECTED_GLOSSARY_TERMS,
  PROTECTED_NAMES,
  visualWidth,
} from "./semantic-bilingual-subtitles.js";

export const SUBTITLE_AUDIT_THRESHOLDS = {
  maxLines: 2,
  /**
   * The projection's own hard ceiling, re-checked here on the delivered text.
   * `hard-layout` was previously reachable only through `measurements`, which
   * come from the burn stage's real font metrics — so nothing checked width
   * at the SRT stage, and an over-width line could ship unreported. Sharing
   * the constant keeps the audit from disagreeing with the writer about what
   * "too wide" means.
   */
  maxCueWidth: HARD_CJK,
  /**
   * Reading speed ceiling in *visual width* per second, not raw characters:
   * one CJK glyph is a full cell, a Latin letter or digit half a cell (see
   * `visualWidth`). Measuring raw characters counted every letter of a
   * deliberately-untranslated term ("Air Coding Cohort" — 15 characters,
   * 7.5 cells) as if it were 15 Chinese characters, so the cues carrying the
   * glossary terms the pipeline is *required* to preserve were exactly the
   * ones scored as too fast. Sharing units with the layout budget also means
   * `compactDenseBlocks` can actually satisfy a finding raised here.
   */
  maxCps: 9,
  minCueDurationSeconds: 1,
  minSplitDurationSeconds: 1,
} as const;

export type SubtitleAuditIssueCode =
  | "source-sha"
  | "coverage-loss"
  | "empty-text"
  | "timing-invalid"
  | "timing-overlap"
  | "bilingual-timing"
  | "glossary-violation"
  | "hard-layout"
  | "width-budget"
  | "line-count"
  | "cps"
  | "flash"
  | "unsafe-layout";

export type SubtitleAuditIssue = {
  code: SubtitleAuditIssueCode;
  severity: "content" | "presentation";
  message: string;
  cueIndex?: number;
  timestamp?: string;
  text?: string;
};

export type SubtitleAuditMeasurement = {
  cueIndex: number;
  severity: "fit" | "aim" | "hard";
  lineCount: number;
};

export type SubtitleAuditManifest = {
  sourceSha256?: string;
};

export type SubtitleAuditInput = {
  sourceSrt: string;
  enSrt: string;
  zhSrt: string;
  bilingualSrt: string;
  manifest: SubtitleAuditManifest;
  measurements?: readonly SubtitleAuditMeasurement[];
  /**
   * 话语单元边界（毫秒，升序，每个话语单元的实测终点）。只有配音链路提供——它知道
   * 显示单元（cue）从属于哪个话语单元（`dub/cue-split.ts` 的细分结果）。提供时，术语
   * 保护校验（glossary-violation）按话语单元分组比对，而不是逐条显示单元比对：同一个
   * 话语单元切成显示单元时，中文按视觉宽度切、英文按词数占比切，切分边界不同，术语可能
   * 落在相邻的显示单元里——真实全片跑出过这个假阳性（"PRD" 完整保留在译文中，却因为
   * 中英文显示单元切分点不同被逐条比对误报）。不提供时（纯字幕交付路径，没有话语单元
   * 概念）保持逐条显示单元比对，行为与之前完全一致。
   */
  utteranceBoundariesMs?: readonly number[];
};

export type SubtitleAuditResult = {
  verdict: "pass" | "warn" | "fail";
  issues: SubtitleAuditIssue[];
};

export type SubtitleAuditDeliveryMode = "srt" | "ass" | "burned" | "all";

type ParsedCue = {
  index: number;
  startRaw: string;
  endRaw: string;
  startSeconds: number;
  endSeconds: number;
  lines: string[];
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const timestampSeconds = (value: string): number => {
  const match = /^(\d+):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/u.exec(value.trim());
  if (match === null) return Number.NaN;
  const milliseconds = match[4]!.padEnd(3, "0");
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) +
    Number(milliseconds) / 1000;
};

const parseSrt = (raw: string): ParsedCue[] =>
  raw.trim().split(/\r?\n\s*\r?\n/u).filter((block) => block.trim().length > 0)
    .map((block, position) => {
      const lines = block.split(/\r?\n/u);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      const timing = timingIndex >= 0 ? lines[timingIndex]!.split(/\s*-->\s*/u) : [];
      const startRaw = timing[0] ?? "";
      const endRaw = timing[1] ?? "";
      return {
        index: Number.parseInt(lines[0] ?? "", 10) || position + 1,
        startRaw,
        endRaw,
        startSeconds: timestampSeconds(startRaw),
        endSeconds: timestampSeconds(endRaw),
        lines: timingIndex >= 0 ? lines.slice(timingIndex + 1) : [],
      };
    });

const words = (srt: string): string[] =>
  parseSrt(srt)
    .flatMap((cue) => cue.lines)
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];

type IdenticalTextSpan = {
  text: string;
  firstIndex: number;
  startRaw: string;
  startSeconds: number;
  endSeconds: number;
};

const groupConsecutiveIdenticalText = (cues: readonly ParsedCue[]): IdenticalTextSpan[] => {
  const spans: IdenticalTextSpan[] = [];
  for (const cue of cues) {
    const text = cue.lines.join(" ").trim();
    const last = spans[spans.length - 1];
    if (last !== undefined && last.text === text) {
      last.endSeconds = cue.endSeconds;
    } else {
      spans.push({
        text,
        firstIndex: cue.index,
        startRaw: cue.startRaw,
        startSeconds: cue.startSeconds,
        endSeconds: cue.endSeconds,
      });
    }
  }
  return spans;
};

const lcsLength = (left: readonly string[], right: readonly string[]): number => {
  let previous = new Array<number>(right.length + 1).fill(0);
  for (const leftWord of left) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = leftWord === right[rightIndex - 1]
        ? previous[rightIndex - 1]! + 1
        : Math.max(previous[rightIndex]!, current[rightIndex - 1]!);
    }
    previous = current;
  }
  return previous[right.length]!;
};

/**
 * 把按时间顺序排列的 `cues` 按 `boundariesMs`（每个话语单元的实测终点，升序）分组：
 * 起点落在同一个话语单元区间内的显示单元归为一组。`boundariesMs` 为空时每条显示单元
 * 单独成组——与调用方不提供话语单元边界时的旧行为（逐条比对）完全等价。
 */
const groupCuesByUtterance = (
  cues: readonly ParsedCue[],
  boundariesMs: readonly number[],
): ParsedCue[][] => {
  // 没有话语单元边界时，每条显示单元单独成组——与不提供该参数时的逐条比对旧行为一致。
  if (boundariesMs.length === 0) return cues.map((cue) => [cue]);
  const groups: ParsedCue[][] = [];
  let boundaryIndex = 0;
  let current: ParsedCue[] = [];
  for (const cue of cues) {
    while (
      boundaryIndex < boundariesMs.length &&
      cue.startSeconds * 1000 >= boundariesMs[boundaryIndex]!
    ) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      boundaryIndex++;
    }
    current.push(cue);
  }
  if (current.length > 0) groups.push(current);
  return groups;
};

const resultFromIssues = (issues: SubtitleAuditIssue[]): SubtitleAuditResult => ({
  verdict: issues.some((issue) => issue.severity === "content")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass",
  issues,
});

/**
 * Presentation findings that describe *reading speed*, not a broken frame.
 * A cps/flash cue renders correctly and says exactly what the source says —
 * it is simply brisk, and the fix is a judgement call about wording a human
 * makes better than a retry loop does. Everything else under "presentation"
 * (hard-layout, unsafe-layout, line-count) means the text physically does not
 * fit the frame it is about to be burned into, which still blocks a burn.
 *
 * Treating these two tiers alike is what made the pipeline fail every run:
 * three cps findings out of 205 reading units marked the whole delivery
 * failed, and because `readValidArticleCache` only trusts a manifest whose
 * status is "ready", each retry threw away the cache and re-translated the
 * entire video — paying full LLM cost to reroll a non-deterministic result
 * that had no reachable passing state.
 *
 * `width-budget` is advisory for the same reason. It reports that the writer
 * overshot its own splitting ceiling, which the deterministic re-split in
 * `requestContentAlignedSplit` should now prevent — but the authority on
 * whether a frame is actually broken is the font measurement behind
 * `hard-layout`. Blocking a burn the measurement says renders fine would
 * recreate exactly the unreachable-passing-state failure described above,
 * and every artifact produced before the re-split existed would fail it.
 */
const ADVISORY_PRESENTATION_CODES: ReadonlySet<SubtitleAuditIssueCode> = new Set([
  "cps",
  "flash",
  "width-budget",
]);

export const isSubtitleAuditReadyForDelivery = (
  report: SubtitleAuditResult,
  mode: SubtitleAuditDeliveryMode,
): boolean =>
  !report.issues.some((issue) =>
    issue.severity === "content" ||
    ((mode === "burned" || mode === "all") &&
      issue.severity === "presentation" &&
      !ADVISORY_PRESENTATION_CODES.has(issue.code))
  );

/** The findings a report carries as disclosed debt rather than as a blocker. */
export const subtitleAuditAdvisoryIssues = (
  report: SubtitleAuditResult,
): SubtitleAuditIssue[] =>
  report.issues.filter((issue) =>
    issue.severity === "presentation" && ADVISORY_PRESENTATION_CODES.has(issue.code)
  );

export const auditSubtitleArtifacts = (input: SubtitleAuditInput): SubtitleAuditResult => {
  const issues: SubtitleAuditIssue[] = [];
  if (input.manifest.sourceSha256 !== sha256(input.sourceSrt)) {
    issues.push({
      code: "source-sha",
      severity: "content",
      message: "manifest sourceSha256 does not match the current source SRT",
    });
  }
  const sourceWords = words(input.sourceSrt);
  const articleWords = words(input.enSrt);
  const coveredWords = lcsLength(sourceWords, articleWords);
  if (coveredWords !== sourceWords.length || articleWords.length !== sourceWords.length) {
    issues.push({
      code: "coverage-loss",
      severity: "content",
      message: `article English covers ${coveredWords}/${sourceWords.length} source words and contains ${articleWords.length} words`,
    });
  }
  for (const [label, srt] of [["English", input.enSrt], ["Chinese", input.zhSrt]] as const) {
    const cues = parseSrt(srt);
    if (cues.length === 0) {
      issues.push({
        code: "empty-text",
        severity: "content",
        message: `${label} subtitle artifact contains no cues`,
      });
    }
    for (const cue of cues) {
      if (cue.lines.join(" ").trim().length === 0) {
        issues.push({
          code: "empty-text",
          severity: "content",
          cueIndex: cue.index,
          timestamp: cue.startRaw,
          message: `${label} cue ${cue.index} is empty`,
        });
      }
    }
  }
  const bilingualCues = parseSrt(input.bilingualSrt);
  if (bilingualCues.length === 0) {
    issues.push({
      code: "empty-text",
      severity: "content",
      message: "bilingual subtitle artifact contains no cues",
    });
  }
  for (const cue of bilingualCues) {
    if (
      (cue.lines[0]?.trim().length ?? 0) === 0 ||
      cue.lines.slice(1).join(" ").trim().length === 0
    ) {
      issues.push({
        code: "empty-text",
        severity: "content",
        cueIndex: cue.index,
        timestamp: cue.startRaw,
        message: `bilingual cue ${cue.index} is missing Chinese or English text`,
      });
    }
  }
  for (const [label, srt] of [
    ["source", input.sourceSrt],
    ["English", input.enSrt],
    ["Chinese", input.zhSrt],
    ["bilingual", input.bilingualSrt],
  ] as const) {
    const cues = parseSrt(srt);
    for (let index = 0; index < cues.length; index++) {
      const cue = cues[index]!;
      const previous = cues[index - 1];
      if (
        !Number.isFinite(cue.startSeconds) ||
        !Number.isFinite(cue.endSeconds) ||
        cue.endSeconds <= cue.startSeconds ||
        (previous !== undefined && cue.startSeconds < previous.startSeconds)
      ) {
        issues.push({
          code: "timing-invalid",
          severity: "content",
          cueIndex: cue.index,
          timestamp: cue.startRaw,
          message: `${label} cue ${cue.index} has invalid or decreasing timestamps`,
        });
      }
      if (
        previous !== undefined &&
        Number.isFinite(cue.startSeconds) &&
        Number.isFinite(previous.endSeconds) &&
        cue.startSeconds < previous.endSeconds
      ) {
        issues.push({
          code: "timing-overlap",
          severity: "content",
          cueIndex: cue.index,
          timestamp: cue.startRaw,
          message: `${label} cue ${cue.index} overlaps the previous cue`,
        });
      }
    }
  }
  const aligned = [
    parseSrt(input.enSrt),
    parseSrt(input.zhSrt),
    parseSrt(input.bilingualSrt),
  ] as const;
  // English and bilingual share one display timeline, cue for cue.
  const displayAligned = [aligned[0], aligned[2]] as const;
  const alignedCount = Math.max(...displayAligned.map((cues) => cues.length));
  for (let index = 0; index < alignedCount; index++) {
    const windows = displayAligned.map((cues) => {
      const cue = cues[index];
      return cue === undefined ? undefined : `${cue.startRaw} --> ${cue.endRaw}`;
    });
    if (
      windows.some((window) => window === undefined) ||
      new Set(windows).size !== 1
    ) {
      issues.push({
        code: "bilingual-timing",
        severity: "content",
        cueIndex: index + 1,
        ...(aligned[0][index] !== undefined
          ? { timestamp: aligned[0][index]!.startRaw }
          : {}),
        message: `aligned subtitle cue ${index + 1} has mismatched or missing time windows`,
      });
    }
  }
  const enCues = aligned[0];
  const zhCues = aligned[1];
  /**
   * The Chinese *as displayed*: one entry per bilingual cue, carrying that
   * cue's Chinese line. Layout and reading-speed findings are about what is
   * on screen, so they are measured here rather than on the mono artifact.
   *
   * The two used to be the same list. They stopped being the same when the
   * mono artifact started stating each sentence once (issue #109) — it is a
   * text artifact now, and one of its cues can cover several display cues.
   */
  const zhDisplayCues: ParsedCue[] = bilingualCues.map((cue) => ({
    ...cue,
    lines: cue.lines.slice(0, 1),
  }));
  // The mono Chinese track is a *coarsening* of the display timeline: each of
  // its cues must span an exact, contiguous run of display cues, and the runs
  // must cover every display cue. That is what lets one Chinese sentence
  // cover several English cues without the artifacts drifting apart — and it
  // still catches a mono track that lost, gained, or re-timed content.
  let displayCursor = 0;
  for (const cue of zhCues) {
    if (
      bilingualCues[displayCursor] === undefined ||
      bilingualCues[displayCursor]!.startRaw !== cue.startRaw
    ) {
      issues.push({
        code: "bilingual-timing",
        severity: "content",
        cueIndex: cue.index,
        timestamp: cue.startRaw,
        message: `Chinese cue ${cue.index} does not start where a display cue starts`,
      });
      break;
    }
    while (
      displayCursor < bilingualCues.length &&
      bilingualCues[displayCursor]!.endSeconds <= cue.endSeconds
    ) {
      displayCursor++;
    }
    if (bilingualCues[displayCursor - 1]?.endRaw !== cue.endRaw) {
      issues.push({
        code: "bilingual-timing",
        severity: "content",
        cueIndex: cue.index,
        timestamp: cue.startRaw,
        message: `Chinese cue ${cue.index} does not end where a display cue ends`,
      });
      break;
    }
  }
  if (displayCursor !== bilingualCues.length && zhCues.length > 0) {
    issues.push({
      code: "bilingual-timing",
      severity: "content",
      message:
        `the Chinese track covers ${displayCursor} of ${bilingualCues.length} display cues`,
    });
  }
  const sourceCues = parseSrt(input.sourceSrt);
  // NOTE: identical Chinese text repeated across consecutive cues with
  // different English is NOT flagged here. It's the expected shape whenever
  // one Chinese caption spans several shorter English sub-cues (Chinese is
  // more compact than English) — see
  // docs/superpowers/plans/2026-07-29-subtitle-audit-and-self-calibration.md
  // for the earlier (wrong) version of this rule and why it was removed.
  const protectedTerms = [...PROTECTED_GLOSSARY_TERMS, ...PROTECTED_NAMES];
  // 术语保护的语义是"同一个话语单元里，英文出现的保护词，中文也要出现"——不是"同一条
  // 显示单元里"。显示单元是话语单元的细分，中英文切分边界不保证对齐（中文按视觉宽度
  // 切、英文按词数占比切），逐条比对会把落在相邻显示单元的术语误判为丢失。有话语单元
  // 边界时按边界分组比对；没有时退化为逐条比对（见 `groupCuesByUtterance`）。
  const enGroups = groupCuesByUtterance(enCues, input.utteranceBoundariesMs ?? []);
  const zhGroups = groupCuesByUtterance(zhCues, input.utteranceBoundariesMs ?? []);
  for (let index = 0; index < Math.min(enGroups.length, zhGroups.length); index++) {
    const enGroup = enGroups[index]!;
    const enText = enGroup.map((cue) => cue.lines.join(" ")).join(" ");
    const zhText = zhGroups[index]!.map((cue) => cue.lines.join(" ")).join(" ");
    const firstEnCue = enGroup[0]!;
    for (const term of protectedTerms) {
      if (
        enText.toLocaleLowerCase("en").includes(term.toLocaleLowerCase("en")) &&
        !zhText.includes(term)
      ) {
        issues.push({
          code: "glossary-violation",
          severity: "content",
          cueIndex: firstEnCue.index,
          timestamp: firstEnCue.startRaw,
          text: enText,
          message: `protected term "${term}" is missing from the aligned Chinese cue`,
        });
      }
    }
  }
  // Width check against the projection's own budget, independent of layout
  // measurement. `hard-layout` answers "does this physically fit the frame",
  // measured in real font metrics; this answers "did the writer honor the
  // ceiling it splits against", measured in the same `visualWidth` cells the
  // writer budgets in. They are different questions, and the measured one
  // does not subsume this: the run that shipped a 44-cell Chinese line across
  // five cues measured clean — one cps finding, no hard-layout, no line-count
  // — because the line still fit the frame. It was simply far too much text
  // for one caption, and nothing reported it.
  for (const cue of zhDisplayCues) {
    const width = visualWidth(cue.lines.join(" "));
    if (width > SUBTITLE_AUDIT_THRESHOLDS.maxCueWidth) {
      issues.push({
        code: "width-budget",
        severity: "presentation",
        cueIndex: cue.index,
        timestamp: cue.startRaw,
        text: cue.lines.join(" "),
        message: `cue ${cue.index} is ${width} cells wide, over the ${SUBTITLE_AUDIT_THRESHOLDS.maxCueWidth}-cell budget`,
      });
    }
  }
  for (const measurement of input.measurements ?? []) {
    if (measurement.severity === "hard") {
      const cue = zhDisplayCues[measurement.cueIndex - 1];
      issues.push({
        code: "hard-layout",
        severity: "presentation",
        cueIndex: measurement.cueIndex,
        ...(cue !== undefined
          ? { timestamp: cue.startRaw, text: cue.lines.join(" ") }
          : {}),
        message: `cue ${measurement.cueIndex} exceeds the hard layout threshold`,
      });
      const enCue = enCues[measurement.cueIndex - 1];
      const hasSafeBoundary = enCue !== undefined && sourceCues.some((sourceCue) =>
        sourceCue.endSeconds > enCue.startSeconds &&
        sourceCue.endSeconds < enCue.endSeconds &&
        sourceCue.endSeconds - enCue.startSeconds >=
          SUBTITLE_AUDIT_THRESHOLDS.minSplitDurationSeconds &&
        enCue.endSeconds - sourceCue.endSeconds >=
          SUBTITLE_AUDIT_THRESHOLDS.minSplitDurationSeconds
      );
      if (!hasSafeBoundary) {
        issues.push({
          code: "unsafe-layout",
          severity: "presentation",
          cueIndex: measurement.cueIndex,
          ...(cue !== undefined
            ? { timestamp: cue.startRaw, text: cue.lines.join(" ") }
            : {}),
          message: `hard cue ${measurement.cueIndex} has no safe source cue boundary`,
        });
      }
    }
    if (measurement.lineCount > SUBTITLE_AUDIT_THRESHOLDS.maxLines) {
      const cue = zhDisplayCues[measurement.cueIndex - 1];
      issues.push({
        code: "line-count",
        severity: "presentation",
        cueIndex: measurement.cueIndex,
        ...(cue !== undefined
          ? { timestamp: cue.startRaw, text: cue.lines.join(" ") }
          : {}),
        message: `cue ${measurement.cueIndex} needs ${measurement.lineCount} rendered lines`,
      });
    }
  }
  // A run of consecutive cues showing the identical Chinese text is one
  // continuous reading unit (the expected shape when one translated piece
  // spans several shorter English sub-cues, or a short sentence repeats
  // across its whole source span) — measure reading speed and minimum
  // display time over the WHOLE run's duration, not each cue's own slice.
  // Scoring the same unchanged text against each individual cue's short
  // duration manufactures cps/flash findings that don't reflect what a
  // viewer actually experiences.
  for (const span of groupConsecutiveIdenticalText(zhDisplayCues)) {
    const duration = span.endSeconds - span.startSeconds;
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const cps = visualWidth(span.text) / duration;
    if (cps > SUBTITLE_AUDIT_THRESHOLDS.maxCps) {
      issues.push({
        code: "cps",
        severity: "presentation",
        cueIndex: span.firstIndex,
        timestamp: span.startRaw,
        text: span.text,
        message: `Chinese cue ${span.firstIndex} reads at ${cps.toFixed(2)} CJK cells per second`,
      });
    }
    if (duration < SUBTITLE_AUDIT_THRESHOLDS.minCueDurationSeconds) {
      issues.push({
        code: "flash",
        severity: "presentation",
        cueIndex: span.firstIndex,
        timestamp: span.startRaw,
        text: span.text,
        message: `cue ${span.firstIndex} is visible for only ${duration.toFixed(3)} seconds`,
      });
    }
  }
  return resultFromIssues(issues);
};
