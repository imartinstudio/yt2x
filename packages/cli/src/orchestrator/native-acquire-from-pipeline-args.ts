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
  },
  flags: args.flags,
  ...(ctx.runner !== undefined ? { runner: ctx.runner } : {}),
});
