import type { YouTubeMetadata } from "../notes/types.js";

export type ThreadPromptInput = {
  metadata: YouTubeMetadata;
  structuredNotesMd: string;
};

export type ThreadPromptOptions = {
  /** 当前仅实现 X 串推；预留扩展。 */
  platform?: "x";
  /** 输出语言。默认中文。 */
  outputLanguage?: "zh" | "en";
};

export type ThreadHookRisk = "low" | "medium" | "high";

export type ThreadHook = {
  text: string;
  angle: string;
  risk: ThreadHookRisk;
};

export type GeneratedThread = {
  title: string;
  tweets: string[];
  hooks: ThreadHook[];
};
