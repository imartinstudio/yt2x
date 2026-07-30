import { createHash } from "node:crypto";
import {
  PROTECTED_GLOSSARY_TERMS,
  PROTECTED_NAMES,
  visualWidth,
} from "./semantic-bilingual-subtitles.js";

export const SUBTITLE_AUDIT_THRESHOLDS = {
  maxLines: 2,
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
 */
const ADVISORY_PRESENTATION_CODES: ReadonlySet<SubtitleAuditIssueCode> = new Set([
  "cps",
  "flash",
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
  const alignedCount = Math.max(...aligned.map((cues) => cues.length));
  for (let index = 0; index < alignedCount; index++) {
    const windows = aligned.map((cues) => {
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
  const sourceCues = parseSrt(input.sourceSrt);
  // NOTE: identical Chinese text repeated across consecutive cues with
  // different English is NOT flagged here. It's the expected shape whenever
  // one Chinese caption spans several shorter English sub-cues (Chinese is
  // more compact than English) — see
  // docs/superpowers/plans/2026-07-29-subtitle-audit-and-self-calibration.md
  // for the earlier (wrong) version of this rule and why it was removed.
  const protectedTerms = [...PROTECTED_GLOSSARY_TERMS, ...PROTECTED_NAMES];
  for (let index = 0; index < Math.min(enCues.length, zhCues.length); index++) {
    const enText = enCues[index]!.lines.join(" ");
    const zhText = zhCues[index]!.lines.join(" ");
    for (const term of protectedTerms) {
      if (
        enText.toLocaleLowerCase("en").includes(term.toLocaleLowerCase("en")) &&
        !zhText.includes(term)
      ) {
        issues.push({
          code: "glossary-violation",
          severity: "content",
          cueIndex: enCues[index]!.index,
          timestamp: enCues[index]!.startRaw,
          text: enText,
          message: `protected term "${term}" is missing from the aligned Chinese cue`,
        });
      }
    }
  }
  for (const measurement of input.measurements ?? []) {
    if (measurement.severity === "hard") {
      const cue = zhCues[measurement.cueIndex - 1];
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
      const cue = zhCues[measurement.cueIndex - 1];
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
  for (const span of groupConsecutiveIdenticalText(zhCues)) {
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
