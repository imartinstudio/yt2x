import { createHash } from "node:crypto";
import {
  PROTECTED_GLOSSARY_TERMS,
  PROTECTED_NAMES,
} from "./semantic-bilingual-subtitles.js";

export const SUBTITLE_AUDIT_THRESHOLDS = {
  maxLines: 2,
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
  | "adjacent-duplicate"
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

const normalizedCueText = (cue: ParsedCue): string =>
  cue.lines.join(" ").normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();

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

export const isSubtitleAuditReadyForDelivery = (
  report: SubtitleAuditResult,
  mode: SubtitleAuditDeliveryMode,
): boolean =>
  !report.issues.some((issue) =>
    issue.severity === "content" ||
    ((mode === "burned" || mode === "all") && issue.severity === "presentation")
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
  for (let index = 1; index < Math.min(enCues.length, zhCues.length); index++) {
    const previousZh = normalizedCueText(zhCues[index - 1]!);
    const currentZh = normalizedCueText(zhCues[index]!);
    const previousEn = normalizedCueText(enCues[index - 1]!);
    const currentEn = normalizedCueText(enCues[index]!);
    if (currentZh.length > 0 && currentZh === previousZh && currentEn !== previousEn) {
      issues.push({
        code: "adjacent-duplicate",
        severity: "content",
        cueIndex: zhCues[index]!.index,
        timestamp: zhCues[index]!.startRaw,
        text: zhCues[index]!.lines.join(" "),
        message: `Chinese cue ${zhCues[index]!.index} duplicates the previous cue for different English`,
      });
    }
  }
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
  for (const cue of zhCues) {
    const duration = cue.endSeconds - cue.startSeconds;
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const characterCount = Array.from(cue.lines.join("").replace(/\s/gu, "")).length;
    const cps = characterCount / duration;
    if (cps > SUBTITLE_AUDIT_THRESHOLDS.maxCps) {
      issues.push({
        code: "cps",
        severity: "presentation",
        cueIndex: cue.index,
        timestamp: cue.startRaw,
        text: cue.lines.join(" "),
        message: `Chinese cue ${cue.index} reads at ${cps.toFixed(2)} characters per second`,
      });
    }
    if (duration < SUBTITLE_AUDIT_THRESHOLDS.minCueDurationSeconds) {
      issues.push({
        code: "flash",
        severity: "presentation",
        cueIndex: cue.index,
        timestamp: cue.startRaw,
        text: cue.lines.join(" "),
        message: `cue ${cue.index} is visible for only ${duration.toFixed(3)} seconds`,
      });
    }
  }
  return resultFromIssues(issues);
};
