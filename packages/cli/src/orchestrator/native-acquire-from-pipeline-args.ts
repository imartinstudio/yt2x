import type { NativeAcquireOptions, ProcessRunner } from "@yt2x/adapters-node";
import type { PipelineArgs } from "../args/pipeline.js";

/**
 * 将 `PipelineArgs` 压成 `executeNativeAcquire` 所需形状，满足 `exactOptionalPropertyTypes`（不传入 `prop: undefined`）。
 */
export const nativeAcquireOptionsFromPipelineArgs = (
  args: PipelineArgs,
  ctx: { monorepoRoot: string; outDir: string; runner?: ProcessRunner },
): NativeAcquireOptions => ({
  monorepoRoot: ctx.monorepoRoot,
  outDir: ctx.outDir,
  sources: {
    urls: args.sources.urls,
    ...(args.sources.urlFile !== undefined ? { urlFile: args.sources.urlFile } : {}),
    ...(args.sources.search !== undefined ? { search: args.sources.search } : {}),
    ...(args.sources.searchSort !== undefined ? { searchSort: args.sources.searchSort } : {}),
  },
  acquire: {
    keyframes: args.acquire.keyframes,
    sceneThreshold: args.acquire.sceneThreshold,
    sceneMinGap: args.acquire.sceneMinGap,
    maxWords: args.acquire.maxWords,
    jobs: args.acquire.jobs,
    downloadVideo: args.acquire.downloadVideo,
    videoOnly: args.acquire.videoOnly,
    videoDuration: args.acquire.videoDuration,
    ...(args.acquire.videoStart !== undefined ? { videoStart: args.acquire.videoStart } : {}),
    ...(args.acquire.videoEnd !== undefined ? { videoEnd: args.acquire.videoEnd } : {}),
    subtitleZh: args.acquire.subtitleZh,
    subtitleSourceLang: args.acquire.subtitleSourceLang,
    subtitleTargetLang: args.acquire.subtitleTargetLang,
    subtitleSource: args.acquire.subtitleSource,
    ...(args.acquire.subtitleFile !== undefined ? { subtitleFile: args.acquire.subtitleFile } : {}),
    ...(args.acquire.subLangs !== undefined ? { subLangs: args.acquire.subLangs } : {}),
    ...(args.acquire.cookiesFromBrowser !== undefined
      ? { cookiesFromBrowser: args.acquire.cookiesFromBrowser }
      : {}),
    ...(args.acquire.proxy !== undefined ? { proxy: args.acquire.proxy } : {}),
  },
  stages: {
    acquire: args.stages.acquire,
    notes: args.stages.notes,
    article: args.stages.article,
    publish: args.stages.publish,
  },
  control: {
    continueFlag: args.control.continueFlag,
    errorStrategy: args.control.errorStrategy,
    force: args.control.force,
  },
  flags: args.flags,
  ...(ctx.runner !== undefined ? { runner: ctx.runner } : {}),
});
