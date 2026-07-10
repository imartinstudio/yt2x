import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessRunner } from "../process/index.js";
import { resolvePythonWithPillow } from "./resolve-python.js";

export type DetectBurnedSubtitlesResult = {
  /** 底部多帧边缘密度偏高，可能已有硬字幕（含英文/UI 误判）。 */
  hasBurnedSubtitles: boolean;
  /** OCR 判定底部硬字幕为中文（简体或繁体）。 */
  hasChineseBurnedSubtitles: boolean;
  /** 仅当已有中文硬字幕（简体或繁体）时为 true，pipeline 据此跳过烧录。 */
  shouldSkipBurn: boolean;
};

const emptyResult = (): DetectBurnedSubtitlesResult => ({
  hasBurnedSubtitles: false,
  hasChineseBurnedSubtitles: false,
  shouldSkipBurn: false,
});

const parseDetectResult = (stdout: string): DetectBurnedSubtitlesResult => {
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const hasChineseBurnedSubtitles = parsed.hasChineseBurnedSubtitles === true;
  const shouldSkipBurn =
    parsed.shouldSkipBurn === true ||
    (parsed.shouldSkipBurn === undefined && hasChineseBurnedSubtitles);
  return {
    hasBurnedSubtitles: parsed.hasBurnedSubtitles === true,
    hasChineseBurnedSubtitles,
    shouldSkipBurn,
  };
};

/**
 * 检测原片是否已有烧录硬字幕；仅当判定为**中文（简体或繁体）**硬字幕时建议跳过烧录。
 *
 * 检测失败（脚本/ffmpeg 不可用等）时保守返回全 false，不阻塞烧录流程。
 */
export const detectBurnedSubtitles = async (
  videoPath: string,
  runner: ProcessRunner,
  opts?: { sampleCount?: number; threshold?: number; signal?: AbortSignal },
): Promise<DetectBurnedSubtitlesResult> => {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.join(scriptDir, "..", "..", "src", "acquire", "detect-burned-subs.py");

  const args = [scriptPath, videoPath];
  if (opts?.sampleCount !== undefined) args.push(String(opts.sampleCount));
  if (opts?.threshold !== undefined) args.push(String(opts.threshold));

  try {
    const pythonBin = await resolvePythonWithPillow();
    const result = await runner.run({
      command: pythonBin,
      args,
      timeoutMs: 120_000,
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });

    try {
      return parseDetectResult(result.stdout);
    } catch {
      return emptyResult();
    }
  } catch {
    return emptyResult();
  }
};
