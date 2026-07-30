/**
 * 时长协商第三步：LLM 改短。
 *
 * 与朗读化改写不同——原文已经是口语，这里只要求压进字符预算，
 * 仍然不增删信息点。重新翻译会让字幕和配音再次分叉。
 */

export const DUB_SHORTEN_RULES: readonly string[] = [
  "1. Shorten for spoken delivery timing ONLY. Do NOT re-translate. Do NOT add information. Drop filler and redundancy first; keep every fact, number, and name.",
  "2. Proper nouns, brand names, product names, shell commands, API names, and code identifiers stay EXACTLY as written.",
  '3. Spoken number forms already in the text ("百分之三十", "两倍") stay as spoken forms — do not revert them to digits.',
  '4. The rewrite MUST be at most "maxChars" characters (Unicode code points). Shorter is better. Empty string is forbidden.',
  '5. Return ONLY a JSON array of objects with "index" (number) and "text" (string). One object per input index, same indices. No commentary, no code fences.',
  "6. The output MUST be Simplified Chinese (zh-CN).",
];

export const getDubShortenSystemPrompt = (): string =>
  [
    "You are a Chinese dubbing script editor. Each sentence is too long for its video slot. Shorten it so a text-to-speech voice can finish inside the time budget.",
    "",
    "Rules:",
    ...DUB_SHORTEN_RULES,
  ].join("\n");

export const buildDubShortenRepairPrompt = (missingIndices: readonly number[]): string =>
  [
    `You are a Chinese dubbing script editor. Shorten these ${missingIndices.length} sentences to fit their time budgets.`,
    `CRITICAL: return EXACTLY one object per index, no more, no less. The indices are: ${missingIndices.join(", ")}.`,
    "",
    "Rules:",
    ...DUB_SHORTEN_RULES,
  ].join("\n");

export type DubShortenPromptItem = {
  index: number;
  text: string;
  maxChars: number;
};

export const buildDubShortenUserPrompt = (items: readonly DubShortenPromptItem[]): string =>
  JSON.stringify(items);
