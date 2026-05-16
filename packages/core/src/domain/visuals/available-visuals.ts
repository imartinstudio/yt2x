import type { AvailableVisual, SceneManifest } from "./types.js";

/**
 * 将采集阶段产出的 scene_manifest.json 转换为传给 LLM 的 available_visuals。
 *
 * 过滤规则：
 * - blur: "high" 的截图 → 不可用
 * - blur: "unknown" 的截图 → 默认不可用（保守策略）
 * - center_presenter: true 的截图 → 不可用（居中主播人像）
 * - usable_for_content: false 的截图 → 不可用
 *
 * 纯函数，便于单测。
 */
export const manifestToAvailableVisuals = (
  manifest: SceneManifest | null,
): AvailableVisual[] => {
  if (manifest === null || manifest.frames === undefined || manifest.frames.length === 0) {
    return [];
  }

  return manifest.frames
    .filter((frame) => {
      const q = frame.visual_quality;
      if (q === undefined) return false;

      // 明确标记不可用
      if (q.usable_for_content === false) return false;

      // 清晰度不合格
      if (q.blur === "high") return false;
      // 清晰度未知，保守跳过
      if (q.blur === "unknown") return false;

      // 居中主播人像
      if (q.center_presenter === true) return false;

      return true;
    })
    .map((frame) => ({
      visual_id: frame.id,
      path: frame.file.startsWith("screenshots/")
        ? frame.file
        : `screenshots/${frame.file}`,
      timestamp: frame.timestamp,
      nearby_text: frame.transcript_context ?? "",
      quality: {
        blur: frame.visual_quality.blur,
        has_text: frame.visual_quality.has_text,
        has_ui: frame.visual_quality.has_ui,
        center_presenter: frame.visual_quality.center_presenter,
      },
    }));
};
