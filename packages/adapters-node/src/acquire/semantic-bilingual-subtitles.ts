import { createHash } from "node:crypto";
import {
  createTechnicalTermGuard,
  findProtectedSpans,
  hasHardTechnicalTermViolations,
  PROTECTED_GLOSSARY_TERMS,
  PROTECTED_NAMES,
  PROTECTED_TERMS,
  type TechnicalTermGuard,
  type TechnicalTermRestoration,
  type LlmPort,
} from "@yt2x/core";
import { repairTechnicalTermViolations } from "../technical-terms/discovery.js";
import type { SubtitleAuditIssue } from "./audit-subtitles.js";
import { parseSubtitleBlocks, serializeSrtBlocks } from "./video-subtitles.js";

// Re-exported for `audit-subtitles.ts` and this module's own tests, which
// import these from here rather than `@yt2x/core` directly. The definitions
// themselves now live in core (`packages/core/src/domain/dub/glossary.ts`)
// so the dub translation prompt can share the same table — see that file's
// header comment for why.
export { findProtectedSpans, PROTECTED_GLOSSARY_TERMS, PROTECTED_NAMES };

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

export type SemanticBilingualQualityIssue = SubtitleAuditIssue;

export type SemanticBilingualQualityReport = {
  readyForBurn: boolean;
  issues: SemanticBilingualQualityIssue[];
};

export type SemanticBilingualProjection = {
  enSrt: string;
  zhSrt: string;
  bilingualSrt: string;
  sourceSha256: string;
  technicalTermProfileFingerprint: string;
  groups: SemanticSubtitleGroup[];
};

export type SemanticProjectionOptions = {
  sourceSrt: string;
  llm: LlmPort;
  model: string;
  measureLayout: (provisionalBilingualSrt: string) => Promise<SubtitleLayoutMeasurement[]>;
  signal?: AbortSignal;
  /**
   * Optional forced-alignment word timestamps for the source audio (see
   * forced-align.py). When available, cue-growth splitting (see
   * `ensureEnoughFineCues`) uses real timing instead of guessing a split
   * point from relative text length. Absent entirely when torchaudio isn't
   * installed — the pipeline degrades to the proportional guess.
   */
  wordTimings?: readonly WordTiming[];
  /** Full-source technical-term guard discovered once by the caller. */
  technicalTermGuard?: TechnicalTermGuard;
};

export type SemanticProjectionErrorCode =
  | "invalid-json"
  | "invalid-contiguous-coverage"
  | "invalid-layout-measurement"
  | "invalid-source-sha";

export class SemanticProjectionError extends Error {
  readonly code: SemanticProjectionErrorCode;

  constructor(code: SemanticProjectionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SemanticProjectionError";
    this.code = code;
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const normalizeText = (lines: readonly string[]): string =>
  lines.join(" ").replace(/\s+/gu, " ").trim();

type SemanticTextFinalizer = (
  sourceText: string,
  candidate: string,
) => Promise<string | null>;

const scopeTechnicalTermGuard = (
  guard: TechnicalTermGuard,
  sourceText: string,
): TechnicalTermGuard => {
  const discoveredTerms = guard.profile.entries
    .filter((entry) => {
      const pattern = new RegExp(
        `(?<![A-Za-z0-9])${entry.sourceText.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}(?![A-Za-z0-9])`,
        "iu",
      );
      return pattern.test(sourceText);
    })
    .map((entry) => ({
      sourceText: entry.sourceText,
      confidence: "high" as const,
      category: "domain" as const,
    }));
  return createTechnicalTermGuard({ sourceText, discoveredTerms });
};

const finalizeSemanticText = async (input: {
  sourceText: string;
  candidate: string;
  guard: TechnicalTermGuard;
  restoration: TechnicalTermRestoration;
  llm: LlmPort;
  model: string;
  signal?: AbortSignal;
  repairState: { used: boolean };
}): Promise<string | null> => {
  const scopedGuard = scopeTechnicalTermGuard(input.guard, input.sourceText);
  const finalized = scopedGuard.finalize(input.candidate, input.restoration);
  if (!hasHardTechnicalTermViolations(finalized.violations)) return finalized.value;
  if (input.repairState.used) return null;
  input.repairState.used = true;
  const repaired = await repairTechnicalTermViolations({
    llm: input.llm,
    model: input.model,
    guard: scopedGuard,
    currentValue: finalized.value,
    restoration: input.restoration,
    violations: finalized.violations,
    parseResponse: (content) => content.trim(),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return hasHardTechnicalTermViolations(repaired.violations) ? null : repaired.value;
};

// ── Concurrency helper (multi-agent worker pool) ──

const parallelMap = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
};

// ── SRT timestamp helpers ──

const timestampToSeconds = (ts: string): number => {
  const parts = ts.split(":");
  const h = parts[0] ?? "00";
  const m = parts[1] ?? "00";
  const rest = parts[2] ?? "00,000";
  const [s = "00", ms = "000"] = rest.split(",");
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
};

const secondsToTimestamp = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
};

// ═══════════════════════════════════════════════════════════════════════════
// Phase 0: Repunct + Split — add punctuation and split long cues.
// Each cue gets an index; the LLM may split a cue into sub-cues (using the
// same index).  We map sub-cues back to the original time ranges.
// ═══════════════════════════════════════════════════════════════════════════

const REPUNCT_PAGE_SIZE = 8;

// Flat weight baseline added to every comma-split fragment's character
// length before computing its proportional time share (see
// splitCuesAtCommas) — keeps a short fragment's guessed duration from
// collapsing toward zero next to a much longer one.
const PROPORTIONAL_SPLIT_BASE_CHARS = 20;

// ── Phase 0: Insert commas at natural boundaries, then split deterministically ──
// BaoCut-inspired: the LLM only INSERTS punctuation (a choice task), it does NOT
// rewrite text.  We then split at commas deterministically.  Each cue gets a
// numeric index for time-range mapping.
// Budget: 10 words per clause max; cues with 12+ words MUST be split.
//
// The wire format mirrors BaoCut's own repunct contract: the LLM never echoes
// text, it only returns seam ids (word-boundary positions) plus a mark. This
// makes it structurally impossible for a rewrite/drop/truncation to corrupt a
// cue — we always splice marks into OUR OWN copy of the original words.

const ALLOWED_PUNCTUATION_MARKS = new Set([",", ";", ":", ".", "!", "?"]);

type SeamCut = { id: string; mark: string };

export const buildSeamDisplay = (words: readonly string[]): string =>
  words.map((word, i) => `${word}<@${i}>`).join(" ");

export const applySeamCuts = (words: readonly string[], cuts: readonly SeamCut[]): string => {
  const markAfter = new Map<number, string>();
  for (const cut of cuts) {
    const seamIdx = Number(cut.id);
    if (!Number.isInteger(seamIdx) || seamIdx < 0 || seamIdx >= words.length) continue;
    if (!ALLOWED_PUNCTUATION_MARKS.has(cut.mark)) continue;
    // A YouTube caption word can already carry its own trailing punctuation;
    // adding another mark on top would double it up (e.g. "them,,").
    if (/[,;:.!?]$/u.test(words[seamIdx]!)) continue;
    markAfter.set(seamIdx, cut.mark);
  }
  return words.map((word, i) => (markAfter.has(i) ? `${word}${markAfter.get(i)!}` : word)).join(" ");
};

const insertCommas = async (
  cues: ReturnType<typeof parseSubtitleBlocks>,
  llm: LlmPort,
  model: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  const cueWords = cues.map((c) => normalizeText(c.text).split(/\s+/u));
  const pages: { idx: number; seams: string }[][] = [];
  for (let i = 0; i < cues.length; i += REPUNCT_PAGE_SIZE) {
    pages.push(
      cueWords.slice(i, i + REPUNCT_PAGE_SIZE).map((words, j) => ({
        idx: i + j,
        seams: buildSeamDisplay(words),
      })),
    );
  }

  // Default: every cue keeps its original words, unchanged.
  const results: string[] = cueWords.map((words) => words.join(" "));

  for (const page of pages) {
    const resp = await llm.chat({
      model,
      messages: [
        {
          role: "system",
          content: [
            "Add punctuation at natural pause points in these English subtitle cues.",
            "Each cue's words are shown with a <@id> marker after every word — these",
            "are the ONLY positions where you may insert a mark.",
            "Insert commas where a speaker would briefly pause — between clauses and phrases.",
            "Also add sentence-ending punctuation (. ! ?) at the last seam when a cue ends",
            "a sentence and is missing it.",
            "If a cue has 12+ words, you MUST include at least one comma cut.",
            "Omit a cue entirely from the response if it needs no punctuation changes.",
            'Return JSON: {"cues":[{"idx":0,"cuts":[{"id":"3","mark":","}]}]}',
            "mark must be one of: , ; : . ! ?",
            "Copy seam ids exactly as shown; never invent one, never echo the words.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify(page),
        },
      ],
      temperature: 0.1,
      maxTokens: 4096,
      jsonMode: true,
      ...(signal !== undefined ? { signal } : {}),
    });

    const parsed = JSON.parse(resp.content.trim()) as {
      cues?: { idx: number; cuts?: SeamCut[] }[];
    };
    if (!Array.isArray(parsed.cues)) {
      throw new SemanticProjectionError("invalid-json", "repunct: invalid response");
    }
    for (const item of parsed.cues) {
      if (typeof item.idx !== "number" || item.idx < 0 || item.idx >= cues.length) continue;
      const cuts = Array.isArray(item.cuts) ? item.cuts : [];
      results[item.idx] = applySeamCuts(cueWords[item.idx]!, cuts);
    }
  }

  return results;
};

// Words that make a natural clause boundary when a run-on segment must be
// bisected without any punctuation to guide the cut. The trailing \b is
// required — without it "so" prefix-matches "sometimes"/"software", "or"
// matches "organize", "with" matches "without", etc., misidentifying an
// unrelated word as a clause-starter and cutting the sentence apart there.
const CLAUSE_BOUNDARY_WORDS =
  /^(and|but|or|so|because|when|where|which|that|if|for|with|about|like|just|also|however|then|now)\b/i;

const findClauseSplitIndex = (words: string[]): number => {
  const mid = Math.floor(words.length / 2);
  let splitAt = mid;
  for (let offset = 0; offset < 4 && (mid + offset < words.length || mid - offset > 1); offset++) {
    const fwd = mid + offset;
    if (fwd < words.length && CLAUSE_BOUNDARY_WORDS.test(words[fwd]!)) {
      splitAt = fwd;
      break;
    }
    const back = mid - offset;
    if (back > 1 && CLAUSE_BOUNDARY_WORDS.test(words[back]!)) {
      splitAt = back;
      break;
    }
  }
  return splitAt;
};

// ── Split cues at commas (deterministic, after LLM inserted them) ──
const splitCuesAtCommas = (
  cues: ReturnType<typeof parseSubtitleBlocks>,
  punctuated: string[],
  wordTimings?: readonly WordTiming[],
): { start: string; end: string; text: string }[] => {
  const result: { start: string; end: string; text: string }[] = [];

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const text = punctuated[i]!;

    const parts = text.split(/(?<=[,;:])\s+/u).filter((p) => p.trim().length > 0);
    if (parts.length <= 1) {
      result.push({ start: cue.start, end: cue.end, text });
      continue;
    }

    // Merge short fragments (<4 words) with neighbors. Uncapped — a short
    // fragment left standing alone (a single-word flash cue) is worse than a
    // merged fragment that needs rebalancing, and the ">8 words" mechanical
    // fallback below re-splits any oversized result at a natural clause
    // boundary (comparable to BaoCut's clause budget).
    const merged: string[] = [];
    for (const part of parts) {
      const wordCount = part.trim().split(/\s+/u).length;
      if (merged.length > 0 && wordCount < 4) {
        merged[merged.length - 1] = merged[merged.length - 1]! + " " + part.trim();
      } else {
        merged.push(part.trim());
      }
    }
    // The backward pass above can never reach a short fragment that has no
    // predecessor to absorb it — most commonly the FIRST fragment of a cue
    // (e.g. a leading "Now," / "you," clause), which would otherwise survive
    // as an isolated single-word flash cue. Sweep forward once more and glue
    // any fragment still under the word threshold onto its right neighbor,
    // uncapped — the ">8 words" mechanical fallback right below rebalances
    // any resulting oversized fragment at a natural clause boundary, which
    // beats leaving a single word standing alone either way.
    for (let i = 0; i < merged.length - 1; i++) {
      const wordCount = merged[i]!.split(/\s+/u).length;
      if (wordCount >= 4) continue;
      merged[i + 1] = `${merged[i]} ${merged[i + 1]}`;
      merged.splice(i, 1);
      i--;
    }

    // Mechanical fallback: split any segment >8 words at phrase boundaries.
    const finalParts: string[] = [];
    for (const part of merged) {
      const words = part.split(/\s+/u);
      if (words.length <= 8) {
        finalParts.push(part);
        continue;
      }
      const splitAt = findClauseSplitIndex(words);
      finalParts.push(words.slice(0, splitAt).join(" "));
      finalParts.push(words.slice(splitAt).join(" "));
    }

    if (finalParts.length === 1) {
      result.push({ start: cue.start, end: cue.end, text: finalParts[0]! });
      continue;
    }

    const cueStart = timestampToSeconds(cue.start);
    const cueEnd = timestampToSeconds(cue.end);

    const originalWords = normalizeText(cue.text).split(/\s+/u);
    const matched = wordTimings !== undefined
      ? findWordTimingsForCue(originalWords, cueStart, cueEnd, wordTimings)
      : null;

    let t = cueStart;
    if (matched !== null) {
      // Real timing: each part's boundary is the end of its last word.
      let wordCursor = 0;
      for (let p = 0; p < finalParts.length; p++) {
        wordCursor += finalParts[p]!.split(/\s+/u).length;
        const end = p === finalParts.length - 1 ? cueEnd : matched[wordCursor - 1]!.end;
        result.push({
          start: secondsToTimestamp(t),
          end: secondsToTimestamp(end),
          text: finalParts[p]!.trim(),
        });
        t = end;
      }
    } else {
      // Proportional-by-length guess (no real word timing available). A
      // short lead-in fragment like "Now," split from a much longer
      // continuation would otherwise get a near-zero share (e.g. 4 chars
      // out of 90 on a 2.9s cue -> 0.13s) — nowhere close to how long it's
      // actually spoken, since a short clause is typically followed by a
      // real pause, not proportionally less time. Add a flat baseline to
      // every fragment's weight before computing shares, so a short
      // fragment's floor rises toward a fairer minimum without meaningfully
      // taking time away from a genuinely long neighbor.
      const weights = finalParts.map((p) => p.length + PROPORTIONAL_SPLIT_BASE_CHARS);
      const totalWeight = weights.reduce((s, w) => s + w, 0);
      for (let p = 0; p < finalParts.length; p++) {
        const frac = weights[p]! / totalWeight;
        const dur = (cueEnd - cueStart) * frac;
        const end = p === finalParts.length - 1 ? cueEnd : t + dur;
        result.push({
          start: secondsToTimestamp(t),
          end: secondsToTimestamp(end),
          text: finalParts[p]!.trim(),
        });
        t = end;
      }
    }
  }

  // Sort by start time and clip overlaps.
  result.sort((a, b) => timestampToSeconds(a.start) - timestampToSeconds(b.start));
  for (let i = 1; i < result.length; i++) {
    const prevEnd = timestampToSeconds(result[i - 1]!.end);
    const curStart = timestampToSeconds(result[i]!.start);
    if (curStart < prevEnd) {
      result[i]!.start = secondsToTimestamp(prevEnd);
    }
  }
  return result;
};

// ── BaoCut-style fit budget ──
// f/t/hard, matching BaoCut's alignment contract for Simplified Chinese:
// fit=16 is the split trigger, aim=14 is the soft per-part target, and 20 is
// the blocking hard ceiling — a delivered piece must never exceed it.
const FIT_CJK = 16;
const TARGET_CJK = 14;
export const HARD_CJK = 20;

// BaoCut treats one second of source speech on each side as the floor for a
// "natural" split; below that a cut produces an unreadable flash.
const MIN_SPLIT_DURATION_S = 1;

// Matches SUBTITLE_AUDIT_THRESHOLDS.maxCps in audit-subtitles.ts — kept as a
// separate local constant to avoid a dependency in that direction.
const MAX_CPS_BEFORE_MERGE = 9;

const CJK_PATTERN = /[一-鿿㐀-䶿\u{f900}-\u{faff}]/u;
const LATIN_ALNUM_PATTERN = /[A-Za-z0-9]/u;

// PROTECTED_GLOSSARY_TERMS, PROTECTED_NAMES, PROTECTED_TERMS, and
// findProtectedSpans now live in `packages/core/src/domain/dub/glossary.ts`
// (imported above, re-exported near the top of this file) so the dub
// translation prompt can share the same table instead of maintaining its
// own — see that file's header comment for why. findProtectedSpans is still
// used below to keep a split point from landing inside a glossary term.

/**
 * Nudges a proposed split index to the nearest edge of any protected span it
 * falls inside, without ever leaving [minBound, maxBound]. Returns null if no
 * escape exists within those bounds (the span leaves no room). Bounds must be
 * enforced *inside* this search, not by a separate clamp applied afterward —
 * a later `Math.max(minBound, ...)` can push the nudged result straight back
 * into the span it just escaped.
 */
const nudgeWithinBounds = (
  splitAt: number,
  spans: readonly [number, number][],
  minBound: number,
  maxBound: number,
): number | null => {
  let result = Math.max(minBound, Math.min(splitAt, maxBound));
  for (let pass = 0; pass < 3; pass++) {
    const hit = spans.find(([start, end]) => result > start && result < end);
    if (hit === undefined) return result;
    const [start, end] = hit;
    const canGoStart = start >= minBound;
    const canGoEnd = end <= maxBound;
    if (canGoStart && canGoEnd) {
      result = result - start <= end - result ? start : end;
    } else if (canGoStart) {
      result = start;
    } else if (canGoEnd) {
      result = end;
    } else {
      return null; // no escape within these bounds
    }
  }
  return result;
};

/**
 * Finds a split point that avoids every protected span, preferring the
 * cosmetic "no fragment under 4 chars" window but widening to the bare
 * minimum (non-empty pieces on both sides) when a word sits so close to a
 * boundary that the cosmetic window leaves no room to escape it — an intact
 * word matters more than that preference. Only when a span spans virtually
 * the whole remaining text (no escape even at the bare minimum) does this
 * fall back to the original position.
 */
const nudgeOutOfProtectedSpans = (
  splitAt: number,
  spans: readonly [number, number][],
  remainingLength: number,
): number => {
  const preferred = nudgeWithinBounds(splitAt, spans, 4, remainingLength - 2);
  if (preferred !== null) return preferred;
  const widened = nudgeWithinBounds(splitAt, spans, 1, remainingLength - 1);
  if (widened !== null) return widened;
  return Math.max(4, Math.min(splitAt, remainingLength - 2));
};

const protectedTermsForGuard = (guard: TechnicalTermGuard): string[] => [
  ...guard.profile.entries.flatMap((term) => [term.canonical, term.sourceText]),
];

export const splitLongZh = (
  zh: string,
  partCount: number,
  technicalTermGuard?: TechnicalTermGuard,
): string[] => {
  if (partCount <= 1) return [zh];
  const parts: string[] = [];
  let remaining = zh;
  const targetLen = Math.ceil(zh.length / partCount);
  while (remaining.length > targetLen && parts.length < partCount - 1) {
    let splitAt = targetLen;
    // Prefer strong boundaries (。！？) then weak (，；：、)
    for (const pattern of [/[。！？]/u, /[，；：、]/u]) {
      let found = false;
      for (let offset = 0; offset < 10; offset++) {
        const fwd = targetLen + offset;
        if (fwd < remaining.length && pattern.test(remaining[fwd]!)) { splitAt = fwd + 1; found = true; break; }
        const back = targetLen - offset - 1;
        if (back > 3 && pattern.test(remaining[back]!)) { splitAt = back + 1; found = true; break; }
      }
      if (found) break;
    }
    splitAt = nudgeOutOfProtectedSpans(
      splitAt,
      findProtectedSpans(
        remaining,
        technicalTermGuard === undefined ? undefined : protectedTermsForGuard(technicalTermGuard),
      ),
      remaining.length,
    );
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) parts.push(remaining.trim());
  return parts.length >= 2 ? parts : [zh];
};

/**
 * BaoCut measures fit "on the delivery projection": CJK glyphs are one full
 * cell, halfwidth Latin/digit glyphs are half a cell, and punctuation weighs
 * nothing. A raw character count over-penalizes CJK-only text and under-
 * penalizes sentences padded with untranslated glossary terms (e.g. "Codex").
 */
export const visualWidth = (text: string): number => {
  let width = 0;
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) width += 1;
    else if (LATIN_ALNUM_PATTERN.test(ch)) width += 0.5;
  }
  return width;
};

/**
 * Recursively splits any part whose visual width exceeds `hardLimit`. Reuses
 * `splitLongZh`'s punctuation-seam search (with a mechanical bisection
 * fallback when no seam exists), so this always terminates and never drops
 * content — every recursive call halves the offending part's width.
 */
export const enforceHardCeiling = (
  parts: readonly string[],
  hardLimit: number,
  technicalTermGuard?: TechnicalTermGuard,
): string[] => {
  const result: string[] = [];
  for (const part of parts) {
    if (visualWidth(part) <= hardLimit) {
      result.push(part);
      continue;
    }
    const halves = splitLongZh(part, 2, technicalTermGuard);
    if (halves.length < 2) {
      result.push(part); // unsplittable (e.g. a single unbreakable token)
      continue;
    }
    result.push(...enforceHardCeiling(halves, hardLimit, technicalTermGuard));
  }
  return result;
};

/**
 * Splits `totalCues` display slots across `weights.length` parts,
 * proportional to each part's weight (typically `visualWidth`). Every part
 * gets at least 1 cue (the caller guarantees `weights.length <= totalCues`).
 * Uses the largest-remainder method so counts always sum to exactly
 * `totalCues`, regardless of rounding.
 *
 * Regression: naively giving every part `floor(totalCues/parts.length)` and
 * dumping the entire remainder on the last part meant a short trailing
 * fragment (e.g. a two-character "了。") could absorb most of the leftover
 * cues just because it came last — real output showed it alone for 6
 * consecutive blocks while a much longer fragment got only 2.
 */
export const allocateCuesByWeight = (weights: readonly number[], totalCues: number): number[] => {
  if (weights.length === 0) return [];
  if (weights.length === 1) return [totalCues];

  const safeWeights = weights.map((w) => Math.max(w, 0.01));
  const counts = new Array(weights.length).fill(1);
  const extra = totalCues - weights.length;
  if (extra > 0) {
    const totalWeight = safeWeights.reduce((s, w) => s + w, 0);
    const shares = safeWeights.map((w) => (w / totalWeight) * extra);
    const floors = shares.map((s) => Math.floor(s));
    let leftover = extra - floors.reduce((s, f) => s + f, 0);
    const byRemainderDesc = shares
      .map((s, i) => ({ i, frac: s - Math.floor(s) }))
      .sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < byRemainderDesc.length && leftover > 0; k++) {
      const i = byRemainderDesc[k]!.i;
      floors[i] = floors[i]! + 1;
      leftover -= 1;
    }
    for (let p = 0; p < weights.length; p++) counts[p] += floors[p]!;
  }
  return counts;
};

type FineCue = { start: string; end: string; text: string[] };

/** Word-level timestamp from forced alignment (see forced-align.py). */
export type WordTiming = { word: string; start: number; end: number };

const normalizeForTimingMatch = (word: string): string =>
  word.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/giu, "");

/**
 * Best-effort lookup of real per-word timestamps for one cue's words. Rather
 * than requiring exact index-threading from the source document (which Phase
 * 0's comma-splitting doesn't track), this searches a generous time window
 * around the cue's own [start, end] for a contiguous run of timing entries
 * whose normalized words match the cue's words in order. Returns null (never
 * throws) when no match is found — the caller falls back to proportional
 * timing, so a miss only costs precision, not correctness.
 */
export const findWordTimingsForCue = (
  cueWords: readonly string[],
  cueStart: number,
  cueEnd: number,
  allTimings: readonly WordTiming[],
  slackSeconds = 3,
): WordTiming[] | null => {
  if (cueWords.length === 0) return null;
  const normalizedCueWords = cueWords.map(normalizeForTimingMatch);
  const windowed = allTimings.filter(
    (t) => t.start >= cueStart - slackSeconds && t.end <= cueEnd + slackSeconds,
  );
  for (let start = 0; start + normalizedCueWords.length <= windowed.length; start++) {
    let matches = true;
    for (let i = 0; i < normalizedCueWords.length; i++) {
      if (normalizeForTimingMatch(windowed[start + i]!.word) !== normalizedCueWords[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return windowed.slice(start, start + normalizedCueWords.length);
  }
  return null;
};

/**
 * Splits one fine cue's English text at its clause midpoint into two
 * sub-cues. Uses real word timing for the split point when `wordTimings` is
 * given and a match is found; otherwise falls back to a time-proportional
 * guess based on relative text length. Returns the cue unchanged (as a
 * single-element array) when it has fewer than 2 words and can't be split.
 */
const splitCueInHalf = (cue: FineCue, wordTimings?: readonly WordTiming[]): FineCue[] => {
  const words = normalizeText(cue.text).split(/\s+/u);
  if (words.length < 2) return [cue];

  const splitAt = findClauseSplitIndex(words);
  const beforeText = words.slice(0, splitAt).join(" ");
  const afterText = words.slice(splitAt).join(" ");
  if (beforeText.length === 0 || afterText.length === 0) return [cue];

  const cueStart = timestampToSeconds(cue.start);
  const cueEnd = timestampToSeconds(cue.end);

  const matched = wordTimings !== undefined
    ? findWordTimingsForCue(words, cueStart, cueEnd, wordTimings)
    : null;
  const mid = matched !== null
    ? (matched[splitAt - 1]!.end + matched[splitAt]!.start) / 2
    : cueStart + (cueEnd - cueStart) * (beforeText.length / (beforeText.length + afterText.length));
  const midTs = secondsToTimestamp(mid);

  return [
    { start: cue.start, end: midTs, text: [beforeText] },
    { start: midTs, end: cue.end, text: [afterText] },
  ];
};

/**
 * BaoCut inserts an extra source-side cut when a sentence needs more display
 * slots than it has source cues ("a source split is added only if there are
 * fewer source cues than target groups"). This grows `cues` toward
 * `requiredCount` by repeatedly splitting the longest-duration splittable cue,
 * refusing any split that would leave a half under `MIN_SPLIT_DURATION_S`.
 */
export const ensureEnoughFineCues = (
  cues: readonly FineCue[],
  requiredCount: number,
  wordTimings?: readonly WordTiming[],
): FineCue[] => {
  let result: FineCue[] = [...cues];
  while (result.length < requiredCount) {
    let bestIdx = -1;
    let bestDur = 0;
    for (let i = 0; i < result.length; i++) {
      const words = normalizeText(result[i]!.text).split(/\s+/u);
      if (words.length < 2) continue;
      const dur = timestampToSeconds(result[i]!.end) - timestampToSeconds(result[i]!.start);
      if (dur > bestDur) {
        bestDur = dur;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;

    const halves = splitCueInHalf(result[bestIdx]!, wordTimings);
    if (halves.length < 2) break;

    const d0 = timestampToSeconds(halves[0]!.end) - timestampToSeconds(halves[0]!.start);
    const d1 = timestampToSeconds(halves[1]!.end) - timestampToSeconds(halves[1]!.start);
    if (d0 < MIN_SPLIT_DURATION_S || d1 < MIN_SPLIT_DURATION_S) break;

    result = [...result.slice(0, bestIdx), ...halves, ...result.slice(bestIdx + 1)];
  }
  return result;
};

/**
 * The Phase-1 translation prompt already tells the model to keep glossary
 * terms and names untranslated, but real runs occasionally translate one
 * away anyway (e.g. "Grill with Docs" -> "文档一起过一遍") — an LLM
 * consistency miss, not a prompt-design gap the instruction text can fix by
 * itself. This is a deterministic, mechanical check-and-retry: find which
 * protected terms/names actually appear in the English source but are
 * missing from the translation, and if any are, ask for ONE corrected
 * rewrite naming exactly those terms. Only accepts the rewrite if it
 * actually restored every missing term (never accepts a partial fix or an
 * empty/malformed response) — otherwise keeps the original translation
 * rather than risking a worse, unrelated rewrite.
 */
export const ensureProtectedTermsPreserved = async (
  enText: string,
  zhText: string,
  llm: LlmPort,
  model: string,
  signal?: AbortSignal,
): Promise<string> => {
  const lowerEn = enText.toLocaleLowerCase("en");
  const missing = PROTECTED_TERMS.filter(
    (term) => lowerEn.includes(term.toLocaleLowerCase("en")) && !zhText.includes(term),
  );
  if (missing.length === 0) return zhText;

  try {
    const resp = await llm.chat({
      model,
      messages: [
        {
          role: "system",
          content: [
            "This Simplified Chinese translation is missing some terms that must be",
            "kept in their original English form. Rewrite the translation to",
            "include every listed term exactly as spelled, changing as little else",
            "as possible.",
            `Terms that must appear verbatim: ${missing.join(", ")}`,
            "These are proper nouns (product/brand/tool names) — do NOT translate",
            'them into Chinese (e.g. "Codex" is a product name, not the common noun',
            '"code/statute"; it must stay as the literal Latin-script word "Codex",',
            "never a Chinese word for its meaning). If the current translation",
            "replaced a term with a pronoun or paraphrase (e.g. \"它\"/\"这个\"), put",
            "the literal term back in that same spot instead.",
            "Return ONLY the corrected Chinese text — no explanation, no quotes.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({ englishSource: enText, currentTranslation: zhText }),
        },
      ],
      temperature: 0.1,
      maxTokens: 512,
      ...(signal !== undefined ? { signal } : {}),
    });

    const fixed = resp.content.trim();
    if (fixed.length === 0) return zhText;
    if (missing.some((term) => !fixed.includes(term))) return zhText;
    return fixed;
  } catch {
    return zhText;
  }
};

/**
 * BaoCut's align contract falls back to a "rewrite" (with a reasonCode) only
 * when a deterministic recut genuinely cannot fit the budget — never as the
 * default path. This mirrors that: called only when growing cues still isn't
 * enough, it asks the LLM to rephrase the translation more compactly into
 * exactly `pieceCount` pieces. Any malformed, wrong-count, over-budget, or
 * failed response is treated as "no usable rewrite" (returns null) rather
 * than thrown — the caller already has a deterministic fallback.
 */
export const requestCompactRewrite = async (
  sourceText: string,
  currentTranslation: string,
  pieceCount: number,
  hardLimit: number,
  llm: LlmPort,
  model: string,
  signal?: AbortSignal,
  technicalTermGuard?: TechnicalTermGuard,
): Promise<string[] | null> => {
  try {
    const prepared = technicalTermGuard?.prepare(currentTranslation);
    const resp = await llm.chat({
      model,
      messages: [
        {
          role: "system",
          content: [
            `Rewrite this Simplified Chinese translation into exactly ${pieceCount} pieces so it reads naturally when split across ${pieceCount} subtitle cues, in order.`,
            `Each piece must be at most ${hardLimit} visual cells wide (a CJK character is 1 cell, a Latin letter or digit is 0.5 cells).`,
            "Preserve the full meaning of the source sentence — you may rephrase for brevity, but do not drop content.",
            "Keep any product names, people's names, and technical terms exactly as they appear in the current translation.",
            'Return JSON: {"pieces":["piece 1","piece 2",...]}',
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            source: sourceText,
            currentTranslation: prepared?.value ?? currentTranslation,
            pieceCount,
          }),
        },
      ],
      temperature: 0.1,
      maxTokens: 1024,
      jsonMode: true,
      ...(signal !== undefined ? { signal } : {}),
    });

    const parsed = JSON.parse(resp.content.trim()) as { pieces?: unknown };
    if (!Array.isArray(parsed.pieces) || parsed.pieces.length !== pieceCount) return null;
    if (!parsed.pieces.every((p): p is string => typeof p === "string" && p.trim().length > 0)) {
      return null;
    }
    const pieces = technicalTermGuard === undefined
      ? parsed.pieces
      : (() => {
          const finalized = technicalTermGuard.finalize(
            parsed.pieces,
            prepared?.restoration ?? { placeholders: [] },
          );
          return hasHardTechnicalTermViolations(finalized.violations)
            ? null
            : finalized.value;
        })();
    if (pieces === null) return null;
    if (pieces.some((p) => visualWidth(p) > hardLimit)) return null;
    return pieces;
  } catch {
    return null;
  }
};

/**
 * A translated piece anchored to a contiguous range of the sentence's own
 * source cues: it covers cues `(previous piece's throughCue, throughCue]`
 * (1-based, the first piece starting at cue 1).
 */
export type ContentAlignedPiece = { throughCue: number; zhText: string };

/**
 * Merges a piece that would display too briefly or read too fast into a
 * neighboring piece, instead of leaving a standalone fragment to flash past
 * on its own (e.g. a short "Now," or "然后……" clause whose own source cue
 * only spans a fraction of a second — content-correct alignment doesn't fix
 * this, since the piece is genuinely a distinct clause, not a duplicate of
 * its neighbor). Content from both pieces is combined into one Chinese text
 * — never dropped — and a merge only happens when the combined text still
 * fits `hardLimit`; a piece that can't be merged either direction within
 * budget is left as-is, for the audit layer's cps/flash checks to surface
 * as presentation debt rather than being silently patched over.
 */
export const mergeShortPieces = (
  pieces: readonly ContentAlignedPiece[],
  cues: readonly FineCue[],
  hardLimit: number,
): ContentAlignedPiece[] => {
  const result = pieces.map((p) => ({ ...p }));

  const durationOf = (start: number, end: number): number =>
    timestampToSeconds(cues[end - 1]!.end) - timestampToSeconds(cues[start]!.start);
  const isTooBrief = (index: number): boolean => {
    const start = index === 0 ? 0 : result[index - 1]!.throughCue;
    const duration = durationOf(start, result[index]!.throughCue);
    if (!Number.isFinite(duration) || duration <= 0) return false;
    const characterCount = result[index]!.zhText.replace(/\s/gu, "").length;
    return duration < MIN_SPLIT_DURATION_S || characterCount / duration > MAX_CPS_BEFORE_MERGE;
  };
  const tryMerge = (into: number, from: number): boolean => {
    const combined = into < from
      ? `${result[into]!.zhText}${result[from]!.zhText}`
      : `${result[from]!.zhText}${result[into]!.zhText}`;
    if (visualWidth(combined) > hardLimit) return false;
    result[into] = { throughCue: Math.max(result[into]!.throughCue, result[from]!.throughCue), zhText: combined };
    result.splice(from, 1);
    return true;
  };

  let mergedSomething = true;
  while (mergedSomething && result.length > 1) {
    mergedSomething = false;
    for (let i = 0; i < result.length; i++) {
      if (!isTooBrief(i)) continue;
      if (i < result.length - 1 && tryMerge(i + 1, i)) { mergedSomething = true; break; }
      if (i > 0 && tryMerge(i - 1, i)) { mergedSomething = true; break; }
    }
  }
  return result;
};

type MergeableBlock = {
  start: string;
  end: string;
  zhText: string;
  enText: string;
  /**
   * Which run of Chinese text this block belongs to. Blocks sharing an id
   * carry the *same* sentence copied across several cues (the width budget
   * split the English, not the Chinese); blocks with different ids carry
   * genuinely different content.
   *
   * Text equality cannot stand in for this: `splitLongZh` can hand two
   * adjacent cues character-identical fragments of one longer sentence, and
   * collapsing those would silently drop content. Carried through the
   * transforms by their `{ ...b }` spreads; only `splitWideBlocks` mints new
   * ids, because only it turns one run into several distinct fragments.
   */
  zhSpanId?: number;
};

/**
 * Global counterpart to `mergeShortPieces`, run once over the whole file's
 * finalized display blocks (after every sentence has been translated and
 * timed). `mergeShortPieces` only ever sees one sentence's own cues, so it
 * can't help a short sentence that is its own single brief cue (e.g. "你知道
 * 吗，" landing on a 0.5s original cue with nothing else in that sentence to
 * combine with) or a brief cue sitting right at a sentence boundary. This
 * pass merges any such block into an adjacent one — regardless of which
 * sentence either came from — combining both languages' text, and skips a
 * block whose immediate neighbor already shows identical Chinese (that's an
 * intentional repeat span; combining into it would just duplicate text).
 * A merge that would exceed `hardLimit` is skipped, same as `mergeShortPieces`.
 */
type BriefBlockSpan = { indices: number[]; zhText: string; start: string; end: string };

const buildIdenticalTextSpans = <T extends MergeableBlock>(blocks: readonly T[]): BriefBlockSpan[] => {
  const spans: BriefBlockSpan[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const last = spans[spans.length - 1];
    if (last !== undefined && last.zhText === blocks[i]!.zhText) {
      last.indices.push(i);
      last.end = blocks[i]!.end;
    } else {
      spans.push({ indices: [i], zhText: blocks[i]!.zhText, start: blocks[i]!.start, end: blocks[i]!.end });
    }
  }
  return spans;
};

/**
 * Same brief/fast criterion as `mergeShortPieces`, applied to the whole
 * file's final display blocks (after every sentence has been translated and
 * timed) instead of one sentence's own cues. It has to work in SPANS, not
 * individual blocks: a run of consecutive blocks sharing identical Chinese
 * text (one piece spanning several English sub-cues, or a whole short
 * sentence repeated across its span) is one continuous reading unit, and its
 * true duration is the whole run's combined span — not any single block's
 * own slice, nor the two-piece view `mergeShortPieces` had while it was
 * still confined to one sentence. A run that's STILL too brief even at its
 * full combined duration (e.g. a short lead-in clause on a source cue too
 * short to reach 1s on its own, immediately followed by a long clause that
 * already has nowhere to grow within the width budget) needs to merge with
 * an ADJACENT span — including one from a different sentence — which
 * `mergeShortPieces` can never do, since it only ever sees one sentence's
 * own cues.
 *
 * Merging two spans applies the combined text to EVERY block in BOTH spans,
 * not just an edge block — this keeps the "one static Chinese caption over
 * several distinct English sub-cues" shape the merge is trying to produce,
 * rather than making only one block in the run disagree with its neighbors.
 * A merge that would exceed `hardLimit` is skipped, same as `mergeShortPieces`.
 */
export const mergeBriefBlocks = <T extends MergeableBlock>(
  blocks: readonly T[],
  hardLimit: number,
): T[] => {
  const result = blocks.map((b) => ({ ...b }));

  let mergedSomething = true;
  while (mergedSomething && result.length > 1) {
    mergedSomething = false;
    const spans = buildIdenticalTextSpans(result);

    for (let s = 0; s < spans.length; s++) {
      const span = spans[s]!;
      const duration = timestampToSeconds(span.end) - timestampToSeconds(span.start);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      const characterCount = span.zhText.replace(/\s/gu, "").length;
      const tooBrief = duration < MIN_SPLIT_DURATION_S || characterCount / duration > MAX_CPS_BEFORE_MERGE;
      if (!tooBrief) continue;

      const mergeWith = (target: BriefBlockSpan, targetComesFirst: boolean): boolean => {
        const combined = targetComesFirst
          ? `${target.zhText}${span.zhText}`
          : `${span.zhText}${target.zhText}`;
        if (visualWidth(combined) > hardLimit) return false;
        for (const idx of [...span.indices, ...target.indices]) {
          result[idx] = { ...result[idx]!, zhText: combined };
        }
        return true;
      };

      if (s < spans.length - 1 && mergeWith(spans[s + 1]!, false)) { mergedSomething = true; break; }
      if (s > 0 && mergeWith(spans[s - 1]!, true)) { mergedSomething = true; break; }
    }
  }
  return result;
};

/**
 * The width counterpart to `mergeBriefBlocks`, and the invariant backstop for
 * the whole projection: no delivered block may exceed `hardLimit`.
 *
 * Span-based for the same reason its siblings are — a run of consecutive
 * blocks sharing identical Chinese text is one display unit, and the over-width
 * text has to be redistributed across the run's own cues rather than patched
 * in one of them. Deterministic and LLM-free, which is what lets `repair` fix
 * an already-delivered artifact without paying to re-translate it.
 *
 * This exists because a content-aligned split that came back as ONE piece
 * covering a whole sentence produced exactly this shape: five cues all showing
 * the same 44-cell line. `requestContentAlignedSplit` now re-splits such a
 * piece at the source, where it still knows each piece's own cue range; this
 * pass is the file-wide net for anything that reaches the end over budget
 * anyway, including artifacts written before that fix existed.
 *
 * A run with fewer cues than the split needs is left intact — there is no
 * display slot to put the extra piece in, and dropping content to satisfy a
 * width budget would be strictly worse. The audit's `width-budget` finding
 * discloses whatever survives.
 */
export const splitWideBlocks = <T extends MergeableBlock>(
  blocks: readonly T[],
  hardLimit: number,
  technicalTermGuard?: TechnicalTermGuard,
): T[] => {
  const result = blocks.map((b) => ({ ...b }));
  // Each part carved out below is distinct content, even when two of them
  // read identically (a run of repeated characters splits that way). Give
  // every part its own id so the mono-Chinese artifact can tell "copied
  // across cues" from "different fragment that happens to match".
  let nextSpanId = 1 + result.reduce((max, b) => Math.max(max, b.zhSpanId ?? 0), 0);

  for (const span of buildIdenticalTextSpans(result)) {
    const width = visualWidth(span.zhText);
    if (width <= hardLimit) continue;

    const parts = enforceHardCeiling(
      splitLongZh(span.zhText, Math.ceil(width / TARGET_CJK), technicalTermGuard),
      hardLimit,
      technicalTermGuard,
    );
    if (parts.length < 2 || span.indices.length < parts.length) continue;

    const counts = allocateCuesByWeight(parts.map((part) => visualWidth(part)), span.indices.length);
    let cursor = 0;
    for (let p = 0; p < parts.length; p++) {
      const partSpanId = nextSpanId++;
      for (let c = 0; c < counts[p]!; c++) {
        const index = span.indices[cursor]!;
        result[index] = { ...result[index]!, zhText: parts[p]!, zhSpanId: partSpanId };
        cursor++;
      }
    }
  }
  return result;
};

/**
 * Runs after `mergeBriefBlocks`, for whatever still reads too fast once
 * merging alone can't help (merging is capped by `hardLimit`, so two already
 * over-dense neighbors can max out the display width without ever reaching a
 * safe reading speed). Unlike merging, this changes wording: it asks for one
 * compact rewrite of just that block's Chinese text, targeted at the
 * character budget its own display duration actually allows. A block that's
 * part of an identical-text repeat run is skipped — its real reading time is
 * the whole run's combined duration (already correctly under budget, or a
 * decision `mergeShortPieces` already made upstream), not this one slice.
 * Only accepts the rewrite if it's a genuine improvement (never worse than
 * the original); otherwise keeps the original wording, leaving the audit's
 * cps check to disclose it as presentation debt rather than silently patching
 * over a rewrite that didn't actually help.
 */
/**
 * Reading-speed compaction, kept separate from `requestCompactRewrite` because
 * the two answer different questions (does this fit one display line, vs. can
 * a viewer read it in the time it is on screen) — but both budget in
 * `visualWidth`, and that shared unit matters.
 *
 * This function once budgeted in raw characters to match the audit's own cps
 * count. That made every cps finding on a term-carrying cue unsatisfiable: raw
 * counting treats "Air Coding Cohort" as 15 Chinese characters, so it could
 * eat a whole 2-second cue's budget on its own, while the only text the model
 * is allowed to shorten is the Chinese around it — the term itself must stay
 * verbatim (see the protected-term rejection in `compactDenseBlocks`). The
 * audit now measures cps in visual width too, so a finding raised there is
 * always reachable from here.
 */
const requestCpsCompactRewrite = async (
  sourceText: string,
  currentTranslation: string,
  targetWidth: number,
  llm: LlmPort,
  model: string,
  signal?: AbortSignal,
): Promise<string | null> => {
  try {
    const resp = await llm.chat({
      model,
      messages: [
        {
          role: "system",
          content: [
            "This Simplified Chinese subtitle line reads faster than a viewer can",
            `comfortably follow. Rewrite it to a width of at most ${targetWidth},`,
            "counting each Chinese character as 1 and each Latin letter or digit",
            "as 0.5, so it reads at a normal pace.",
            "Preserve the full meaning — use shorter synonyms and drop redundant",
            "words, but do not drop information the source conveys.",
            "Keep any product names, people's names, and technical terms exactly",
            "as they appear in the current translation; shorten the Chinese around",
            "them instead.",
            'Return JSON: {"text":"..."}',
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({ source: sourceText, currentTranslation, targetWidth }),
        },
      ],
      temperature: 0.1,
      maxTokens: 512,
      jsonMode: true,
      ...(signal !== undefined ? { signal } : {}),
    });

    const parsed = JSON.parse(resp.content.trim()) as { text?: unknown };
    if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) return null;
    return parsed.text.trim();
  } catch {
    return null;
  }
};

export const compactDenseBlocks = async <T extends MergeableBlock>(
  blocks: readonly T[],
  llm: LlmPort,
  model: string,
  signal?: AbortSignal,
  technicalTermGuard?: TechnicalTermGuard,
  finalizeText?: SemanticTextFinalizer,
): Promise<T[]> => {
  const result = blocks.map((b) => ({ ...b }));
  // Span-based for the same reason mergeBriefBlocks is: a run of consecutive
  // blocks sharing identical Chinese text is one continuous reading unit, so
  // its true cps is measured over the whole run's combined duration — and if
  // that's still too fast, the rewrite has to apply to every block in the
  // run, not just one (a single differing block would break the repeat
  // pattern this is supposed to preserve).
  for (const span of buildIdenticalTextSpans(result)) {
    const duration = timestampToSeconds(span.end) - timestampToSeconds(span.start);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const currentWidth = visualWidth(span.zhText);
    if (currentWidth / duration <= MAX_CPS_BEFORE_MERGE) continue;

    const targetWidth = Math.max(1, Math.floor(duration * MAX_CPS_BEFORE_MERGE));
    const sourceText = span.indices.map((idx) => result[idx]!.enText).join(" ");
    const compact = await requestCpsCompactRewrite(
      sourceText,
      span.zhText,
      targetWidth,
      llm,
      model,
      signal,
    );
    if (compact === null) continue;
    const sourceScopedGuard = technicalTermGuard === undefined
      ? undefined
      : scopeTechnicalTermGuard(technicalTermGuard, sourceText);
    const prepared = sourceScopedGuard?.prepare(span.zhText);
    let acceptedCompact = sourceScopedGuard === undefined
      ? compact
      : sourceScopedGuard.finalize(compact, prepared?.restoration ?? { placeholders: [] }).value;
    if (finalizeText !== undefined) {
      const repaired = await finalizeText(sourceText, acceptedCompact);
      if (repaired === null) continue;
      acceptedCompact = repaired;
    }
    // A compaction that drops a protected term the current text already has
    // is worse than the cps violation it was trying to fix — content
    // correctness outranks reading speed (matches the audit's own
    // content-vs-presentation severity split). requestCpsCompactRewrite's
    // own prompt asks it not to do this, but real runs occasionally do
    // anyway; reject rather than accept a shorter but term-violating rewrite.
    const requiredTerms = sourceScopedGuard?.profile.entries
      .filter((term) => span.zhText.includes(term.canonical))
      .map((term) => term.canonical) ?? PROTECTED_TERMS.filter((term) => span.zhText.includes(term));
    if (requiredTerms.some((term) => !acceptedCompact.includes(term))) continue;
    if (visualWidth(acceptedCompact) < currentWidth) {
      for (const idx of span.indices) {
        result[idx] = { ...result[idx]!, zhText: acceptedCompact };
      }
    }
  }
  return result;
};

/**
 * Fixes a "flash" finding (a reading span visible for under
 * `MIN_SPLIT_DURATION_S`) by borrowing display time from its timeline
 * neighbors — never touching text, translation, or cue count. Two-tier:
 * first reclaim any dead gap between cues (free — costs nothing), then, if
 * still short, borrow from whichever neighbor span has more slack, capped
 * so the donor's own duration never itself drops below the threshold. A
 * span this can't fully fix (both neighbors already tight, e.g. at the very
 * start/end of the file) is left partially improved — the audit's own
 * re-check is what tells the caller whether it's now clean.
 *
 * Span-aware for the same reason `compactDenseBlocks` is: a run of
 * consecutive blocks sharing identical Chinese text is one continuous
 * reading unit, so only its two outer edges (against a genuinely different
 * neighbor) are adjustable — the internal cue boundaries within the span
 * stay untouched.
 */
export const fixFlashCues = <T extends MergeableBlock>(blocks: readonly T[]): T[] => {
  const spans = buildIdenticalTextSpans(blocks);
  const times = spans.map((s) => ({
    start: timestampToSeconds(s.start),
    end: timestampToSeconds(s.end),
  }));

  for (let i = 0; i < spans.length; i++) {
    let needed = MIN_SPLIT_DURATION_S - (times[i]!.end - times[i]!.start);
    if (needed <= 0) continue;

    const prevGap = i > 0 ? times[i]!.start - times[i - 1]!.end : 0;
    const fromGapBefore = Math.min(Math.max(prevGap, 0), needed);
    times[i]!.start -= fromGapBefore;
    needed -= fromGapBefore;

    if (needed > 0 && i < spans.length - 1) {
      const nextGap = times[i + 1]!.start - times[i]!.end;
      const fromGapAfter = Math.min(Math.max(nextGap, 0), needed);
      times[i]!.end += fromGapAfter;
      needed -= fromGapAfter;
    }

    while (needed > 1e-6) {
      const prevSlack = i > 0 ? Math.max(0, times[i - 1]!.end - times[i - 1]!.start - MIN_SPLIT_DURATION_S) : 0;
      const nextSlack =
        i < spans.length - 1 ? Math.max(0, times[i + 1]!.end - times[i + 1]!.start - MIN_SPLIT_DURATION_S) : 0;
      if (prevSlack <= 1e-6 && nextSlack <= 1e-6) break; // neither neighbor can lend more
      if (prevSlack >= nextSlack) {
        const take = Math.min(prevSlack, needed);
        times[i - 1]!.end -= take;
        times[i]!.start -= take;
        needed -= take;
      } else {
        const take = Math.min(nextSlack, needed);
        times[i + 1]!.start += take;
        times[i]!.end += take;
        needed -= take;
      }
    }
  }

  const result = blocks.map((b) => ({ ...b }));
  spans.forEach((span, i) => {
    const first = span.indices[0]!;
    const last = span.indices[span.indices.length - 1]!;
    result[first] = { ...result[first]!, start: secondsToTimestamp(times[i]!.start) };
    result[last] = { ...result[last]!, end: secondsToTimestamp(times[i]!.end) };
  });
  return result;
};

const repairMissingTermsInBlocks = async <T extends MergeableBlock>(
  blocks: readonly T[],
  llm: LlmPort,
  model: string,
  signal?: AbortSignal,
  technicalTermGuard?: TechnicalTermGuard,
  repairState: { used: boolean } = { used: false },
): Promise<T[]> => {
  const result = blocks.map((b) => ({ ...b }));
  for (const span of buildIdenticalTextSpans(result)) {
    const enText = span.indices.map((idx) => result[idx]!.enText).join(" ");
    const fixed = technicalTermGuard === undefined
      ? await ensureProtectedTermsPreserved(enText, span.zhText, llm, model, signal)
      : await finalizeSemanticText({
          sourceText: enText,
          candidate: span.zhText,
          guard: technicalTermGuard,
          restoration: scopeTechnicalTermGuard(technicalTermGuard, enText).prepare(enText).restoration,
          llm,
          model,
          ...(signal === undefined ? {} : { signal }),
          repairState,
        }) ?? span.zhText;
    if (fixed !== span.zhText) {
      for (const idx of span.indices) {
        result[idx] = { ...result[idx]!, zhText: fixed };
      }
    }
  }
  return result;
};

export type SubtitleRepairResult = {
  enSrt: string;
  zhSrt: string;
  bilingualSrt: string;
  changed: boolean;
};

/**
 * Targeted repair over already-generated, already-delivered subtitle
 * artifacts — no re-translation, no re-running the full pipeline. Operates
 * directly on the on-disk SRT content (the same "only trust the artifact"
 * boundary the audit layer uses), so it works regardless of which internal
 * path (content-aligned split, weight-based fallback, short-sentence repeat)
 * produced a given cue.
 *
 * Two passes, both bounded to ONE attempt per span (never retried, matching
 * BaoCut's "one targeted repair, then report" policy — this is meant to be
 * run once after an audit, not looped until clean):
 *   1. `ensureProtectedTermsPreserved` per identical-text span, for a
 *      protected term the translation dropped.
 *   2. `compactDenseBlocks`, for a span still reading too fast.
 * Deliberately does NOT re-run `mergeBriefBlocks` — merging changes the cue
 * count/structure, which is a bigger change than "repair" should make to an
 * artifact a human may already be reviewing; a brief/flash finding that
 * merging alone could fix is left for a human decision instead of being
 * silently restructured.
 *
 * A span a pass can't improve is left as-is — the caller's own before/after
 * audit is what tells a human which findings still need attention.
 */
export const repairSubtitleArtifacts = async (input: {
  enSrt: string;
  zhSrt: string;
  bilingualSrt: string;
  llm: LlmPort;
  model: string;
  signal?: AbortSignal;
  technicalTermGuard?: TechnicalTermGuard;
}): Promise<SubtitleRepairResult> => {
  const enCues = parseSubtitleBlocks(input.enSrt);
  const zhCues = parseSubtitleBlocks(input.zhSrt);
  if (enCues.length !== zhCues.length) {
    return { enSrt: input.enSrt, zhSrt: input.zhSrt, bilingualSrt: input.bilingualSrt, changed: false };
  }

  const original = enCues.map((en, i) => ({
    start: en.start,
    end: en.end,
    enText: en.text.join(" "),
    zhText: zhCues[i]!.text.join(" "),
  }));

  const repairState = { used: false };
  let blocks = await repairMissingTermsInBlocks(
    original,
    input.llm,
    input.model,
    input.signal,
    input.technicalTermGuard,
    repairState,
  );
  // Before the reading-speed pass: splitting a wide run shortens each cue's
  // text without changing the run's total duration, so cps is measured on
  // what will actually be displayed. Deterministic, so it costs no tokens.
  blocks = splitWideBlocks(blocks, HARD_CJK, input.technicalTermGuard);
  const finalizeText: SemanticTextFinalizer | undefined = input.technicalTermGuard === undefined
    ? undefined
    : async (sourceText, candidate) => {
        const scoped = scopeTechnicalTermGuard(input.technicalTermGuard!, sourceText);
        return finalizeSemanticText({
          sourceText,
          candidate,
          guard: input.technicalTermGuard!,
          restoration: scoped.prepare(sourceText).restoration,
          llm: input.llm,
          model: input.model,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          repairState,
        });
      };
  blocks = await compactDenseBlocks(
    blocks,
    input.llm,
    input.model,
    input.signal,
    input.technicalTermGuard,
    finalizeText,
  );
  blocks = fixFlashCues(blocks);

  const changed = blocks.some(
    (b, i) => b.zhText !== original[i]!.zhText || b.start !== original[i]!.start || b.end !== original[i]!.end,
  );
  if (!changed) {
    return { enSrt: input.enSrt, zhSrt: input.zhSrt, bilingualSrt: input.bilingualSrt, changed: false };
  }

  // fixFlashCues can move a cue's start/end, which the en/zh/bilingual
  // artifacts share identically per index — all three must be regenerated
  // from `blocks` together, not just the ones whose text happened to change,
  // or the timing goes out of sync between files.
  const enSrt = serializeSrtBlocks(
    blocks.map((b, i) => ({ index: i + 1, start: b.start, end: b.end, text: [b.enText] })),
  );
  const zhSrt = serializeSrtBlocks(
    blocks.map((b, i) => ({ index: i + 1, start: b.start, end: b.end, text: [b.zhText] })),
  );
  const bilingualSrt = serializeSrtBlocks(
    blocks.map((b, i) => ({ index: i + 1, start: b.start, end: b.end, text: [b.zhText, b.enText] })),
  );

  return { enSrt, zhSrt, bilingualSrt, changed: true };
};

/**
 * Splits a long sentence's Chinese translation into pieces anchored to the
 * actual English cues each piece covers, instead of guessing cue counts from
 * character-weight ratios (see `allocateCuesByWeight`). The weight-based
 * split has no idea which source cue a piece's content came from, so a term
 * or clause can land on the wrong side of a cue boundary whenever the weight
 * ratio doesn't match where it's actually spoken — a real DeepSeek run
 * showed "Discord"/"PRD"/"Grill with Docs" consistently appear in the
 * Chinese one cue before the English cue that actually says them.
 *
 * The LLM is given the sentence's already-translated Chinese text plus its
 * numbered source cues, and returns each piece's `throughCue`: the last cue
 * (1-based) that piece's text covers. Pieces must cover every cue from 1 to
 * `cues.length` exactly once, in order, with no gaps. Returns null (never
 * throws) on any malformed, out-of-order, non-covering, over-budget, or
 * content-drifted response — the caller falls back to the weight-based
 * split, so a miss only costs alignment precision, not correctness.
 */
export const requestContentAlignedSplit = async (
  cues: readonly FineCue[],
  zhFull: string,
  hardLimit: number,
  llm: LlmPort,
  model: string,
  signal?: AbortSignal,
  technicalTermGuard?: TechnicalTermGuard,
  finalizeText?: SemanticTextFinalizer,
): Promise<ContentAlignedPiece[] | null> => {
  if (cues.length === 0) return null;
  try {
    const prepared = technicalTermGuard?.prepare(zhFull);
    const resp = await llm.chat({
      model,
      messages: [
        {
          role: "system",
          content: [
            "You already translated an English sentence into the Simplified Chinese",
            "text given below. Split that Chinese translation into pieces so each",
            "piece can be shown as a subtitle caption directly above the specific",
            "numbered English cues it translates — never above a cue whose content",
            "it doesn't cover, and never omitting a cue whose content it does cover.",
            "",
            "Assign each piece a 'throughCue': the number of the LAST cue (from the",
            "numbered list below) that piece's Chinese text covers. The first piece",
            "implicitly starts at cue 1; each next piece starts right after the",
            "previous piece's throughCue. The final piece's throughCue must equal",
            "the highest cue number — every cue must belong to exactly one piece,",
            "in order, with no gaps.",
            "Prefer to just split the given Chinese translation as-is, preserving its",
            "wording — a separate pass will shorten any piece that turns out too wide",
            "to display, so don't worry about length here.",
            "",
            "IMPORTANT: some Chinese words are kept in their original English form",
            "(names, product names, technical terms). If a piece's Chinese text",
            "contains such an English word, that piece's cue range MUST include the",
            "specific numbered cue whose English text actually says that word — even",
            "if a different cut point would otherwise read more naturally in Chinese.",
            "Prefer a boundary that keeps the term with its cue over one that doesn't.",
            'Return JSON: {"pieces":[{"throughCue":2,"text":"..."},{"throughCue":5,"text":"..."}]}',
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            zhTranslation: prepared?.value ?? zhFull,
            cues: cues.map((c, i) => ({ idx: i + 1, text: normalizeText(c.text) })),
          }),
        },
      ],
      temperature: 0.1,
      maxTokens: 1024,
      jsonMode: true,
      ...(signal !== undefined ? { signal } : {}),
    });

    const parsed = JSON.parse(resp.content.trim()) as {
      pieces?: { throughCue?: unknown; text?: unknown }[];
    };
    if (!Array.isArray(parsed.pieces) || parsed.pieces.length === 0) return null;

    // Structural validation only here — NOT width. A piece kept intentionally
    // wide to keep a protected term with its cue (see the prompt above) is a
    // presentation concern for the width-compaction pass below, not a reason
    // to discard an otherwise-correct content alignment.
    const rawPieces: ContentAlignedPiece[] = [];
    let prevThrough = 0;
    for (const piece of parsed.pieces) {
      const throughCue = piece.throughCue;
      const text = piece.text;
      if (typeof throughCue !== "number" || !Number.isInteger(throughCue)) return null;
      if (typeof text !== "string" || text.trim().length === 0) return null;
      if (throughCue <= prevThrough || throughCue > cues.length) return null;
      rawPieces.push({ throughCue, zhText: text.trim() });
      prevThrough = throughCue;
    }
    if (prevThrough !== cues.length) return null; // must cover every cue, exactly once

    if (technicalTermGuard !== undefined) {
      const finalized = technicalTermGuard.finalize(
        rawPieces,
        prepared?.restoration ?? { placeholders: [] },
      );
      if (hasHardTechnicalTermViolations(finalized.violations)) return null;
      for (let index = 0; index < rawPieces.length; index += 1) {
        rawPieces[index] = {
          ...rawPieces[index]!,
          zhText: finalized.value[index]!.zhText,
        };
      }
    } else if (finalizeText !== undefined) {
      const repaired = await finalizeText(
        cues.map((cue) => normalizeText(cue.text)).join(" "),
        rawPieces.map((piece) => piece.zhText).join(""),
      );
      if (repaired === null) return null;
    }

    // Guard against gross content drift (dropped or invented text) rather
    // than a genuine split: the reconstructed pieces should be comparable in
    // length to the translation they were split from.
    const reconstructedLen = rawPieces.reduce((s, p) => s + p.zhText.length, 0);
    const zhLen = zhFull.length;
    if (zhLen > 0 && (reconstructedLen < zhLen * 0.6 || reconstructedLen > zhLen * 1.5)) {
      return null;
    }

    // Width-compaction pass: a piece that must keep a term with its cue can
    // legitimately come back over budget (e.g. two protected terms sharing
    // one clause). Ask for a compact rewrite of just that piece, grounded in
    // its own cue range's source text.
    //
    // If compaction fails or still doesn't fit, split the piece
    // deterministically across the cues it already owns rather than keeping
    // the over-width wording. Nothing downstream would have fixed it: the
    // merge passes only ever combine (and are themselves capped by
    // `hardLimit`), `compactDenseBlocks` only looks at reading speed — a wide
    // line spread over a long span reads slowly and is skipped — and the
    // audit's measurement-based `hard-layout` check has no measurements at
    // the SRT stage. A real DeepSeek run returned ONE piece covering a whole
    // five-cue sentence, and all five cues shipped the same 44-cell line
    // enumerating nine code smells, which compaction cannot shorten.
    //
    // The re-split costs content alignment WITHIN this one piece (sub-pieces
    // are spread by weight, so a term can drift off its own cue again), which
    // is why it is a fallback and not the primary path. It only ever applies
    // to a piece that was already unusable, where every cue in the span was
    // showing the same over-width text and alignment was moot anyway.
    const pieces: ContentAlignedPiece[] = [];
    let cueCursor = 0;
    for (const raw of rawPieces) {
      if (visualWidth(raw.zhText) <= hardLimit) {
        pieces.push(raw);
        cueCursor = raw.throughCue;
        continue;
      }
      const pieceSourceText = cues
        .slice(cueCursor, raw.throughCue)
        .map((c) => normalizeText(c.text))
        .join(" ");
      const compact = await requestCompactRewrite(
        pieceSourceText,
        raw.zhText,
        1,
        hardLimit,
        llm,
        model,
        signal,
      );
      const rewritten = compact !== null && compact.length === 1 ? compact[0]! : raw.zhText;
      if (visualWidth(rewritten) <= hardLimit) {
        pieces.push({ throughCue: raw.throughCue, zhText: rewritten });
        cueCursor = raw.throughCue;
        continue;
      }

      const span = raw.throughCue - cueCursor;
      const subParts = enforceHardCeiling(
        splitLongZh(rewritten, Math.ceil(visualWidth(rewritten) / TARGET_CJK), technicalTermGuard),
        hardLimit,
        technicalTermGuard,
      );
      if (subParts.length > 1 && span >= subParts.length) {
        // `allocateCuesByWeight` sums to exactly `span`, so the last
        // sub-piece still lands on `raw.throughCue` and coverage is intact.
        const counts = allocateCuesByWeight(subParts.map((part) => visualWidth(part)), span);
        let through = cueCursor;
        for (let p = 0; p < subParts.length; p++) {
          through += counts[p]!;
          pieces.push({ throughCue: through, zhText: subParts[p]! });
        }
      } else {
        // Genuinely nowhere to go: a single unbreakable token, or fewer cues
        // in this piece's span than the split needs. Keep the content and let
        // the audit's width check report it as presentation debt.
        pieces.push({ throughCue: raw.throughCue, zhText: rewritten });
      }
      cueCursor = raw.throughCue;
    }

    return pieces;
  } catch {
    return null;
  }
};

/**
 * Collapses each run of blocks that carry one copied Chinese sentence into a
 * single cue spanning the whole run.
 *
 * The width budget splits one English sentence across several cues, and each
 * of those carries the *entire* Chinese sentence — on screen that reads
 * correctly (the Chinese holds still while the English advances), so the
 * bilingual and English artifacts keep the per-cue form. But the mono-Chinese
 * artifact is consumed as standalone text, and there the repeat is a stutter:
 * dubbing synthesised the same sentence several times over (issue #109).
 *
 * Keyed on `zhSpanId`, never on the text. Two adjacent cues can hold
 * character-identical fragments of one longer sentence — a run of repeated
 * characters splits exactly that way — and merging those would drop content.
 * Blocks without an id are left alone, so a caller assembling blocks by hand
 * gets no surprise collapsing.
 *
 * Applied at serialization of the mono artifact only, never to `finalBlocks`
 * itself: `repairSubtitleArtifacts` (the `yt2x subtitle` repair pass) bails
 * out silently when the en and zh cue counts disagree, so collapsing upstream
 * would turn that command into a no-op without reporting anything.
 */
const mergeAdjacentDuplicateZh = <T extends MergeableBlock>(
  blocks: readonly T[],
): { start: string; end: string; zhText: string }[] => {
  const merged: { start: string; end: string; zhText: string }[] = [];
  let previousSpanId: number | undefined;
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && block.zhSpanId !== undefined && block.zhSpanId === previousSpanId) {
      // Extend rather than replace: the run's span is [first.start, last.end].
      previous.end = block.end;
      continue;
    }
    merged.push({ start: block.start, end: block.end, zhText: block.zhText });
    previousSpanId = block.zhSpanId;
  }
  return merged;
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
  const fullSourceText = cues.map((cue) => normalizeText(cue.text)).join(" ");
  const technicalTermGuard = opts.technicalTermGuard ?? createTechnicalTermGuard({
    sourceText: fullSourceText,
  });
  const repairState = { used: false };
  const finalizeText: SemanticTextFinalizer = async (sourceText, candidate) => {
    const scopedGuard = scopeTechnicalTermGuard(technicalTermGuard, sourceText);
    const prepared = scopedGuard.prepare(sourceText);
    return finalizeSemanticText({
      sourceText,
      candidate,
      guard: technicalTermGuard,
      restoration: prepared.restoration,
      llm: opts.llm,
      model: opts.model,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      repairState,
    });
  };

  // YouTube captions may have unsorted/overlapping timestamps. Fix before processing.
  const sortedCues = [...cues].sort(
    (a, b) => timestampToSeconds(a.start) - timestampToSeconds(b.start),
  );
  for (let i = 1; i < sortedCues.length; i++) {
    const prevEnd = timestampToSeconds(sortedCues[i - 1]!.end);
    const curStart = timestampToSeconds(sortedCues[i]!.start);
    if (curStart < prevEnd) {
      sortedCues[i - 1] = { ...sortedCues[i - 1]!, end: secondsToTimestamp(curStart) };
      sortedCues[i] = { ...sortedCues[i]!, start: secondsToTimestamp(prevEnd + 0.001) };
    }
  }

  // ── Phase 0a: Insert commas at natural boundaries (LLM choice, not rewrite) ──
  const punctuatedCues = await insertCommas(sortedCues, opts.llm, opts.model, opts.signal);

  // ── Phase 0b: Split at commas (deterministic) ──
  const splitSegments = splitCuesAtCommas(sortedCues, punctuatedCues, opts.wordTimings);

  const fineCues = splitSegments.map((seg, idx) => ({
    index: idx + 1,
    start: seg.start,
    end: seg.end,
    text: [seg.text],
  }));
  const finePunctuated = splitSegments.map((seg) => seg.text);

  // ── Phase 1: Translate full sentences, repeat Chinese across cues ──
  // Each sentence is translated once.  Within a sentence, all cues show
  // the same Chinese text.  When the sentence changes, the Chinese changes.
  // No alignment, no flashing — simplicity over cleverness.
  const sentenceCues: { cues: typeof fineCues; enText: string }[] = [];
  let start = 0;
  let currentText = "";
  for (let i = 0; i < fineCues.length; i++) {
    const text = finePunctuated[i]!;
    currentText += (currentText ? " " : "") + text;
    if (/[.!?]$/.test(text) || i === fineCues.length - 1) {
      sentenceCues.push({
        cues: fineCues.slice(start, i + 1),
        enText: currentText,
      });
      start = i + 1;
      currentText = "";
    }
  }

  const TRANSLATION_CONCURRENCY = 8;

  const sentenceTranslations = await parallelMap(
    sentenceCues,
    TRANSLATION_CONCURRENCY,
    async (sentence) => {
      const sentenceGuard = scopeTechnicalTermGuard(technicalTermGuard, sentence.enText);
      const prepared = sentenceGuard.prepare(sentence.enText);
      const resp = await opts.llm.chat({
        model: opts.model,
        messages: [
          {
            role: "system",
            content:
              "Translate this English sentence to natural Simplified Chinese. " +
              "Return ONLY the Chinese text — no explanation.\n\n" +
              `${prepared.promptRule}\n` +
              "Use conversational Chinese. Use 你 for 'you'. ≤30 Chinese characters.",
          },
          { role: "user", content: sentence.enText },
        ],
        temperature: 0.1,
        maxTokens: 512,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      const finalized = await finalizeSemanticText({
        sourceText: sentence.enText,
        candidate: resp.content.trim(),
        guard: technicalTermGuard,
        restoration: prepared.restoration,
        llm: opts.llm,
        model: opts.model,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        repairState,
      });
      return finalized ?? resp.content.trim();
    },
  );

  // Spread each sentence's translation across its cues.
  // For long sentences (>30 CJK chars), split at natural boundaries.
  const translatedBlocks: {
    index: number;
    start: string;
    end: string;
    zhText: string;
    enText: string;
    zhSpanId: number;
  }[] = [];
  let nextZhSpanId = 1;

  for (let s = 0; s < sentenceCues.length; s++) {
    const zhFull = sentenceTranslations[s]!;
    const cues = sentenceCues[s]!.cues;
    const zhWeight = visualWidth(zhFull);

    if (zhWeight <= FIT_CJK) {
      // Short sentence: show full Chinese on every cue. One id for the whole
      // sentence — these cues are copies, not separate content.
      const zhSpanId = nextZhSpanId++;
      for (const cue of cues) {
        translatedBlocks.push({
          index: translatedBlocks.length + 1,
          start: cue.start,
          end: cue.end,
          zhText: zhFull,
          enText: normalizeText(cue.text),
          zhSpanId,
        });
      }
    } else {
      // Long sentence: grow the source cues to roughly the display-slot
      // count the translation needs, then ask the LLM to split the
      // translation into pieces anchored to a contiguous range of THOSE
      // cues — so a piece can never claim (or omit) content that a
      // neighboring cue actually contains. Falls back to the old
      // weight-proportional split when the aligned call is unavailable or
      // fails validation.
      const targetPieceCount = Math.max(1, Math.ceil(zhWeight / TARGET_CJK));
      const workingCues = cues.length >= targetPieceCount
        ? cues
        : ensureEnoughFineCues(cues, targetPieceCount, opts.wordTimings);

      const aligned = await requestContentAlignedSplit(
        workingCues,
        zhFull,
        HARD_CJK,
        opts.llm,
        opts.model,
        opts.signal,
        technicalTermGuard,
        finalizeText,
      );

      let parts: string[];
      let cueCounts: number[];

      if (aligned !== null) {
        parts = aligned.map((piece) => piece.zhText);
        cueCounts = [];
        let prevThrough = 0;
        for (const piece of aligned) {
          cueCounts.push(piece.throughCue - prevThrough);
          prevThrough = piece.throughCue;
        }
      } else {
        // Content-aligned split unavailable — fall back to the
        // weight-proportional path.
        parts = enforceHardCeiling(
          splitLongZh(zhFull, targetPieceCount, technicalTermGuard),
          HARD_CJK,
          technicalTermGuard,
        );
        if (workingCues.length < parts.length) {
          // Couldn't grow enough cues for the ideal split — re-target the
          // split to the cue count actually available, still hard-ceiling
          // checked (a naive tail-merge here could recreate an oversized part).
          parts = enforceHardCeiling(
            splitLongZh(zhFull, workingCues.length, technicalTermGuard),
            HARD_CJK,
            technicalTermGuard,
          );
          if (parts.length > workingCues.length) {
            // Even a deterministic recut can't fit the cues actually
            // available — ask the LLM for a more compact rephrasing (BaoCut's
            // "rewrite" action), and only merge the excess as a last resort if
            // that fails too.
            const rewritten = await requestCompactRewrite(
              sentenceCues[s]!.enText,
              zhFull,
              workingCues.length,
              HARD_CJK,
              opts.llm,
              opts.model,
              opts.signal,
              technicalTermGuard,
            );
            if (rewritten !== null) {
              parts = rewritten;
            } else {
              const keep = parts.slice(0, workingCues.length - 1);
              const mergedTail = parts.slice(workingCues.length - 1).join("");
              parts = [...keep, mergedTail];
            }
          }
        }
        cueCounts = allocateCuesByWeight(parts.map((p) => visualWidth(p)), workingCues.length);
      }

      let throughCue = 0;
      const piecesForMerge: ContentAlignedPiece[] = parts.map((zhText, p) => {
        throughCue += cueCounts[p]!;
        return { throughCue, zhText };
      });
      const mergedPieces = mergeShortPieces(piecesForMerge, workingCues, HARD_CJK);

      let cueCursor = 0;
      for (const piece of mergedPieces) {
        // One id per piece: every cue in this run shows the same Chinese, so
        // the mono artifact states it once (see mergeAdjacentDuplicateZh).
        const zhSpanId = nextZhSpanId++;
        for (let c = cueCursor; c < piece.throughCue; c++) {
          translatedBlocks.push({
            index: translatedBlocks.length + 1,
            start: workingCues[c]!.start,
            end: workingCues[c]!.end,
            zhText: piece.zhText,
            enText: normalizeText(workingCues[c]!.text),
            zhSpanId,
          });
        }
        cueCursor = piece.throughCue;
      }
    }
  }

  // Final time fix: sort and clip overlaps. Keep short blocks intact so the
  // artifact audit can report flash/timing issues without losing content.
  translatedBlocks.sort((a, b) => timestampToSeconds(a.start) - timestampToSeconds(b.start));
  const validBlocks = [];
  for (let i = 0; i < translatedBlocks.length; i++) {
    const cur = translatedBlocks[i]!;
    if (i > 0) {
      const prevEnd = timestampToSeconds(validBlocks[validBlocks.length - 1]!.end);
      if (timestampToSeconds(cur.start) < prevEnd) {
        cur.start = secondsToTimestamp(prevEnd + 0.001);
      }
    }
    validBlocks.push(cur);
  }

  // Cross-sentence pass: catch a brief/fast block that mergeShortPieces
  // couldn't reach because it's a whole short sentence on its own single
  // cue, or sits right at a sentence boundary.
  const mergedBlocks = mergeBriefBlocks(validBlocks, HARD_CJK);

  // File-wide width backstop: nothing may leave this function over the hard
  // ceiling it splits against. Runs before the reading-speed pass so cps is
  // measured on the text that will actually be displayed.
  const fittedBlocks = splitWideBlocks(mergedBlocks, HARD_CJK, technicalTermGuard);

  // Whatever still reads too fast after merging (merging alone is capped by
  // the width budget) gets one targeted compact rewrite.
  const finalBlocks = await compactDenseBlocks(
    fittedBlocks,
    opts.llm,
    opts.model,
    opts.signal,
    technicalTermGuard,
    finalizeText,
  );

  // Build per-cue bilingual SRT from valid blocks.
  const bilingualSrt = serializeSrtBlocks(
    finalBlocks.map((b, i) => ({
      index: i + 1,
      start: b.start,
      end: b.end,
      text: [b.zhText, b.enText],
    })),
  );

  const enSrt = serializeSrtBlocks(
    finalBlocks.map((b, i) => ({
      index: i + 1,
      start: b.start,
      end: b.end,
      text: [b.enText],
    })),
  );

  const zhSrt = serializeSrtBlocks(
    mergeAdjacentDuplicateZh(finalBlocks).map((b, i) => ({
      index: i + 1,
      start: b.start,
      end: b.end,
      text: [b.zhText],
    })),
  );

  return {
    enSrt,
    zhSrt,
    bilingualSrt,
    sourceSha256,
    technicalTermProfileFingerprint: technicalTermGuard.profile.profileFingerprint,
    groups: [], // per-cue alignment — no semantic groups to return
  };
};
