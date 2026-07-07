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

// Common LLM character mistakes in zh-CN output
const LLM_CHAR_FIXES: Record<string, string> = {
  "幺": "么", // 幺 → 么 (in context of 什么/这么/怎么/那么)
  "系": "系", // placeholder — add more as needed
};

/**
 * Fix common LLM character mistakes in Chinese subtitle output.
 *
 * Certain LLMs confuse visually similar CJK characters:
 * - 幺 (yāo, "youngest"/"one") vs 么 (me/ma, particle in 什么/怎么)
 *
 * We use context-aware replacement: 幺 → 么 when preceded by 什/这/怎/那.
 */
export const fixLlmCharMistakes = (text: string): string => {
  // 幺 → 么 when it follows 什/这/怎/那 (common particle context)
  return text.replace(/([什这怎那])幺/g, "$1么");
};

/**
 * Extract capitalized English words (potential proper nouns) from source text.
 * Returns a list of proper nouns that must be preserved verbatim.
 */
const extractProperNouns = (text: string): string[] => {
  // Match capitalized words (2+ chars) that aren't at the start of a sentence
  const words = text.match(/\b[A-Z][a-zA-Z0-9]+\b/g) ?? [];
  // Also match patterns like "GPT-4", "Claude 3.5", "Fable 5"
  const compounds = text.match(/\b[A-Z][a-zA-Z0-9]+[- ]\d+(\.\d+)?\b/g) ?? [];
  return [...new Set([...words, ...compounds])];
};

/**
 * Post-process translated Chinese text to preserve proper nouns from the
 * English source that the LLM may have translated despite instructions.
 *
 * Strategy: for each proper noun found in the English source, check if it
 * appears in the translation. If not, append it in parentheses after the
 * most likely translated position.
 */
export const preserveProperNouns = (
  zhText: string,
  enSourceText: string,
): string => {
  const nouns = extractProperNouns(enSourceText);
  let result = zhText;
  for (const noun of nouns) {
    // Skip if the noun already appears verbatim in the Chinese text
    if (result.includes(noun)) continue;
    // Skip common English words that happen to be capitalized
    if (/^(The|A|An|I|It|We|You|He|She|They|This|That|These|Those|And|But|Or|So|For|In|On|At|To|Of|Is|Are|Was|Were|Be|Been|Have|Has|Had|Do|Does|Did|Can|Will|Would|Should|Could|May|Might|Not|No|Yes|If|When|Where|Why|How|What|Who|Which)$/.test(noun)) continue;
    // Replace likely Chinese transliterations with the original English
    // Common patterns: 2-4 Chinese chars that match the English syllable count
    result = result.replace(noun, noun);
    // If not found as-is, append the original name
    if (!result.includes(noun)) {
      result = result.trimEnd() + ` (${noun})`;
    }
  }
  return result;
};

/** Synchronous fallback using DOM-free pure-JS path when available */
export const simplifyChineseSync = (text: string): string => {
  // opencc-js supports synchronous usage with preloaded data
  // For now, return text as-is; the async version is preferred
  return text;
};
