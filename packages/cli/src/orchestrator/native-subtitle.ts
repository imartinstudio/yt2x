import path from "node:path";
import {
  DEFAULT_OUT_DIR,
  defaultProcessRunner,
  isProcessError,
  runSubtitlePipeline,
  sanitizeVideoId,
  type VideoSubtitleOptions,
} from "@yt2x/adapters-node";
import { logger } from "../logger.js";
import { resolveNativeLlm, type NativeLlmCliFlags } from "./native-stage-common.js";

export type SubtitleFlags = NativeLlmCliFlags & {
  outDir?: string;
  videoId?: string;
  subtitleZh?: string;
  subtitleSourceLang?: string;
  subtitleTargetLang?: string;
  subtitleSource?: string;
  subtitleFile?: string;
  articleOutDir?: string;
  verbose?: boolean;
};

/** 退出码常亮 */
const EXIT_OK = 0;
const EXIT_CONFIG = 4;

export const executeNativeSubtitle = async (flags: SubtitleFlags): Promise<number> => {
  // 校验并解析 LLM
  const llm = resolveNativeLlm(flags);
  if (!llm.ok) {
    logger.error({ reason: llm.reason }, "LLM config missing for subtitle translation");
    return llm.exitCode;
  }

  // 校验 video-id
  if (flags.videoId === undefined || flags.videoId.length === 0) {
    logger.error({}, "--video-id is required. Usage: yt2x subtitle --video-id <id>");
    return EXIT_CONFIG;
  }
  const videoId = sanitizeVideoId(flags.videoId);

  const outRoot = flags.outDir !== undefined ? path.resolve(flags.outDir) : path.resolve(DEFAULT_OUT_DIR);
  const videoDir = path.join(outRoot, videoId);

  const subtitle: VideoSubtitleOptions = {
    mode: (flags.subtitleZh as VideoSubtitleOptions["mode"]) ?? "srt",
    sourceLang: flags.subtitleSourceLang ?? "en",
    targetLang: flags.subtitleTargetLang ?? "zh-CN",
    source: (flags.subtitleSource as VideoSubtitleOptions["source"]) ?? "auto",
    ...(flags.subtitleFile !== undefined ? { file: flags.subtitleFile } : {}),
  };

  logger.info(
    { videoDir, mode: subtitle.mode, source: subtitle.source },
    "yt2x subtitle: running pipeline",
  );

  try {
    const { manifest, warnings } = await runSubtitlePipeline({
      videoDir,
      subtitle,
      llm: llm.adapter,
      llmModel: llm.model,
      runner: defaultProcessRunner,
      ...(flags.articleOutDir !== undefined
        ? { burnedVideoOutDir: path.resolve(flags.articleOutDir) }
        : {}),
    });

    for (const w of warnings) {
      logger.warn({ videoDir }, w);
    }

    logger.info(
      {
        videoDir,
        sourceSubtitle: manifest.source_subtitle,
        targetSubtitle: manifest.target_subtitle,
        burnedVideo: manifest.burned_video,
        translationMethod: manifest.translation_method,
      },
      "yt2x subtitle: pipeline complete",
    );

    return EXIT_OK;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stderrExcerpt = isProcessError(err) ? err.context.stderrExcerpt : undefined;
    logger.error({ videoDir, err: message, stderrExcerpt }, "yt2x subtitle: pipeline failed");
    return 1;
  }
};
