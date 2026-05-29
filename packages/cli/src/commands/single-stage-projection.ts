import { LlmProviderSchema } from "../args/llm.js";
import { PipelineArgsSchema, SearchSortSchema, type PipelineArgs } from "../args/pipeline.js";
import type { StageMode } from "../args/common.js";
import { defaultCliLlmProvider } from "../config/env.js";
import type { SingleStageFlags, SingleStageTarget } from "./command-flags.js";

const VALID_MODES: readonly StageMode[] = ["auto", "review", "skip"] as const;

export const toStageMode = (raw: string | undefined, fallback: StageMode): StageMode => {
  if (raw === undefined) return fallback;
  if ((VALID_MODES as readonly string[]).includes(raw)) {
    return raw as StageMode;
  }
  throw new Error(`Invalid --mode "${raw}". Expected one of: ${VALID_MODES.join(", ")}`);
};

/**
 * 把单阶段命令的扁平 flags 投影成完整 PipelineArgs：
 * 目标阶段使用 `--mode`（默认 auto），其他阶段强制 skip。
 */
export const projectSingleStage = (target: SingleStageTarget, flags: SingleStageFlags): PipelineArgs => {
  const mode = toStageMode(flags.mode, "auto");
  const allStages: Record<SingleStageTarget, StageMode> = {
    acquire: "skip",
    notes: "skip",
    article: "skip",
    publish: "skip",
  };
  allStages[target] = mode;

  const provider = flags.llmProvider
    ? LlmProviderSchema.parse(flags.llmProvider)
    : defaultCliLlmProvider();
  const downloadVideo =
    flags.downloadVideo !== false ||
    flags.videoOnly === true ||
    flags.videoStart !== undefined ||
    flags.videoEnd !== undefined;

  return PipelineArgsSchema.parse({
    sources: {
      urls: flags.urls ?? [],
      urlFile: flags.urlFile,
      search: flags.search,
      ...(flags.searchSort !== undefined
        ? { searchSort: SearchSortSchema.parse(flags.searchSort) }
        : {}),
    },
    stages: allStages,
    acquire: {
      keyframes: flags.keyframes ?? "0",
      jobs: flags.jobs ?? "3",
      subLangs: flags.subLangs,
      sceneThreshold: flags.sceneThreshold ?? "0.35",
      sceneMinGap: flags.sceneMinGap ?? "12",
      maxWords: flags.maxWords ?? "900",
      cookiesFromBrowser: flags.cookiesFromBrowser,
      proxy: flags.proxy,
      downloadVideo,
      videoOnly: flags.videoOnly ?? false,
      videoStart: flags.videoStart,
      videoEnd: flags.videoEnd,
      videoDuration: flags.videoDuration ?? "30",
      subtitleZh: flags.subtitleZh,
      subtitleSourceLang: flags.subtitleSourceLang,
      subtitleTargetLang: flags.subtitleTargetLang,
      subtitleSource: flags.subtitleSource,
      subtitleFile: flags.subtitleFile,
    },
    article: {
      platform: flags.platform ?? "x",
      maxChars: flags.maxChars ?? "280",
      rewriteMode: flags.rewriteMode ?? "rules",
      targets: flags.targets,
    },
    publish: {
      publishDryRun: flags.publishDryRun === true || flags.dryRun === true,
      format: flags.thread === true ? "thread" : "article",
      maxChars:
        flags.thread === true
          ? (flags.publishMaxChars ?? flags.maxChars ?? "500")
          : (flags.publishMaxChars ?? "500"),
      maxTweets: flags.maxTweets ?? "8",
      threadDelay: flags.threadDelay ?? "20-30",
    },
    control: {
      outDir: flags.outDir,
      continueFlag: flags.continueFrom ?? false,
      errorStrategy: flags.errorStrategy ?? "stop",
      force: flags.force ?? false,
    },
    llm: {
      provider,
      model: flags.llmModel,
      baseUrl: flags.llmBaseUrl,
    },
    flags: {
      verbose: flags.verbose ?? false,
    },
  });
};
