import type { LlmPort } from "@yt2x/core";
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

const buildSystemPrompt = (sourceLang: string, targetLang: string): string =>
  [
    `You are a professional subtitle translator. Translate from ${sourceLang} to ${targetLang}.`,
    "Rules:",
    "1. Return ONLY a JSON array of objects with \"index\" (number) and \"text\" (string).",
    "2. Translate the text naturally for subtitles — keep it concise and readable.",
    "3. Preserve the exact index for each block.",
    "4. Return the SAME number of blocks you receive. No merging or splitting.",
    "5. Do not add explanations, notes, or any text outside the JSON array.",
  ].join("\n");

const buildRepairPrompt = (sourceLang: string, targetLang: string, missingIndices: number[]): string =>
  [
    `You are a professional subtitle translator. Translate these ${missingIndices.length} blocks from ${sourceLang} to ${targetLang}.`,
    "CRITICAL: Return EXACTLY one block per index listed above — no more, no less.",
    "Rules:",
    "1. Return ONLY a JSON array of objects with \"index\" (number) and \"text\" (string).",
    "2. Each index MUST be one of: " + missingIndices.join(", ") + ".",
    "3. Do not skip any index. Do not add extra indices.",
    "4. Do not add explanations or any text outside the JSON array.",
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
  const parsed = JSON.parse(content) as unknown[];

  if (!Array.isArray(parsed)) {
    throw new Error("translation response is not a JSON array");
  }

  return parsed.map((item: unknown) => {
    const obj = item as Record<string, unknown>;
    if (typeof obj.index !== "number" || typeof obj.text !== "string") {
      throw new Error(`invalid translation block: ${JSON.stringify(item)}`);
    }
    return { index: obj.index, text: obj.text };
  });
};

const batchTranslateAll = async (
  blocks: TextBlock[],
  opts: SrtTranslatorOptions,
): Promise<TextBlock[]> => {
  const results: TextBlock[] = [];

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await translateBatch(batch, opts);
        results.push(...result);
        lastError = undefined;
        break;
      } catch (err: unknown) {
        lastError = err;
        if (attempt === 0) continue;
      }
    }

    if (lastError !== undefined) {
      throw new Error(
        `translation failed for blocks ${batch[0]!.index}-${batch[batch.length - 1]!.index}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
  }

  return results;
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
): Promise<string> => {
  const cues = parseSubtitleBlocks(srtContent);
  if (cues.length === 0) {
    throw new Error("no subtitle blocks to translate");
  }

  const blocks: TextBlock[] = cues.map((cue) => ({
    index: cue.index,
    text: cue.text.join(" "),
  }));

  // Phase 1: batch translate all blocks
  let translated = await batchTranslateAll(blocks, opts);

  // Phase 2: repair missing blocks if count doesn't match
  if (translated.length !== blocks.length) {
    const translatedIndices = new Set(translated.map((b) => b.index));
    const missing = blocks.filter((b) => !translatedIndices.has(b.index));

    if (missing.length > 0) {
      try {
        const repaired = await translateBatch(missing, opts, true);
        // merge: only add blocks whose indices were actually missing
        const deduped = translated.filter((b) => translatedIndices.has(b.index));
        for (const r of repaired) {
          if (!translatedIndices.has(r.index)) {
            deduped.push(r);
          }
        }
        translated = deduped;
      } catch {
        // repair failed, keep original partial result
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
        translated = deduped;
      } catch {
        // second repair also failed
      }
    }
  }

  if (translated.length !== cues.length) {
    throw new Error(
      `translation returned ${translated.length} blocks, expected ${cues.length}`,
    );
  }

  return buildFinalSrt(cues, translated);
};
