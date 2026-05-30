import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessRunner } from "../process/index.js";

export type DetectBurnedSubtitlesResult = {
  hasBurnedSubtitles: boolean;
};

/**
 * 检测视频是否已内嵌烧录字幕（硬字幕）。
 * 通过对多个时间点采样帧，计算底部 20% 区域的边缘密度来判断。
 *
 * 检测失败（如脚本不存在、ffmpeg 不可用等）时保守返回 false（不阻塞流程）。
 */
export const detectBurnedSubtitles = async (
  videoPath: string,
  runner: ProcessRunner,
  opts?: { sampleCount?: number; threshold?: number; signal?: AbortSignal },
): Promise<DetectBurnedSubtitlesResult> => {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.join(
    scriptDir, "..", "..", "src", "acquire", "detect-burned-subs.py",
  );

  const args = [scriptPath, videoPath];
  if (opts?.sampleCount !== undefined) args.push(String(opts.sampleCount));
  if (opts?.threshold !== undefined) args.push(String(opts.threshold));

  try {
    const result = await runner.run({
      command: "python3",
      args,
      timeoutMs: 60_000,
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });

    try {
      const parsed = JSON.parse(result.stdout.trim());
      return { hasBurnedSubtitles: parsed.hasBurnedSubtitles === true };
    } catch {
      return { hasBurnedSubtitles: false };
    }
  } catch {
    // 检测失败时不阻塞流程，默认假设没有字幕
    return { hasBurnedSubtitles: false };
  }
};
