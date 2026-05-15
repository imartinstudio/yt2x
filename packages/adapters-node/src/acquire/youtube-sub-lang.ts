/**
 * BCP-47（如 en-US）→ YouTube 字幕语言根（en）。
 * 保留 zh-Hans / zh-Hant 等脚本变体尾。
 */
export const youtubeSubLangBase = (videoLanguage: string): string => {
  const v = (videoLanguage || "en").trim() || "en";
  const norm = v.replace(/_/g, "-");
  const parts = norm.split("-");
  if (parts.length >= 2 && parts[1]!.length === 2 && /^[a-zA-Z]+$/.test(parts[1]!)) {
    return parts[0]!.toLowerCase();
  }
  return norm;
};
