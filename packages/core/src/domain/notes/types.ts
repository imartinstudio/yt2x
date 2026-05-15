/**
 * Notes 阶段的领域类型。
 *
 * 设计原则：纯数据结构，不引用 fs / fetch / 任何 Node-only API；
 * 这样 v0.2 Chrome extension 也能复用同样的 prompt 构造逻辑。
 */

/** yt-dlp metadata.json 中我们真正会用到的字段（其余无关字段会被 strip 掉） */
export type YouTubeMetadata = {
  id?: string;
  title?: string;
  webpage_url?: string;
  channel?: string;
  upload_date?: string;
  duration?: number;
  description?: string;
  thumbnail?: string;
  language?: string;
  [k: string]: unknown;
};

export type ScreenshotFrame = {
  timestamp: string;
  file: string;
  /** 关联的转录文字片段，用于 LLM 选片时理解上下文 */
  transcript_context?: string;
};

export type ScreenshotManifest = {
  frames?: ScreenshotFrame[];
  screenshots?: ScreenshotFrame[]; // 历史别名
  [k: string]: unknown;
};

/**
 * 构造 user prompt 所需的全部素材，已脱离任何 IO/文件路径概念。
 *
 *  - `metadata` 来自 metadata.json
 *  - `chunksMd` / `timestampedCuesMd` 是文件内容字符串
 *  - `screenshots` 是已解析的 manifest（null 表示无截图）
 */
export type NotesPromptInput = {
  metadata: YouTubeMetadata;
  chunksMd: string;
  timestampedCuesMd: string;
  /** 无截图时为 `null` 或 `undefined`（二者等价） */
  screenshots?: ScreenshotManifest | null;
};

export type NotesPromptOptions = {
  /** 输出语言。当前默认 "zh"，schema/system prompt 已经按中文写定。 */
  outputLanguage?: "zh" | "en";
};
