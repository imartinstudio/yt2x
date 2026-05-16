import type { YouTubeMetadata } from "../notes/types.js";
import type { AvailableVisual } from "../visuals/types.js";

/**
 * Article 阶段（native）构造 prompt 所需输入，与文件系统解耦。
 */
export type ArticlePromptInput = {
  metadata: YouTubeMetadata;
  structuredNotesMd: string;
  /** 可用截图列表；null/[] 表示无可用截图 */
  availableVisuals?: AvailableVisual[] | null;
};

export type ArticlePromptOptions = {
  /** 当前仅实现 X 长文；预留扩展。 */
  platform?: "x";
};

/** LLM 输出的单条配图计划 */
export type ArticleVisualPlanItem = {
  /** 配图所在的小节标题（对应 article.md 中的 ## 标题） */
  target: string;
  /** 引用 available_visuals 中的 visual_id */
  visual_id: string;
  /** 图片说明文字 */
  caption: string;
  /** 为什么选择这张图 */
  reason: string;
};

/** LLM 输出的完整配图计划 */
export type ArticleVisualPlan = ArticleVisualPlanItem[];
