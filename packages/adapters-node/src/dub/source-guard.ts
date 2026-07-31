import {
  detectBurnedSubtitles,
  type DetectBurnedSubtitlesResult,
} from "../acquire/detect-burned-subs.js";
import type { ProcessRunner } from "../process/index.js";

export class DubHardSubtitleError extends Error {
  readonly code = "DUB_HARD_SUBTITLE_SOURCE";

  constructor(message: string) {
    super(message);
    this.name = "DubHardSubtitleError";
  }
}

export const isDubHardSubtitleError = (err: unknown): err is DubHardSubtitleError =>
  err instanceof DubHardSubtitleError ||
  (typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "DUB_HARD_SUBTITLE_SOURCE");

/**
 * 配音与「原片已有中文硬字幕」不兼容：配音会改时间轴，保留旧硬字幕必然音字错位。
 * 字幕烧录流程仍可跳过叠烧；配音必须硬失败。
 */
export const assertNoChineseHardSubtitlesForDub = (
  detect: DetectBurnedSubtitlesResult,
): void => {
  if (!detect.hasChineseBurnedSubtitles && detect.shouldSkipBurn !== true) return;

  throw new DubHardSubtitleError(
    "Source video already has burned Chinese hard subtitles. " +
      "Dubbing renegotiates the speech timeline, so keeping those burned cues would " +
      "desync picture and audio (旧硬字幕时间轴 ≠ 新配音时间轴). " +
      "Use an unburned original under downloads（换用未烧录字幕的源视频）and retry.",
  );
};

export type GuardDubSourceOptions = {
  detect?: typeof detectBurnedSubtitles;
  sampleCount?: number;
  threshold?: number;
  signal?: AbortSignal;
};

/**
 * 在任何计费/耗时调用之前检测硬字幕。失败即抛 DubHardSubtitleError。
 */
export const guardDubSourceAgainstHardSubtitles = async (
  videoPath: string,
  runner: ProcessRunner,
  opts: GuardDubSourceOptions = {},
): Promise<DetectBurnedSubtitlesResult> => {
  const detectFn = opts.detect ?? detectBurnedSubtitles;
  const detect = await detectFn(videoPath, runner, {
    ...(opts.sampleCount !== undefined ? { sampleCount: opts.sampleCount } : {}),
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  assertNoChineseHardSubtitlesForDub(detect);
  return detect;
};
