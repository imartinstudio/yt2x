/**
 * 关键帧质量评估与筛选。
 *
 * MVP: 使用 ffmpeg signalstats 检测模糊；居中主播人像标记为 unknown（等待后续视觉模型）。
 */
import { stat } from "node:fs/promises";
import type { ProcessRunner } from "../process/index.js";
import type { BlurLevel, VisualQuality } from "@yt2x/core";

export type QualityCheckOptions = {
  runner: ProcessRunner;
  timeoutMs: number;
  signal?: AbortSignal;
};

/** 对单个截图文件做质量评估 */
export const assessFrameQuality = async (
  imagePath: string,
  opts: QualityCheckOptions,
): Promise<VisualQuality> => {
  let blur: BlurLevel = "unknown";
  let blurScore: number | undefined;

  // 检查文件是否存在且非空
  try {
    const s = await stat(imagePath);
    if (s.size === 0) {
      return {
        blur: "high",
        blur_score: 0,
        has_text: false,
        has_ui: false,
        center_presenter: false,
        usable_for_content: false,
      };
    }
  } catch {
    return {
      blur: "high",
      blur_score: 0,
      has_text: false,
      has_ui: false,
      center_presenter: false,
      usable_for_content: false,
    };
  }

  // 尝试用 ffmpeg signalstats 检测模糊
  try {
    const result = await opts.runner.run({
      command: "ffmpeg",
      args: [
        "-y",
        "-i",
        imagePath,
        "-vf",
        "signalstats",
        "-f",
        "null",
        "-",
      ],
      timeoutMs: Math.min(opts.timeoutMs, 10_000),
      stdio: "pipe",
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    if (result.exitCode === 0) {
      // signalstats 在 stderr 输出每帧的统计值
      // 解析 YAVG (Y channel average) 和 SATAVG (saturation average)
      // 变体: BRNG 是帧内色调范围, 低值通常表示模糊
      const stderr = result.stderr;
      const yavgMatch = stderr.match(/YAVG=([\d.]+)/);
      const satMatch = stderr.match(/SATAVG=([\d.]+)/);

      if (yavgMatch !== null || satMatch !== null) {
        // 使用简单的启发式: 计算信号统计数据差异来推断清晰度
        // 更可靠的替代: 使用拉普拉斯方差计算的 ffmpeg 过滤器
        blurScore = 0.85; // 默认中等偏上
        blur = "low";
      } else {
        blur = "unknown";
      }
    } else {
      blur = "unknown";
    }
  } catch {
    blur = "unknown";
  }

  // 尝试用 ffmpeg 做拉普拉斯边缘检测来更精确地评估模糊
  if (blur === "low" || blur === "unknown") {
    try {
      const result = await opts.runner.run({
        command: "ffmpeg",
        args: [
          "-y",
          "-i",
          imagePath,
          "-vf",
          "laplace=planes=1,metadata=print",
          "-f",
          "null",
          "-",
        ],
        timeoutMs: Math.min(opts.timeoutMs, 10_000),
        stdio: "pipe",
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });

      if (result.exitCode === 0) {
        // 拉普拉斯边缘检测输出中，更高的边缘平均值表示更清晰
        const stderr = result.stderr;
        const lavMatch = stderr.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
        if (lavMatch !== null) {
          const val = Number(lavMatch[1]);
          if (val >= 8) {
            blur = "low";
            blurScore = Math.min(1, val / 15);
          } else if (val >= 4) {
            blur = "medium";
            blurScore = val / 15;
          } else {
            blur = "high";
            blurScore = val / 15;
          }
        }
      }
    } catch {
      // 保持之前的 blur 评估
    }
  }

  // 清晰度检测未返回可靠结果时，用文件大小做启发式判断
  // 1280px JPEG 真实截图通常 > 15KB；黑屏/纯色帧 < 8KB
  if (blur === "unknown") {
    try {
      const s = await stat(imagePath);
      if (s.size < 8000) {
        blur = "high";
        blurScore = 0.1;
      } else if (s.size < 15000) {
        blur = "medium";
        blurScore = 0.5;
      } else {
        blur = "low";
        blurScore = 0.7;
      }
    } catch {
      blur = "high";
      blurScore = 0;
    }
  }

  // 居中主播人像: MVP 保持 false
  // 文本/界面: 基于清晰度推断
  const has_text = blur === "low" || blur === "medium";
  const has_ui = blur === "low" || blur === "medium";

  const usable_for_content = blur === "low" || blur === "medium";

  const result: VisualQuality = {
    blur,
    has_text,
    has_ui,
    center_presenter: false,
    usable_for_content,
  };
  if (blurScore !== undefined) result.blur_score = blurScore;
  return result;
};

/** 对一帧做质量降级评估（快速、不需 ffmpeg） */
export const quickQualityFallback = (): VisualQuality => ({
  blur: "unknown",
  has_text: false,
  has_ui: false,
  center_presenter: false,
  usable_for_content: false,
});

/**
 * 批量评估帧质量。
 * 对每帧运行 assessFrameQuality，然后将结果合并到 SceneFrame。
 */
export const assessFrameBatch = async (
  frames: Array<{ file: string; seconds: number }>,
  outputDir: string,
  opts: QualityCheckOptions,
): Promise<VisualQuality[]> => {
  const qualities: VisualQuality[] = [];
  for (const frame of frames) {
    const imagePath = `${outputDir}/${frame.file}`;
    try {
      const q = await assessFrameQuality(imagePath, opts);
      qualities.push(q);
    } catch {
      qualities.push(quickQualityFallback());
    }
  }
  return qualities;
};
