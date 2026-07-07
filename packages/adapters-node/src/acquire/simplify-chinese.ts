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
    // Skip if already present verbatim
    if (result.includes(noun)) continue;
    // Skip common English stopwords/pronouns
    if (
      /^(The|A|An|I|It|We|You|He|She|They|This|That|These|Those|And|But|Or|So|For|In|On|At|To|Of|Is|Are|Was|Were|Be|Been|Have|Has|Had|Do|Does|Did|Can|Will|Would|Should|Could|May|Might|Not|No|Yes|If|When|Where|Why|How|What|Who|Which|Her|His|My|Our|Your|Its|Their|Me|Him|Us|Them|Here|There|Now|Then|Just|Also|Only|Still|Even|Very|Much|Many|More|Most|Some|Any|All|Each|Every|Both|Few|One|Two|Hello|Goodbye|Okay|Alright|Hey|Wow|Yeah|Right|Left|North|South|East|West)$/.test(
        noun,
      )
    )
      continue;

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
