import type { YouTubeMetadata } from "../notes/types.js";

/**
 * Article 阶段（native）构造 prompt 所需输入，与文件系统解耦。
 */
export type ArticlePromptInput = {
  metadata: YouTubeMetadata;
  structuredNotesMd: string;
};

export type ArticlePromptOptions = {
  /** 当前仅实现 X 长文；预留扩展。 */
  platform?: "x";
};
