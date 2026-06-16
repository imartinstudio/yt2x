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
    // If conversion fails (e.g., opencc data not loaded), return original
    return text;
  }
};

/** Synchronous fallback using DOM-free pure-JS path when available */
export const simplifyChineseSync = (text: string): string => {
  // opencc-js supports synchronous usage with preloaded data
  // For now, return text as-is; the async version is preferred
  return text;
};
