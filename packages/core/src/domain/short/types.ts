import type { YouTubeMetadata } from "../notes/types.js";

export type ShortPromptInput = {
  metadata: YouTubeMetadata;
  structuredNotesMd: string;
};

export type ShortPromptOptions = {
  /** 当前仅实现 X 短帖；预留扩展。 */
  platform?: "x";
  /** 输出语言。默认中文。 */
  outputLanguage?: "zh" | "en";
};

export type ShortPostAngle = "contrarian" | "practical" | "trend" | "technical" | "discussion";
export type ShortPostRisk = "low" | "medium" | "high";

export type GeneratedShortPost = {
  text: string;
  angle: ShortPostAngle;
  risk: ShortPostRisk;
};
