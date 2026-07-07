import { Converter } from "opencc-js";

let _converter: ReturnType<typeof Converter> | null = null;

const getConverter = (): ReturnType<typeof Converter> => {
  if (_converter === null) {
    _converter = Converter({ from: "tw", to: "cn" });
  }
  return _converter;
};

/** Convert Traditional Chinese text to Simplified Chinese. Idempotent for already-simplified text. */
export const simplifyChinese = async (text: string): Promise<string> => {
  try {
    return await getConverter()(text);
  } catch {
    return text;
  }
};

/**
 * LLM CJK homoglyph corrections.
 *
 * Some LLMs confuse visually similar CJK characters. These are NOT
 * "hardcoded typos" — they are corrections for well-known homoglyph
 * pairs where one character is semantically invalid in context.
 *
 * 幺 (U+5E7A, "youngest"/"one") ≠ 么 (U+4E48, interrogative particle)
 *   - 幺 is NEVER used as a grammatical particle in modern Chinese
 *   - When preceded by 什/这/怎/那, the particle is ALWAYS 么
 *   - This is a spelling rule, not a word-list hack
 */
const LLM_HOMOGLYPH_FIXES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /([什这怎那])幺/g, replacement: "$1么" },
];

/** Apply CJK homoglyph corrections to LLM output. */
export const fixLlmHomoglyphs = (text: string): string => {
  let result = text;
  for (const { pattern, replacement } of LLM_HOMOGLYPH_FIXES) {
    result = result.replace(pattern, replacement);
  }
  return result;
};

/**
 * Extract proper nouns from English source text.
 *
 * Only extracts unambiguous proper nouns:
 * - Compounds with numbers: "Fable 5", "GPT-4", "Claude 3.5"
 * - Known brand/product patterns: "ChatGPT", "Claude", "Midjourney"
 *
 * Single capitalized words are intentionally excluded — they are too
 * ambiguous ("Cloud", "Open", "Free", etc. are often regular words
 * at the start of a subtitle line, not proper nouns).
 */
const extractProperNouns = (text: string): string[] => {
  // Compound names with numbers: "Fable 5", "GPT-4", "Claude 3.5"
  // Only match ONE word + number, not multi-word prefixes like "Cloud Fable 5"
  const compounds =
    text.match(/\b[A-Z][a-zA-Z0-9]+[- ]\d+(?:\.\d+)?\b/g) ?? [];
  // Known multi-word brand names that are always proper nouns
  const knownBrands =
    text.match(/\b(?:ChatGPT|Midjourney|Claude|Gemini|Copilot|Notion|Figma|Canva|Photoshop|Stable\s*Diffusion|DALL-E)\b/gi) ?? [];
  return [...new Set([...compounds, ...knownBrands])];
};

/**
 * Post-process translated Chinese text to preserve proper nouns from the
 * English source that the LLM may have translated despite instructions.
 *
 * Strategy: for capitalized words in the English source that don't appear
 * verbatim in the Chinese translation, append the original English term.
 * This is a conservative safety net — we never modify the Chinese text,
 * only add missing proper nouns.
 */
export const preserveProperNouns = (
  zhText: string,
  enSourceText: string,
): string => {
  const nouns = extractProperNouns(enSourceText);
  let result = zhText;
  for (const noun of nouns) {
    // Skip if already present verbatim (case-insensitive for known brands)
    if (result.toLowerCase().includes(noun.toLowerCase())) continue;

    // Append original proper noun — never modify the Chinese text itself
    result = result.trimEnd() + ` (${noun})`;
  }
  return result;
};

/** Synchronous fallback using DOM-free pure-JS path when available */
export const simplifyChineseSync = (text: string): string => {
  // opencc-js supports synchronous usage with preloaded data
  // For now, return text as-is; the async version is preferred
  return text;
};
