import type { YouTubeMetadata } from "../notes/types.js";
import type { AvailableVisual } from "../visuals/types.js";

export type ShortPromptInput = {
  metadata: YouTubeMetadata;
  structuredNotesMd: string;
  /** 可用截图列表；null/[] 表示无可用截图 */
  availableVisuals?: AvailableVisual[] | null;
};

export type ShortPromptOptions = {
  /** 当前仅实现 X 短帖；预留扩展。 */
  platform?: "x";
  /** 输出语言。默认中文。 */
  outputLanguage?: "zh" | "en";
};

export type ShortPostAngle = "contrarian" | "practical" | "trend" | "technical" | "discussion";
export type ShortPostRisk = "low" | "medium" | "high";

/** 短文单张配图（可选） */
export type ShortVisualItem = {
  /** 引用 available_visuals 中的 visual_id */
  visual_id: string;
  /** 图片说明 */
  caption: string;
};

export type GeneratedShortPost = {
  text: string;
  angle: ShortPostAngle;
  risk: ShortPostRisk;
  /** 短文配图（可选，最多 1 张） */
  visual?: ShortVisualItem;
};
