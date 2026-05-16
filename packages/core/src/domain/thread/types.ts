import type { YouTubeMetadata } from "../notes/types.js";
import type { AvailableVisual } from "../visuals/types.js";

export type ThreadPromptInput = {
  metadata: YouTubeMetadata;
  structuredNotesMd: string;
  /** 可用截图列表；null/[] 表示无可用截图 */
  availableVisuals?: AvailableVisual[] | null;
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

export type ThreadPlanning = {
  core_thesis: string;
  conflict: string;
  key_points: string[];
  reader_gain: string;
  final_post: string;
};

/** 串推中单条配图计划 */
export type ThreadVisualItem = {
  /** 对应的 tweet index（0-based） */
  tweet_index: number;
  /** 引用 available_visuals 中的 visual_id */
  visual_id: string;
  /** 图片说明 */
  caption: string;
};

export type GeneratedThread = {
  title: string;
  planning: ThreadPlanning;
  tweets: string[];
  hooks: ThreadHook[];
  /** 串推配图计划（可选，最多 3 张） */
  visuals?: ThreadVisualItem[];
};
