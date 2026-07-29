import { createHash } from "node:crypto";
import type { LlmPort } from "@yt2x/core";
import type { SubtitleAuditIssue } from "./audit-subtitles.js";
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
// bisected without any punctuation to guide the cut.
const CLAUSE_BOUNDARY_WORDS =
  /^(and|but|or|so|because|when|where|which|that|if|for|with|about|like|just|also|however|then|now)/i;

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

    // Merge short fragments (<4 words) with neighbors, but only if the
    // result stays ≤8 words (comparable to BaoCut's clause budget).
    const merged: string[] = [];
    for (const part of parts) {
      const wordCount = part.trim().split(/\s+/u).length;
      const leftWords = merged.length > 0 ? merged[merged.length - 1]!.split(/\s+/u).length : 0;
      if (merged.length > 0 && wordCount < 4 && leftWords + wordCount <= 8) {
        merged[merged.length - 1] = merged[merged.length - 1]! + " " + part.trim();
      } else {
        merged.push(part.trim());
      }
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
      const totalLen = finalParts.reduce((s, p) => s + p.length, 0);
      for (let p = 0; p < finalParts.length; p++) {
        const frac = finalParts[p]!.length / totalLen;
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
const HARD_CJK = 20;

// BaoCut treats one second of source speech on each side as the floor for a
// "natural" split; below that a cut produces an unreadable flash.
const MIN_SPLIT_DURATION_S = 1;

const CJK_PATTERN = /[一-鿿㐀-䶿\u{f900}-\u{faff}]/u;
const LATIN_ALNUM_PATTERN = /[A-Za-z0-9]/u;

// Glossary terms the translator is told to keep untranslated (see the
// translation prompt below). These survive verbatim inside the Chinese
// output, so a split point must never land inside one — matching BaoCut's
// "pt" (protected term) concept: "indivisible, no selectable seam exists
// inside it".
export const PROTECTED_GLOSSARY_TERMS = [
  "Grill Me", "Grill with Docs", "2PRD", "Codex", "Plan Mode", "Agents", "PRD",
  "Air Coding Cohort", "Shape Up", "YouTube", "Discord",
];
export const PROTECTED_NAMES = ["Matt Pocock", "Ryan Singer", "Gary Tan", "G Stack"];
const PROTECTED_TERMS: readonly string[] = [...PROTECTED_GLOSSARY_TERMS, ...PROTECTED_NAMES];

/**
 * Finds every span in `text` that a split must not land inside: every
 * occurrence of a known glossary term (may contain spaces, e.g. "Grill with
 * Docs"), plus every bare run of Latin/digit characters (covers embedded
 * English words like "Agents" even when they aren't in the glossary at all).
 */
// Chinese has no spaces between words, so a raw character-position split can
// (and in real DeepSeek output did) land inside an ordinary multi-character
// word like "范围" or "可能". Intl.Segmenter's dictionary-based word
// segmentation is built into Node (ICU) — no new dependency needed.
const CJK_WORD_SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });

export const findProtectedSpans = (
  text: string,
  terms: readonly string[] = PROTECTED_TERMS,
): [number, number][] => {
  const spans: [number, number][] = [];
  for (const term of terms) {
    let fromIndex = 0;
    let idx: number;
    while ((idx = text.indexOf(term, fromIndex)) !== -1) {
      spans.push([idx, idx + term.length]);
      fromIndex = idx + term.length;
    }
  }
  const latinRun = /[A-Za-z0-9]+/gu;
  let match: RegExpExecArray | null;
  while ((match = latinRun.exec(text)) !== null) {
    spans.push([match.index, match.index + match[0].length]);
  }
  // Protect multi-character Chinese words; a single character has no
  // internal boundary to protect, and punctuation is never word-like.
  for (const seg of CJK_WORD_SEGMENTER.segment(text)) {
    if (seg.isWordLike && seg.segment.length > 1) {
      spans.push([seg.index, seg.index + seg.segment.length]);
    }
  }
  return spans;
};

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

export const splitLongZh = (zh: string, partCount: number): string[] => {
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
    splitAt = nudgeOutOfProtectedSpans(splitAt, findProtectedSpans(remaining), remaining.length);
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
export const enforceHardCeiling = (parts: readonly string[], hardLimit: number): string[] => {
  const result: string[] = [];
  for (const part of parts) {
    if (visualWidth(part) <= hardLimit) {
      result.push(part);
      continue;
    }
    const halves = splitLongZh(part, 2);
    if (halves.length < 2) {
      result.push(part); // unsplittable (e.g. a single unbreakable token)
      continue;
    }
    result.push(...enforceHardCeiling(halves, hardLimit));
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
): Promise<string[] | null> => {
  try {
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
          content: JSON.stringify({ source: sourceText, currentTranslation, pieceCount }),
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
    const pieces = parsed.pieces;
    if (pieces.some((p) => visualWidth(p) > hardLimit)) return null;
    return pieces;
  } catch {
    return null;
  }
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
      const resp = await opts.llm.chat({
        model: opts.model,
        messages: [
          {
            role: "system",
            content:
              "Translate this English sentence to natural Simplified Chinese. " +
              "Return ONLY the Chinese text — no explanation.\n\n" +
              "CRITICAL — NEVER translate these, keep exactly as-is:\n" +
              `${PROTECTED_GLOSSARY_TERMS.join(", ")}\n` +
              `NEVER translate names: ${PROTECTED_NAMES.join(", ")}\n` +
              "Use conversational Chinese. Use 你 for 'you'. ≤30 Chinese characters.",
          },
          { role: "user", content: sentence.enText },
        ],
        temperature: 0.1,
        maxTokens: 512,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      return resp.content.trim();
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
  }[] = [];

  for (let s = 0; s < sentenceCues.length; s++) {
    const zhFull = sentenceTranslations[s]!;
    const cues = sentenceCues[s]!.cues;
    const zhWeight = visualWidth(zhFull);

    if (zhWeight <= FIT_CJK) {
      // Short sentence: show full Chinese on every cue.
      for (const cue of cues) {
        translatedBlocks.push({
          index: translatedBlocks.length + 1,
          start: cue.start,
          end: cue.end,
          zhText: zhFull,
          enText: normalizeText(cue.text),
        });
      }
    } else {
      // Long sentence: split into parts (content-driven, not capped by the
      // available cue count), enforce the hard ceiling on every part, then
      // grow the source cues if there aren't enough display slots yet.
      let parts = enforceHardCeiling(
        splitLongZh(zhFull, Math.max(1, Math.ceil(zhWeight / TARGET_CJK))),
        HARD_CJK,
      );
      const workingCues = cues.length >= parts.length
        ? cues
        : ensureEnoughFineCues(cues, parts.length, opts.wordTimings);
      if (workingCues.length < parts.length) {
        // Couldn't grow enough cues for the ideal split — re-target the
        // split to the cue count actually available, still hard-ceiling
        // checked (a naive tail-merge here could recreate an oversized part).
        parts = enforceHardCeiling(splitLongZh(zhFull, workingCues.length), HARD_CJK);
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
      const cueCounts = allocateCuesByWeight(parts.map((p) => visualWidth(p)), workingCues.length);

      let cueCursor = 0;
      for (let p = 0; p < parts.length; p++) {
        const endCue = cueCursor + cueCounts[p]!;
        for (let c = cueCursor; c < endCue; c++) {
          translatedBlocks.push({
            index: translatedBlocks.length + 1,
            start: workingCues[c]!.start,
            end: workingCues[c]!.end,
            zhText: parts[p]!,
            enText: normalizeText(workingCues[c]!.text),
          });
        }
        cueCursor = endCue;
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

  // Build per-cue bilingual SRT from valid blocks.
  const bilingualSrt = serializeSrtBlocks(
    validBlocks.map((b, i) => ({
      index: i + 1,
      start: b.start,
      end: b.end,
      text: [b.zhText, b.enText],
    })),
  );

  const enSrt = serializeSrtBlocks(
    validBlocks.map((b, i) => ({
      index: i + 1,
      start: b.start,
      end: b.end,
      text: [b.enText],
    })),
  );

  const zhSrt = serializeSrtBlocks(
    validBlocks.map((b, i) => ({
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
    groups: [], // per-cue alignment — no semantic groups to return
  };
};
