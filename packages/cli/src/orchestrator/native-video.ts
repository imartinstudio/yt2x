import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  collectNativePipelineVideoIds,
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_OUT_DIR,
  executeNativeAcquire,
  extractVideoId,
  type ProcessRunner,
} from "@yt2x/adapters-node";
import {
  DeliverModeSchema,
  DeliveryConflictError,
  FromModeSchema,
  internalSubtitleParamsFor,
  resolveFrom,
  type DeliverMode,
  type FromMode,
} from "@yt2x/core";
import { hasVideoSources, VideoSourcesFieldsSchema } from "../args/pipeline.js";
import { defaultMonorepoRoot } from "../config/monorepo-root.js";
import { logger } from "../logger.js";
import { ensureDubPreflight } from "./dub-preflight.js";
import { executeNativeDub } from "./native-dub.js";
import { mergePipelineExitCode } from "./native-pipeline.js";
import { NATIVE_EXIT, resolveNativeLlm } from "./native-stage-common.js";

export type VideoFlags = {
  urls?: string[];
  urlFile?: string;
  search?: string;
  searchSort?: string;
  videoId?: string[];
  outDir?: string;
  articleOutDir?: string;
  deliver?: string;
  from?: string;
  subtitleFile?: string;
  keyframes?: string;
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
  dubEngine?: string;
  pythonPath?: string;
  errorStrategy?: string;
  force?: boolean;
  llmProvider?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  verbose?: boolean;
  runner?: ProcessRunner;
};

const hasMetadata = async (outRoot: string, id: string): Promise<boolean> =>
  access(path.join(outRoot, id, "metadata.json"))
    .then(() => true)
    .catch(() => false);

const filterMaterializedVideoIds = async (
  outRoot: string,
  ids: readonly string[],
): Promise<string[]> => {
  const materialized: string[] = [];
  for (const id of ids) if (await hasMetadata(outRoot, id)) materialized.push(id);
  return materialized;
};

const sourceVideoIdsFromUrls = (urls: readonly string[]): string[] => {
  const ids = urls.map((url) => extractVideoId(url));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
};

/**
 * `yt2x video`：单条交付编排（Plan 2 Task 3）——下载 → 转录 → 字幕 → 配音，围绕单一
 * `--deliver` 档位（CONTEXT.md「交付物」）跑完整条链路，与既有的 `pipeline`/`acquire`/
 * `subtitle` 命令并存，互不影响（纯新增命令，不改动任何既有命令的行为）。
 */
export const executeNativeVideo = async (flags: VideoFlags): Promise<number> => {
  if (flags.deliver === undefined) {
    logger.error({}, "--deliver is required. See CONTEXT.md「交付物」for the six values.");
    return NATIVE_EXIT.CONFIG_MISSING;
  }
  let deliver: DeliverMode;
  try {
    deliver = DeliverModeSchema.parse(flags.deliver);
  } catch {
    logger.error(
      { deliver: flags.deliver },
      "Invalid --deliver value. See CONTEXT.md「交付物」for the six values.",
    );
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  let explicitFrom: FromMode | undefined;
  if (flags.from !== undefined) {
    try {
      explicitFrom = FromModeSchema.parse(flags.from);
    } catch {
      logger.error(
        { from: flags.from },
        "Invalid --from value. See CONTEXT.md「字幕通道」for the five values.",
      );
      return NATIVE_EXIT.CONFIG_MISSING;
    }
  }

  let resolvedFrom;
  try {
    resolvedFrom = resolveFrom(deliver, explicitFrom);
  } catch (err: unknown) {
    if (err instanceof DeliveryConflictError) {
      logger.error({ deliver, from: flags.from }, err.message);
      return NATIVE_EXIT.CONFIG_MISSING;
    }
    throw err;
  }

  const sourcesInput = VideoSourcesFieldsSchema.parse({
    urls: flags.urls ?? [],
    urlFile: flags.urlFile,
    search: flags.search,
    searchSort: flags.searchSort,
  });
  const hasUrlSources = hasVideoSources(sourcesInput);
  const explicitVideoIds = flags.videoId ?? [];
  if (!hasUrlSources && explicitVideoIds.length === 0) {
    logger.error(
      {},
      "yt2x video needs --urls/--url-file/--search (to acquire), or --video-id " +
        "(to reuse already-acquired material).",
    );
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  const monorepoRoot = defaultMonorepoRoot();
  const outRoot =
    flags.outDir !== undefined ? path.resolve(flags.outDir) : path.resolve(monorepoRoot, DEFAULT_OUT_DIR);
  const articleOutRoot =
    flags.articleOutDir !== undefined
      ? path.resolve(flags.articleOutDir)
      : path.resolve(monorepoRoot, DEFAULT_ARTICLE_OUT_DIR);
  await mkdir(outRoot, { recursive: true });
  await mkdir(articleOutRoot, { recursive: true });

  let videoIds: string[];
  if (hasUrlSources) {
    const internal = internalSubtitleParamsFor(deliver);
    const subtitleSource: "auto" | "youtube" | "transcribe" | "local" | "file" =
      resolvedFrom === "local-words" || resolvedFrom === "auto" ? "auto" : resolvedFrom;

    const needsTranslation = internal.subtitleZh !== "off" || internal.subtitleBilingual !== "off";
    let llmResult: ReturnType<typeof resolveNativeLlm> | undefined;
    if (needsTranslation) {
      llmResult = resolveNativeLlm({
        ...(flags.llmProvider !== undefined ? { llmProvider: flags.llmProvider } : {}),
        ...(flags.llmModel !== undefined ? { llmModel: flags.llmModel } : {}),
        ...(flags.llmBaseUrl !== undefined ? { llmBaseUrl: flags.llmBaseUrl } : {}),
      });
      if (!llmResult.ok) {
        logger.error({ reason: llmResult.reason }, "LLM config missing for subtitle translation");
        return llmResult.exitCode;
      }
    }

    const initialVideoIds = new Set(await collectNativePipelineVideoIds(outRoot));

    const acquireCode = await executeNativeAcquire({
      monorepoRoot,
      outDir: outRoot,
      articleOutDir: articleOutRoot,
      sources: {
        urls: sourcesInput.urls,
        ...(sourcesInput.urlFile !== undefined ? { urlFile: sourcesInput.urlFile } : {}),
        ...(sourcesInput.search !== undefined ? { search: sourcesInput.search } : {}),
        ...(sourcesInput.searchSort !== undefined ? { searchSort: sourcesInput.searchSort } : {}),
      },
      acquire: {
        keyframes: Number(flags.keyframes ?? "0"),
        jobs: Number(flags.jobs ?? "3"),
        sceneThreshold: Number(flags.sceneThreshold ?? "0.35"),
        sceneMinGap: Number(flags.sceneMinGap ?? "12"),
        maxWords: Number(flags.maxWords ?? "900"),
        downloadVideo: flags.downloadVideo ?? true,
        videoOnly: flags.videoOnly ?? false,
        videoDuration: Number(flags.videoDuration ?? "30"),
        subtitleZh: internal.subtitleZh,
        subtitleSourceLang: "en",
        subtitleTargetLang: "zh-CN",
        subtitleSource,
        subtitleBilingual: internal.subtitleBilingual,
        ...(flags.subLangs !== undefined ? { subLangs: flags.subLangs } : {}),
        ...(flags.cookiesFromBrowser !== undefined ? { cookiesFromBrowser: flags.cookiesFromBrowser } : {}),
        ...(flags.proxy !== undefined ? { proxy: flags.proxy } : {}),
        ...(flags.videoStart !== undefined ? { videoStart: flags.videoStart } : {}),
        ...(flags.videoEnd !== undefined ? { videoEnd: flags.videoEnd } : {}),
        ...(flags.subtitleFile !== undefined ? { subtitleFile: flags.subtitleFile } : {}),
      },
      stages: { acquire: "auto", notes: "skip", article: "skip", publish: "skip" },
      control: {
        continueFlag: false,
        errorStrategy: (flags.errorStrategy as "stop" | "skip" | undefined) ?? "stop",
        force: flags.force ?? false,
      },
      flags: { verbose: flags.verbose ?? false },
      ...(llmResult?.ok === true ? { llm: llmResult.adapter, llmModel: llmResult.model } : {}),
      ...(flags.runner !== undefined ? { runner: flags.runner } : {}),
    });
    if (acquireCode !== 0) {
      logger.error({ outRoot, exitCode: acquireCode }, "yt2x video: acquire failed");
      return acquireCode;
    }

    const allVideoIdsAfterAcquire = await collectNativePipelineVideoIds(outRoot);
    const newlyDiscoveredVideoIds = allVideoIdsAfterAcquire.filter((id) => !initialVideoIds.has(id));
    const sourceIds = sourceVideoIdsFromUrls(sourcesInput.urls);
    videoIds =
      newlyDiscoveredVideoIds.length > 0
        ? newlyDiscoveredVideoIds
        : allVideoIdsAfterAcquire.filter((id) => sourceIds.includes(id));
    videoIds = await filterMaterializedVideoIds(outRoot, videoIds);
    if (videoIds.length === 0) {
      logger.error({ outRoot }, "No videos with metadata.json found after acquire.");
      return 1;
    }
  } else {
    videoIds = await filterMaterializedVideoIds(outRoot, explicitVideoIds);
    if (videoIds.length !== explicitVideoIds.length) {
      logger.error(
        { outRoot, missing: explicitVideoIds.filter((id) => !videoIds.includes(id)) },
        "Some --video-id values have no metadata.json under --out-dir.",
      );
      return 1;
    }
  }

  let videoExitCode = 0;
  const internalForDub = internalSubtitleParamsFor(deliver);
  if (internalForDub.needsDub) {
    const preflight = await ensureDubPreflight({
      videoIds,
      outRoot,
      articleOutRoot,
      dubEngineFlag: flags.dubEngine,
      force: flags.force ?? false,
      commandLabel: "yt2x video",
      ...(flags.pythonPath !== undefined ? { pythonPath: flags.pythonPath } : {}),
      ...(flags.runner !== undefined ? { runner: flags.runner } : {}),
    });
    if (!preflight.ok) return preflight.exitCode;

    for (const id of videoIds) {
      const code = await executeNativeDub({
        videoId: id,
        outDir: outRoot,
        articleOutDir: articleOutRoot,
        ...(flags.dubEngine !== undefined ? { dubEngine: flags.dubEngine } : {}),
        force: flags.force ?? false,
        ...(flags.llmProvider !== undefined ? { llmProvider: flags.llmProvider } : {}),
        ...(flags.llmModel !== undefined ? { llmModel: flags.llmModel } : {}),
        ...(flags.llmBaseUrl !== undefined ? { llmBaseUrl: flags.llmBaseUrl } : {}),
        ...(flags.pythonPath !== undefined ? { pythonPath: flags.pythonPath } : {}),
      });
      if (code !== 0) {
        if ((flags.errorStrategy ?? "stop") === "stop") return code;
        videoExitCode = mergePipelineExitCode(videoExitCode, code);
      }
    }
  }

  for (const id of videoIds) {
    logger.info(
      { videoId: id },
      `yt2x video: done — continue with: yt2x text --video-id ${id} --out-dir ${outRoot} --article-out-dir ${articleOutRoot}`,
    );
  }
  return videoExitCode;
};
