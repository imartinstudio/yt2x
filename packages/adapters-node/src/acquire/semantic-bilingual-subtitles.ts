import { createHash } from "node:crypto";
import type { LlmPort } from "@yt2x/core";
import { parseSubtitleBlocks, serializeSrtBlocks } from "./video-subtitles.js";

export type SemanticSubtitleGroup = {
  groupId: string;
  sourceStartIndex: number;
  sourceEndIndex: number;
  sourceText: string;
  zhText: string;
};

export type SubtitleLayoutMeasurement = {
  cueIndex: number;
  zhWidth: number;
  fitWidth: number;
  lineCount: number;
  severity: "fit" | "aim" | "hard";
  resolvedFonts: { zh: string; en: string };
};

export type SemanticBilingualQualityIssue = {
  code:
    | "coverage"
    | "source-sha"
    | "timing"
    | "bilingual-timing"
    | "hard-layout"
    | "line-count"
    | "cps"
    | "unsafe-layout";
  groupId?: string;
  severity: "content" | "presentation";
  message: string;
};

export type SemanticBilingualQualityReport = {
  readyForBurn: boolean;
  issues: SemanticBilingualQualityIssue[];
};

export type SemanticBilingualProjection = {
  enSrt: string;
  zhSrt: string;
  bilingualSrt: string;
  sourceSha256: string;
  groups: SemanticSubtitleGroup[];
  quality: SemanticBilingualQualityReport;
};

export type SemanticProjectionOptions = {
  sourceSrt: string;
  llm: LlmPort;
  model: string;
  measureLayout: (provisionalBilingualSrt: string) => Promise<SubtitleLayoutMeasurement[]>;
  signal?: AbortSignal;
};

export type SemanticProjectionErrorCode =
  | "invalid-json"
  | "invalid-contiguous-coverage"
  | "invalid-layout-measurement"
  | "invalid-second-pass"
  | "invalid-source-sha";

export class SemanticProjectionError extends Error {
  readonly code: SemanticProjectionErrorCode;

  constructor(code: SemanticProjectionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SemanticProjectionError";
    this.code = code;
  }
}

type RequestedGroup = {
  sourceStartIndex: number;
  sourceEndIndex: number;
  zhText: string;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const normalizeText = (lines: readonly string[]): string =>
  lines.join(" ").replace(/\s+/gu, " ").trim();

const parseGroupsResponse = (raw: string): RequestedGroup[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new SemanticProjectionError("invalid-json", "semantic response is not valid JSON", {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { groups?: unknown }).groups)) {
    throw new SemanticProjectionError(
      "invalid-json",
      'semantic response must be an object with a "groups" array',
    );
  }
  return (parsed as { groups: unknown[] }).groups.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new SemanticProjectionError("invalid-json", "semantic group must be an object");
    }
    const group = item as Record<string, unknown>;
    if (
      !Number.isInteger(group.sourceStartIndex) ||
      !Number.isInteger(group.sourceEndIndex) ||
      typeof group.zhText !== "string"
    ) {
      throw new SemanticProjectionError(
        "invalid-json",
        "semantic group fields must be integer indices and string zhText",
      );
    }
    return {
      sourceStartIndex: group.sourceStartIndex as number,
      sourceEndIndex: group.sourceEndIndex as number,
      zhText: group.zhText,
    };
  });
};

const validateAndMaterializeGroups = (
  requested: readonly RequestedGroup[],
  cues: ReturnType<typeof parseSubtitleBlocks>,
): SemanticSubtitleGroup[] => {
  if (requested.length === 0 || cues.length === 0) {
    throw new SemanticProjectionError(
      "invalid-contiguous-coverage",
      "semantic groups and source cues must be non-empty",
    );
  }

  let expectedStart = cues[0]!.index;
  const groups: SemanticSubtitleGroup[] = [];
  for (const group of requested) {
    if (
      group.sourceStartIndex !== expectedStart ||
      group.sourceEndIndex < group.sourceStartIndex ||
      group.zhText.trim().length === 0
    ) {
      throw new SemanticProjectionError(
        "invalid-contiguous-coverage",
        `invalid semantic range ${group.sourceStartIndex}-${group.sourceEndIndex}; expected ${expectedStart}`,
      );
    }
    const selected = cues.filter(
      (cue) => cue.index >= group.sourceStartIndex && cue.index <= group.sourceEndIndex,
    );
    if (
      selected.length !== group.sourceEndIndex - group.sourceStartIndex + 1 ||
      selected[0]?.index !== group.sourceStartIndex ||
      selected[selected.length - 1]?.index !== group.sourceEndIndex
    ) {
      throw new SemanticProjectionError(
        "invalid-contiguous-coverage",
        `semantic range ${group.sourceStartIndex}-${group.sourceEndIndex} is outside source cues`,
      );
    }
    const sourceText = selected.map((cue) => normalizeText(cue.text)).join(" ").trim();
    const groupId = sha256(
      `${group.sourceStartIndex}:${group.sourceEndIndex}:${sourceText}`,
    );
    groups.push({
      groupId,
      sourceStartIndex: group.sourceStartIndex,
      sourceEndIndex: group.sourceEndIndex,
      sourceText,
      zhText: group.zhText.trim(),
    });
    expectedStart = group.sourceEndIndex + 1;
  }

  if (expectedStart !== cues[cues.length - 1]!.index + 1) {
    throw new SemanticProjectionError(
      "invalid-contiguous-coverage",
      `semantic groups stop at ${expectedStart - 1}; source ends at ${cues[cues.length - 1]!.index}`,
    );
  }
  return groups;
};

const serializeProjection = (
  groups: readonly SemanticSubtitleGroup[],
  cues: ReturnType<typeof parseSubtitleBlocks>,
): Pick<SemanticBilingualProjection, "enSrt" | "zhSrt" | "bilingualSrt"> => {
  const blocks = groups.map((group, offset) => {
    const first = cues[group.sourceStartIndex - 1]!;
    const last = cues[group.sourceEndIndex - 1]!;
    return {
      index: offset + 1,
      start: first.start,
      end: last.end,
      enText: group.sourceText,
      zhText: group.zhText,
    };
  });
  return {
    enSrt: serializeSrtBlocks(
      blocks.map(({ index, start, end, enText }) => ({ index, start, end, text: [enText] })),
    ),
    zhSrt: serializeSrtBlocks(
      blocks.map(({ index, start, end, zhText }) => ({ index, start, end, text: [zhText] })),
    ),
    bilingualSrt: serializeSrtBlocks(
      blocks.map(({ index, start, end, zhText, enText }) => ({
        index,
        start,
        end,
        text: [zhText, enText],
      })),
    ),
  };
};

export const evaluateSemanticBilingualDelivery = (input: {
  groups: readonly SemanticSubtitleGroup[];
  measurements: readonly SubtitleLayoutMeasurement[];
}): SemanticBilingualQualityReport => {
  const issues: SemanticBilingualQualityIssue[] = [];
  for (const measurement of input.measurements) {
    const group = input.groups[measurement.cueIndex - 1];
    if (group === undefined) continue;
    if (measurement.severity === "hard") {
      issues.push({
        code: "hard-layout",
        groupId: group.groupId,
        severity: "presentation",
        message: `group ${group.groupId} exceeds the hard layout threshold`,
      });
    }
    if (measurement.lineCount > 2) {
      issues.push({
        code: "line-count",
        groupId: group.groupId,
        severity: "presentation",
        message: `group ${group.groupId} needs ${measurement.lineCount} lines`,
      });
    }
  }
  return { readyForBurn: issues.length === 0, issues };
};

export const projectSemanticBilingualSubtitles = async (
  opts: SemanticProjectionOptions,
): Promise<SemanticBilingualProjection> => {
  const sourceSha256 = sha256(opts.sourceSrt);
  const cues = parseSubtitleBlocks(opts.sourceSrt);
  if (cues.length === 0) {
    throw new SemanticProjectionError(
      "invalid-contiguous-coverage",
      "source SRT contains no cues",
    );
  }

  const response = await opts.llm.chat({
    model: opts.model,
    messages: [
      {
        role: "system",
        content: [
          "Translate English subtitle cues into complete natural Simplified Chinese sentences.",
          'Return JSON as {"groups":[{"sourceStartIndex":1,"sourceEndIndex":2,"zhText":"..."}]}.',
          "Every source cue must be covered exactly once by contiguous ranges.",
          "Preserve product names, commands, code, and numbers verbatim.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(
          cues.map((cue) => ({ index: cue.index, text: normalizeText(cue.text) })),
        ),
      },
    ],
    temperature: 0.2,
    maxTokens: 16384,
    jsonMode: true,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  const requested = parseGroupsResponse(response.content.trim());
  const groups = validateAndMaterializeGroups(requested, cues);
  const serialized = serializeProjection(groups, cues);
  const measurements = await opts.measureLayout(serialized.bilingualSrt);
  if (
    measurements.length !== groups.length ||
    measurements.some((measurement, index) => measurement.cueIndex !== index + 1)
  ) {
    throw new SemanticProjectionError(
      "invalid-layout-measurement",
      "layout measurements must cover every projected cue in order",
    );
  }
  const quality = evaluateSemanticBilingualDelivery({ groups, measurements });

  return {
    ...serialized,
    sourceSha256,
    groups,
    quality,
  };
};
