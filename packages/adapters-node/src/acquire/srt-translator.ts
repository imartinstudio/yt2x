import {
  appendTechnicalTermRuleToSystemPrompt,
  createTechnicalTermGuard,
  hasHardTechnicalTermViolations,
  type LlmPort,
  type TechnicalTermGuard,
} from "@yt2x/core";
import { parseJsonWithRepairs, salvagePartialJsonArray } from "../llm/parse-json.js";
import { parseSubtitleBlocks, serializeSrtBlocks } from "./video-subtitles.js";

export type SrtTranslatorOptions = {
  llm: LlmPort;
  model: string;
  sourceLang: string;
  targetLang: string;
  signal?: AbortSignal;
  /** A full-source guard resolved by the caller, normally by video-subtitles.ts. */
  technicalTermGuard?: TechnicalTermGuard;
  /** Alias for callers that pass the resolved profile by domain terminology. */
  technicalTermProfile?: TechnicalTermGuard;
};

type TextBlock = { index: number; text: string };

const BATCH_SIZE = 30;

const isSimplifiedChineseTarget = (targetLang: string): boolean =>
  /^zh(?:[-_](?:CN|Hans|SG))?$/iu.test(targetLang);

const buildSystemPrompt = (sourceLang: string, targetLang: string): string =>
  [
    `You are a professional subtitle translator. Translate from ${sourceLang} to ${targetLang}.`,
    "Rules:",
    "1. Return ONLY a JSON array of objects with \"index\" (number) and \"text\" (string).",
    "2. Translate the text naturally for subtitles — keep it concise and readable.",
    "3. Preserve the exact index for each block.",
    "4. Return the SAME number of blocks you receive. No merging or splitting.",
    ...(isSimplifiedChineseTarget(targetLang)
      ? [
          "5. The final subtitle text MUST be Simplified Chinese (zh-CN). Traditional Chinese output is FORBIDDEN. Pay special attention: use 么 (not 幺) for the particle in 什么/怎么/这么/那么. If you are unsure whether a character is Simplified or Traditional, choose Simplified. This is a hard requirement — do not violate it.",
          "6. PROPER NOUNS MUST BE PRESERVED VERBATIM. This means: brand names (Fable, Claude, GPT, iPhone), product names, model names, technical terms, commands, API names, and code identifiers must appear EXACTLY as in the source text. Do NOT translate, transliterate, or localize them under any circumstance. If the source says 'Fable 5', the output must say 'Fable 5' — never '神谕5' or any other translation.",
          "7. Do not add explanations, notes, or any text outside the JSON array.",
        ]
      : ["5. Do not add explanations, notes, or any text outside the JSON array."]),
  ].join("\n");

const buildRepairPrompt = (sourceLang: string, targetLang: string, missingIndices: number[]): string =>
  [
    `You are a professional subtitle translator. Translate these ${missingIndices.length} blocks from ${sourceLang} to ${targetLang}.`,
    "CRITICAL: Return EXACTLY one block per index listed above — no more, no less.",
    "Rules:",
    "1. Return ONLY a JSON array of objects with \"index\" (number) and \"text\" (string).",
    "2. Each index MUST be one of: " + missingIndices.join(", ") + ".",
    "3. Do not skip any index. Do not add extra indices.",
    ...(isSimplifiedChineseTarget(targetLang)
      ? [
          "4. The final subtitle text MUST be Simplified Chinese (zh-CN). Traditional Chinese output is FORBIDDEN. This is a hard requirement — do not violate it.",
          "5. Do not add explanations or any text outside the JSON array.",
        ]
      : ["4. Do not add explanations or any text outside the JSON array."]),
  ].join("\n");

const appendTermRule = (prompt: string, guard: TechnicalTermGuard | undefined): string =>
  guard === undefined ? prompt : appendTechnicalTermRuleToSystemPrompt(prompt, guard.prepare([]).promptRule);

const scopedUnitGuard = (
  parent: TechnicalTermGuard,
  blocks: readonly TextBlock[],
  unitId: string,
): TechnicalTermGuard => parent.scopeUnit({
  sourceText: joinedCueText(blocks),
  unitId,
});

const translateBatch = async (
  blocks: TextBlock[],
  opts: SrtTranslatorOptions,
  repairMode = false,
  guard?: TechnicalTermGuard,
): Promise<TextBlock[]> => {
  const rangeGuard = guard === undefined
    ? undefined
    : scopedUnitGuard(
      guard,
      blocks,
      `srt:${repairMode ? "repair" : "batch"}:${blocks.map((block) => block.index).join(",")}`,
    );
  const scopedUnits = guard === undefined
    ? undefined
    : blocks.map((block) => {
      const unitGuard = scopedUnitGuard(
        guard,
        [block],
        `srt:${repairMode ? "repair" : "cue"}:${block.index}`,
      );
      return { block, guard: unitGuard, prepared: unitGuard.prepare({ index: block.index, text: block.text }) };
    });
  const payload = scopedUnits?.map((unit) => unit.prepared.value)
    ?? blocks.map((b) => ({ index: b.index, text: b.text }));
  const userPrompt = JSON.stringify(payload);

  const baseSystemPrompt = repairMode
    ? buildRepairPrompt(
        opts.sourceLang,
        opts.targetLang,
        blocks.map((b) => b.index),
      )
    : buildSystemPrompt(opts.sourceLang, opts.targetLang);
  const systemPrompt = appendTermRule(baseSystemPrompt, rangeGuard);

  const resp = await opts.llm.chat({
    model: opts.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    maxTokens: 16384,
    jsonMode: true,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  const content = resp.content.trim();

  // Resilient parse: try repaired JSON first, then salvage partial array
  // Note: parseJsonWithRepairs may extract a single JSON object from a truncated
  // array (via extractJsonObjectSlice). Always fall back to salvage when the
  // result is not an array so we recover as many complete objects as possible.
  let parsed: unknown;
  try {
    parsed = parseJsonWithRepairs(content);
  } catch {
    parsed = null;
  }

  if (!Array.isArray(parsed)) {
    parsed = salvagePartialJsonArray(content);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("translation response is not a JSON array");
  }

  const results: TextBlock[] = [];
  for (const item of parsed) {
    const obj = item as Record<string, unknown>;
    if (typeof obj.index === "number" && typeof obj.text === "string") {
      results.push({ index: obj.index, text: obj.text });
    }
    // Silently skip malformed items — repair phase will fill gaps
  }

  if (results.length === 0) {
    throw new Error("translation response contains no valid blocks");
  }

  const allowedIndices = new Set(blocks.map((block) => block.index));
  const dedupedResults = results.filter((result, index, all) =>
    allowedIndices.has(result.index)
    && all.findIndex((candidate) => candidate.index === result.index) === index,
  );
  if (dedupedResults.length === 0) {
    throw new Error("translation response contains no requested blocks");
  }

  return scopedUnits === undefined
    ? dedupedResults
    : dedupedResults.map((result) => {
      const unit = scopedUnits.find((candidate) => candidate.block.index === result.index);
      if (unit === undefined) return result;
      return unit.guard.finalize(result, unit.prepared.restoration).value;
    });
};

const batchTranslateAll = async (
  blocks: TextBlock[],
  opts: SrtTranslatorOptions,
  guard?: TechnicalTermGuard,
): Promise<{ translated: TextBlock[]; warnings: string[] }> => {
  const results: TextBlock[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);

    let batchTranslated = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await translateBatch(batch, opts, false, guard);
        results.push(...result);
        batchTranslated = true;
        break;
      } catch (err: unknown) {
        if (attempt === 1) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(
            `batch ${batch[0]!.index}-${batch[batch.length - 1]!.index} failed: ${message}`,
          );
        }
      }
    }

    // Even if the batch failed completely, continue — repair phases will fill gaps.
    // Log a warning so callers can surface which ranges needed repair.
    if (!batchTranslated) {
      warnings.push(
        `batch ${batch[0]!.index}-${batch[batch.length - 1]!.index} completely failed, will repair`,
      );
    }
  }

  return { translated: results, warnings };
};

const buildFinalSrt = (cues: ReturnType<typeof parseSubtitleBlocks>, translated: TextBlock[]): string => {
  const byIndex = new Map<number, TextBlock>();
  for (const block of translated) {
    if (!byIndex.has(block.index)) byIndex.set(block.index, block);
  }
  const translatedCues = cues.map((cue) => ({
    ...cue,
    text: [byIndex.get(cue.index)?.text ?? `[未翻译] ${cue.text.join(" ")}`],
  }));

  return serializeSrtBlocks(translatedCues);
};

type CueRange = { index: number; start: number; end: number };
type CueIndexRange = { start: number; end: number };

const joinedCueText = (blocks: readonly TextBlock[]): string => blocks.map((block) => block.text).join(" ");

const cueRanges = (blocks: readonly TextBlock[]): CueRange[] => {
  let cursor = 0;
  return blocks.map((block, position) => {
    const start = cursor;
    const end = start + block.text.length;
    cursor = end + (position < blocks.length - 1 ? 1 : 0);
    return { index: block.index, start, end };
  });
};

const cueRangeForSpan = (
  ranges: readonly CueRange[],
  start: number,
  end: number,
): CueIndexRange | undefined => {
  const first = ranges.find((range) => start >= range.start && start <= range.end);
  const last = [...ranges].reverse().find((range) => end >= range.start && end <= range.end);
  if (first === undefined || last === undefined) return undefined;
  return { start: first.index, end: last.index };
};

const termRepairRanges = (
  blocks: readonly TextBlock[],
  translated: readonly TextBlock[],
  guard: TechnicalTermGuard,
  violations: readonly { canonical?: string }[],
): CueIndexRange[] => {
  const sourceRanges = cueRanges(blocks);
  const ranges: CueIndexRange[] = [];
  const add = (range: CueIndexRange | undefined): void => {
    if (range === undefined) return;
    if (!ranges.some((existing) => existing.start === range.start && existing.end === range.end)) {
      ranges.push(range);
    }
  };

  const sourceOccurrences = guard.profile.occurrences.filter((item) => item.source === "sourceText");
  const checkedRanges = new Set<string>();
  for (const occurrence of sourceOccurrences) {
    const sourceRange = cueRangeForSpan(sourceRanges, occurrence.start, occurrence.end);
    if (sourceRange === undefined) continue;
    const rangeKey = `${sourceRange.start}-${sourceRange.end}`;
    if (checkedRanges.has(rangeKey)) continue;
    checkedRanges.add(rangeKey);
    const sourceRangeBlocks = blocks.filter((block) =>
      block.index >= sourceRange.start && block.index <= sourceRange.end,
    );
    const targetRangeBlocks = translated.filter((block) =>
      block.index >= sourceRange.start && block.index <= sourceRange.end,
    );
    const rangeGuard = scopedUnitGuard(guard, sourceRangeBlocks, `srt:validate:${rangeKey}`);
    const rangeViolations = rangeGuard.validate(joinedCueText(targetRangeBlocks));
    if (rangeViolations.length > 0) add(sourceRange);
  }

  if (sourceOccurrences.length > 0 && ranges.length === 0 && violations.length > 0) {
    const firstOccurrence = sourceOccurrences[0];
    if (firstOccurrence !== undefined) {
      add(cueRangeForSpan(sourceRanges, firstOccurrence.start, firstOccurrence.end));
    }
  }

  if (violations.length > 0 && ranges.length === 0) add({
    start: blocks[0]?.index ?? 1,
    end: blocks.at(-1)?.index ?? blocks[0]?.index ?? 1,
  });
  return ranges;
};

const finalizeTranslatedBlocks = (
  sourceBlocks: readonly TextBlock[],
  translated: readonly TextBlock[],
  guard: TechnicalTermGuard,
): { blocks: TextBlock[]; violations: ReturnType<TechnicalTermGuard["validate"]> } => {
  const sourceByIndex = new Map(sourceBlocks.map((block) => [block.index, block]));
  const perCueResults = translated.map((block) => {
    const source = sourceByIndex.get(block.index) ?? block;
    const cueGuard = scopedUnitGuard(guard, [source], `srt:final-cue:${block.index}`);
    return {
      block: cueGuard.finalize(block.text, { placeholders: [] }),
      cueGuard,
      source,
    };
  });
  const finalizedBlocks = perCueResults.map(({ block: finalized, source }) => ({
    index: source.index,
    text: finalized.value,
  }));
  const rangeGuard = scopedUnitGuard(
    guard,
    sourceBlocks,
    `srt:final-range:${sourceBlocks.map((block) => block.index).join(",")}`,
  );
  const joined = rangeGuard.finalize(joinedCueText(finalizedBlocks), { placeholders: [] });
  const perCueViolations = perCueResults.flatMap(({ block: finalized }) => finalized.violations);
  return { blocks: finalizedBlocks, violations: [...perCueViolations, ...joined.violations] };
};

const mergeTranslatedBlocks = (
  current: TextBlock[],
  replacement: readonly TextBlock[],
): void => {
  const byIndex = new Map(current.map((block) => [block.index, block]));
  for (const block of replacement) byIndex.set(block.index, block);
  current.length = 0;
  current.push(...byIndex.values());
};

const postProcessSrt = async (finalSrt: string, sourceSrt: string): Promise<string> => {
  let output = finalSrt;
  try {
    const { simplifyChinese } = await import("./simplify-chinese.js");
    output = await simplifyChinese(output);
  } catch {
    // If conversion fails, keep original SRT
  }

  try {
    const { fixLlmHomoglyphs } = await import("./simplify-chinese.js");
    output = fixLlmHomoglyphs(output);
  } catch {
    // If fix fails, keep original SRT
  }

  try {
    const { preserveProperNouns } = await import("./simplify-chinese.js");
    const parsedZh = parseSubtitleBlocks(output);
    const parsedEn = parseSubtitleBlocks(sourceSrt);
    if (parsedZh.length === parsedEn.length) {
      const fixedCues = parsedZh.map((zhCue, i) => {
        const enCue = parsedEn[i]!;
        const fixedText = preserveProperNouns(
          zhCue.text.join(" "),
          enCue.text.join(" "),
        );
        return { ...zhCue, text: [fixedText] };
      });
      output = serializeSrtBlocks(fixedCues);
    }
  } catch {
    // If preservation fails, keep original SRT
  }
  return output;
};

export const translateSrt = async (
  srtContent: string,
  opts: SrtTranslatorOptions,
): Promise<{ srt: string; warnings: string[] }> => {
  const cues = parseSubtitleBlocks(srtContent);
  if (cues.length === 0) {
    throw new Error("no subtitle blocks to translate");
  }

  const blocks: TextBlock[] = cues.map((cue) => ({
    index: cue.index,
    text: cue.text.join(" "),
  }));
  const technicalTermGuard = opts.technicalTermGuard
    ?? opts.technicalTermProfile
    ?? createTechnicalTermGuard({ sourceText: joinedCueText(blocks) });

  // Phase 1: batch translate all blocks (resilient — partial results OK)
  const { translated, warnings } = await batchTranslateAll(blocks, opts, technicalTermGuard);

  // Phase 2: repair missing blocks if count doesn't match
  if (translated.length !== blocks.length) {
    const translatedIndices = new Set(translated.map((b) => b.index));
    const missing = blocks.filter((b) => !translatedIndices.has(b.index));

    if (missing.length > 0) {
      try {
        const repaired = await translateBatch(missing, opts, true, technicalTermGuard);
        const deduped = translated.filter((b) => translatedIndices.has(b.index));
        for (const r of repaired) {
          if (!translatedIndices.has(r.index)) {
            deduped.push(r);
          }
        }
        translated.length = 0;
        translated.push(...deduped);
        warnings.push(`repaired ${repaired.length}/${missing.length} missing blocks in phase 2`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`phase 2 repair failed: ${message}`);
      }
    }
  }

  // Phase 3: second repair attempt with explicit index list
  if (translated.length !== blocks.length) {
    const translatedIndices = new Set(translated.map((b) => b.index));
    const missing = blocks.filter((b) => !translatedIndices.has(b.index));

    if (missing.length > 0) {
      try {
        const repaired = await translateBatch(missing, opts, true, technicalTermGuard);
        const deduped = translated.filter((b) => translatedIndices.has(b.index));
        for (const r of repaired) {
          if (!translatedIndices.has(r.index)) {
            deduped.push(r);
          }
        }
        translated.length = 0;
        translated.push(...deduped);
        warnings.push(`repaired ${repaired.length}/${missing.length} missing blocks in phase 3`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`phase 3 repair failed: ${message}`);
      }
    }
  }

  // Phase 4: final single-cue targeted repair
  if (translated.length !== blocks.length) {
    const translatedIndices = new Set(translated.map((b) => b.index));
    const missing = blocks.filter((b) => !translatedIndices.has(b.index));

    if (missing.length > 0) {
      for (const m of missing) {
        try {
          const repaired = await translateBatch([m], opts, true, technicalTermGuard);
          const added = repaired.filter((r) => !translatedIndices.has(r.index));
          translated.push(...added);
          if (added.length > 0) {
            warnings.push(`phase 4: recovered missing cue #${m.index}`);
          }
        } catch {
          warnings.push(`phase 4: failed to recover cue #${m.index}`);
        }
      }
    }
  }

  // Phase 5: check for empty-text blocks (LLM sometimes returns empty string on repair)
  const emptyBlocks = translated.filter((b) => b.text.trim().length === 0);
  if (emptyBlocks.length > 0) {
    const emptyIndices = emptyBlocks.map((b) => b.index);
    const sourceBlocks = blocks.filter((b) => emptyIndices.includes(b.index));
    warnings.push(
      `phase 5: ${emptyBlocks.length} blocks have empty text (indices: ${emptyIndices.join(", ")}), repairing`,
    );
    for (const src of sourceBlocks) {
      try {
        const repaired = await translateBatch([src], opts, true, technicalTermGuard);
        const valid = repaired.filter((r) => r.text.trim().length > 0);
        if (valid.length > 0) {
          // Replace empty block with repaired one
          const idx = translated.findIndex((b) => b.index === src.index);
          if (idx >= 0) translated[idx] = valid[0]!;
          else translated.push(valid[0]!);
          warnings.push(`phase 5: repaired empty cue #${src.index}`);
        } else {
          // Fill with source text as last resort
          const idx = translated.findIndex((b) => b.index === src.index);
          const fallback = { index: src.index, text: `[未翻译] ${src.text}` };
          if (idx >= 0) translated[idx] = fallback;
          else translated.push(fallback);
          warnings.push(`phase 5: using source fallback for cue #${src.index}`);
        }
      } catch {
        const idx = translated.findIndex((b) => b.index === src.index);
        const fallback = { index: src.index, text: `[未翻译] ${src.text}` };
        if (idx >= 0) translated[idx] = fallback;
        else translated.push(fallback);
        warnings.push(`phase 5: using source fallback for cue #${src.index} (repair failed)`);
      }
    }
  }

  // Final fallback: if mismatch is small (< 3% of cues), trim the result
  // to match by filling missing cues with English text + warning.
  if (translated.length !== cues.length) {
    const missingCount = cues.length - translated.length;
    if (missingCount > 0 && missingCount <= Math.max(2, Math.ceil(cues.length * 0.03))) {
      const translatedIndices = new Set(translated.map((b) => b.index));
      for (const block of blocks) {
        if (!translatedIndices.has(block.index)) {
          translated.push({ index: block.index, text: `[未翻译] ${block.text}` });
          warnings.push(
            `cue #${block.index} could not be translated after 5 repair phases; using English fallback`,
          );
        }
      }
    } else {
      throw new Error(
        `translation returned ${translated.length} blocks, expected ${cues.length} (${missingCount} missing after 5 repair phases)`,
      );
    }
  }

  let finalSrt = await postProcessSrt(buildFinalSrt(cues, translated), srtContent);
  const postProcessedBlocks = parseSubtitleBlocks(finalSrt).map((cue) => ({
    index: cue.index,
    text: cue.text.join(" "),
  }));
  translated.length = 0;
  translated.push(...postProcessedBlocks);

  // Finalize the complete source profile only after all language and homoglyph
  // post-processors have run. This is also where forbidden Chinese translations
  // are restored before the range-level check below.
  let finalized = finalizeTranslatedBlocks(blocks, translated, technicalTermGuard);
  translated.length = 0;
  translated.push(...finalized.blocks);

  const repairRanges = termRepairRanges(blocks, translated, technicalTermGuard, finalized.violations);
  if (repairRanges.length > 0) {
    const targetIndices = new Set<number>();
    for (const range of repairRanges) {
      for (const block of blocks) {
        if (block.index >= range.start && block.index <= range.end) targetIndices.add(block.index);
      }
    }
    const targetBlocks = blocks.filter((block) => targetIndices.has(block.index));
    if (targetBlocks.length > 0) {
      // One range-level repair covers all failing complete/cross-cue ranges.
      // Its payload contains only the affected source cues, so a cross-cue term
      // is never copied into unrelated cues.
      const repaired = await translateBatch(targetBlocks, opts, true, technicalTermGuard);
      mergeTranslatedBlocks(translated, repaired);
      finalSrt = await postProcessSrt(buildFinalSrt(cues, translated), srtContent);
      const repairedBlocks = parseSubtitleBlocks(finalSrt).map((cue) => ({
        index: cue.index,
        text: cue.text.join(" "),
      }));
      translated.length = 0;
      translated.push(...repairedBlocks);
      finalized = finalizeTranslatedBlocks(blocks, translated, technicalTermGuard);
      translated.length = 0;
      translated.push(...finalized.blocks);
    }
  }

  if (hasHardTechnicalTermViolations(finalized.violations)
    || termRepairRanges(blocks, translated, technicalTermGuard, finalized.violations).length > 0) {
    throw new Error(
      `technical term validation failed: ${finalized.violations.map((item) => item.message).join("; ")}`,
    );
  }
  finalSrt = buildFinalSrt(cues, translated);

  return { srt: finalSrt, warnings };
};
