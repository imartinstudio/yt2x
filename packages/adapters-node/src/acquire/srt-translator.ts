import type { LlmPort } from "@yt2x/core";
import { parseJsonWithRepairs, salvagePartialJsonArray } from "../llm/parse-json.js";
import { parseSubtitleBlocks, serializeSrtBlocks } from "./video-subtitles.js";

export type SrtTranslatorOptions = {
  llm: LlmPort;
  model: string;
  sourceLang: string;
  targetLang: string;
  signal?: AbortSignal;
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

const translateBatch = async (
  blocks: TextBlock[],
  opts: SrtTranslatorOptions,
  repairMode = false,
): Promise<TextBlock[]> => {
  const payload = blocks.map((b) => ({ index: b.index, text: b.text }));
  const userPrompt = JSON.stringify(payload);

  const systemPrompt = repairMode
    ? buildRepairPrompt(
        opts.sourceLang,
        opts.targetLang,
        blocks.map((b) => b.index),
      )
    : buildSystemPrompt(opts.sourceLang, opts.targetLang);

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

  return results;
};

const batchTranslateAll = async (
  blocks: TextBlock[],
  opts: SrtTranslatorOptions,
): Promise<{ translated: TextBlock[]; warnings: string[] }> => {
  const results: TextBlock[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);

    let batchTranslated = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await translateBatch(batch, opts);
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
  translated.sort((a, b) => a.index - b.index);

  const translatedCues = cues.map((cue, i) => ({
    ...cue,
    text: [translated[i]!.text],
  }));

  return serializeSrtBlocks(translatedCues);
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

  // Phase 1: batch translate all blocks (resilient — partial results OK)
  const { translated, warnings } = await batchTranslateAll(blocks, opts);

  // Phase 2: repair missing blocks if count doesn't match
  if (translated.length !== blocks.length) {
    const translatedIndices = new Set(translated.map((b) => b.index));
    const missing = blocks.filter((b) => !translatedIndices.has(b.index));

    if (missing.length > 0) {
      try {
        const repaired = await translateBatch(missing, opts, true);
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
        const repaired = await translateBatch(missing, opts, true);
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
          const repaired = await translateBatch([m], opts, true);
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
        const repaired = await translateBatch([src], opts, true);
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

  let finalSrt = buildFinalSrt(cues, translated);

  // Post-process: ensure Simplified Chinese output regardless of model preference
  try {
    const { simplifyChinese } = await import("./simplify-chinese.js");
    finalSrt = await simplifyChinese(finalSrt);
  } catch {
    // If conversion fails, keep original SRT
  }

  // Post-process: preserve proper nouns from English source
  try {
    const { preserveProperNouns } = await import("./simplify-chinese.js");
    // Apply per-cue: find English source text for each translated cue
    const parsedZh = parseSubtitleBlocks(finalSrt);
    const parsedEn = parseSubtitleBlocks(srtContent);
    if (parsedZh.length === parsedEn.length) {
      const fixedCues = parsedZh.map((zhCue, i) => {
        const enCue = parsedEn[i]!;
        const enText = enCue.text.join(" ");
        const fixedText = preserveProperNouns(
          zhCue.text.join(" "),
          enText,
        );
        return { ...zhCue, text: [fixedText] };
      });
      finalSrt = serializeSrtBlocks(fixedCues);
    }
  } catch {
    // If preservation fails, keep original SRT
  }

  return { srt: finalSrt, warnings };
};
