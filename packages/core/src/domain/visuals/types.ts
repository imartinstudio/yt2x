/**
 * 截图 manifest 与 available_visuals 领域类型。
 *
 * 设计原则：
 * - 纯数据结构，不引用 fs / fetch / 任何 Node-only API。
 * - manifest 仅由采集阶段写入，内容生成阶段只读。
 * - available_visuals 是 LLM 可以引用的唯一截图来源。
 */

/** 单帧清晰度级别 */
export type BlurLevel = "low" | "medium" | "high" | "unknown";

export type VisualQuality = {
  /** 清晰度级别 */
  blur: BlurLevel;
  /** 清晰度数值分数（0–1，越高越清晰），仅在 blur 不为 "unknown" 时有意义 */
  blur_score?: number;
  /** 帧中是否检测到文字 */
  has_text: boolean;
  /** 帧中是否检测到 UI 界面 */
  has_ui: boolean;
  /** 画面中心区域是否有人像（主播出镜） */
  center_presenter: boolean;
  /** 综合判断此帧是否可用于内容配图 */
  usable_for_content: boolean;
};

export type SceneFrame = {
  /** 稳定唯一标识，如 "scene_003" */
  id: string;
  /** 时间戳 HH:MM:SS */
  timestamp: string;
  /** 秒数 */
  seconds: number;
  /** 截图文件名（相对于截图目录） */
  file: string;
  /** 截图时刻附近的转写文字上下文 */
  transcript_context: string;
  /** 截图被选中的原因 */
  selection_reason: string;
  /** 视觉质量评估 */
  visual_quality: VisualQuality;
};

export type SceneManifest = {
  source: string;
  method: string;
  threshold?: number;
  min_gap?: number;
  max_frames?: number;
  frames: SceneFrame[];
  warnings?: string[];
  candidate_count?: number;
  selected_count?: number;
  contact_sheet?: string;
  stream_url_resolved?: boolean;
  /** 兼容旧格式：frames 内部分字段缺失时自动补全 */
};

/** 传给 LLM 的可用截图（精简版，不含质量检测实现细节） */
export type AvailableVisual = {
  visual_id: string;
  path: string;
  timestamp: string;
  nearby_text: string;
  quality: {
    blur: BlurLevel;
    has_text: boolean;
    has_ui: boolean;
    center_presenter: boolean;
  };
};
