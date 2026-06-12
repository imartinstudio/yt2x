import { PipelineArgsSchema, SearchSortSchema, type PipelineArgs } from "./pipeline.js";
import { LlmProviderSchema } from "./llm.js";
import { defaultCliLlmProvider } from "../config/env.js";

export type CommanderPipelineFlags = {
  urls?: string[];
  urlFile?: string;
  search?: string;
  searchSort?: string;
  acquire?: string;
  notes?: string;
  article?: string;
  publish?: string;
  deconstruct?: string;
  outDir?: string;
  keyframes?: string;
  platform?: string;
  maxChars?: string;
  rewriteMode?: string;
  targets?: string;
  platformTargets?: string;
  jobs?: string;
  subLangs?: string;
  sceneThreshold?: string;
  sceneMinGap?: string;
  maxWords?: string;
  cookiesFromBrowser?: string;
  proxy?: string;
  downloadVideo?: boolean;
  videoOnly?: boolean;
  videoStart?: string;
  videoEnd?: string;
  videoDuration?: string;
  subtitleZh?: string;
  subtitleSourceLang?: string;
  subtitleTargetLang?: string;
  subtitleSource?: string;
  subtitleFile?: string;
  continueFrom?: boolean;
  errorStrategy?: string;
  force?: boolean;
  publishDryRun?: boolean;
  thread?: boolean;
  publishMaxChars?: string;
  maxTweets?: string;
  threadDelay?: string;
  premium?: boolean;
  llmProvider?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  verbose?: boolean;
};

export const parseCommanderPipelineFlags = (flags: CommanderPipelineFlags): PipelineArgs => {
  if (flags.videoOnly === true) {
    throw new Error("--video-only 只支持 yt2x acquire；pipeline 请使用 acquire 单阶段命令。");
  }
  const provider = flags.llmProvider ? LlmProviderSchema.parse(flags.llmProvider) : defaultCliLlmProvider();
  const downloadVideo =
    flags.downloadVideo !== false ||
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
    stages: {
      acquire: flags.acquire ?? "auto",
      notes: flags.notes ?? "review",
      article: flags.article ?? "review",
      publish: flags.publish ?? "review",
    },
    deconstruct: flags.deconstruct !== undefined ? Number(flags.deconstruct) : undefined,
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
      platformTargets: flags.platformTargets,
    },
    publish: {
      premium: flags.premium ?? false,
      publishDryRun: flags.publishDryRun ?? false,
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
