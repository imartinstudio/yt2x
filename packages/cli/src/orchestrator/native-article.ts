import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_OUT_DIR,
  findPendingNativeArticleDirs,
  generatePlatformArticleContent,
  generateXArticleContent,
  generateXShortContent,
  generateXThreadContent,
  generateXVideoShortContent,
  patchProcessStatus,
  patchStepRunning,
  readStructuredNotesArtifacts,
  readYoutubePageUrl,
  renderArticleImages,
  writeNativeArticleBundle,
  writeNativeShortBundle,
  writeNativeThreadBundle,
  writeNativeVideoShortBundle,
  writePlatformArticleBundle,
  writeVisualSuggestions,
  technicalTermDiscoveryCacheDirFor,
  CONTENT_PROMPT_VERSIONS,
  contentSourceFingerprintFor,
  contentTargetMetadataPathFor,
  createContentTargetMetadata,
  isContentTargetMetadataFresh,
  readContentTargetMetadata,
  structuredNotesContentSourceFor,
  platformArticleContentSourceFor,
  type ContentTargetCacheExpectation,
  type ContentTargetMetadata,
} from "@yt2x/adapters-node";
import {
  checkArticleQuality,
  checkShortQuality,
  checkThreadQuality,
  deriveArticleVisualSuggestions,
  formatQualityIssues,
  isLlmError,
  manifestToAvailableVisuals,
  parseArticleOutputTargets,
  parsePlatformArticleTargets,
  type ArticleOutputTarget,
  type PlatformArticleTarget,
  type QualityIssue,
  type SceneManifest,
} from "@yt2x/core";
import { logger } from "../logger.js";
import type { SingleStageFlags } from "../commands/command-flags.js";
import { printCliErrorBlock } from "../diagnostics/error-format.js";
import { createCommandProgress } from "../progress/pipeline-progress.js";
import {
  NATIVE_EXIT,
  exitFromLlmKind,
  patchLlmStepFailed,
  resolveBatchVideoDirs,
  resolveNativeLlm,
} from "./native-stage-common.js";

export type ArticleFlags = SingleStageFlags & {
  videoId?: string[];
  all?: boolean;
  force?: boolean;
  articleOutDir?: string;
  showProgress?: boolean;
};

const addUsage = (
  totals: { promptTokens: number; completionTokens: number },
  usage: { promptTokens: number; completionTokens: number; totalTokens?: number } | undefined,
): void => {
  if (usage === undefined) return;
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
};

type ContentResultMetadata = {
  model: string;
  sourceFingerprint?: string;
  promptVersion?: string;
  technicalTermProfileFingerprint?: string;
  technicalTermDiscovery?: Parameters<typeof createContentTargetMetadata>[0]["technicalTermDiscovery"];
};

const contentMetadataForResult = (
  target: string,
  result: ContentResultMetadata,
): ContentTargetMetadata | undefined => {
  if (result.sourceFingerprint === undefined
    || result.promptVersion === undefined
    || result.technicalTermProfileFingerprint === undefined
    || result.technicalTermDiscovery === undefined) return undefined;
  return createContentTargetMetadata({
    target,
    sourceFingerprint: result.sourceFingerprint,
    model: result.model,
    promptVersion: result.promptVersion,
    technicalTermProfileFingerprint: result.technicalTermProfileFingerprint,
    technicalTermDiscovery: result.technicalTermDiscovery,
  });
};

const contentCacheHit = async (input: {
  metadataPath: string;
  expectation: Omit<ContentTargetCacheExpectation, "requiredFiles" | "sourceText" | "sourceTitle">;
  sourceText: string;
  sourceTitle: string;
  requiredFiles: readonly string[];
}): Promise<boolean> => {
  const metadata = await readContentTargetMetadata(input.metadataPath);
  return isContentTargetMetadataFresh(metadata, {
    ...input.expectation,
    sourceText: input.sourceText,
    sourceTitle: input.sourceTitle,
    requiredFiles: input.requiredFiles,
  });
};

/**
 * 把 deterministic quality issues 输出到 logger（warning 级别）。
 *
 * Quality issues 不阻断生成产物落盘，只让用户在终端看到「哪条规则没满足、产物路径是什么」。
 */
const logQualityIssues = (
  target: ArticleOutputTarget,
  videoId: string,
  artifactPath: string,
  issues: readonly QualityIssue[],
): void => {
  if (issues.length === 0) return;
  logger.warn(
    {
      videoId,
      target,
      artifact: artifactPath,
      issueCount: issues.length,
      codes: issues.map((i) => i.code),
    },
    `quality check warnings for ${target} (${videoId}):\n${formatQualityIssues(issues)}`,
  );
};

/** 供 `pipeline` 编排器与 `yt2x article` 调用；返回进程退出码。 */
export const executeNativeArticle = async (flags: ArticleFlags): Promise<number> => {
  const notesOutDir = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
  const articleOutDir = path.resolve(flags.articleOutDir ?? DEFAULT_ARTICLE_OUT_DIR);
  await mkdir(notesOutDir, { recursive: true });
  await mkdir(articleOutDir, { recursive: true });
  const platform = flags.platform ?? "x";
  if (platform !== "x") {
    printCliErrorBlock({
      command: "article",
      reason: `Unsupported platform: ${platform}`,
      hints: ["Native article generation currently supports only --platform x."],
      retryCommand: "pnpm yt2x article --video-id <videoId> --platform x",
    });
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  let platformTargets: PlatformArticleTarget[];
  try {
    platformTargets = parsePlatformArticleTargets(flags.platformTargets);
  } catch (err: unknown) {
    printCliErrorBlock({
      command: "article",
      reason: err instanceof Error ? err.message : String(err),
      hints: ["Use --platform-targets xiaohongshu,wechat,bilibili or --platform-targets all-platforms."],
      retryCommand: "pnpm yt2x article --video-id <videoId> --platform-targets xiaohongshu",
    });
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  let outputTargets: ArticleOutputTarget[];
  try {
    outputTargets =
      flags.targets === undefined && platformTargets.length > 0
        ? []
        : parseArticleOutputTargets(flags.targets);
  } catch (err: unknown) {
    printCliErrorBlock({
      command: "article",
      reason: err instanceof Error ? err.message : String(err),
      hints: ["Use --targets article,x-thread,x-short,x-video-short or --targets all."],
      retryCommand: "pnpm yt2x article --video-id <videoId> --targets article",
    });
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  // --targets all implies --platform-targets all-platforms (unless explicitly set)
  if (flags.targets === "all" && platformTargets.length === 0) {
    try {
      platformTargets = parsePlatformArticleTargets("all-platforms");
    } catch { /* should not happen for "all-platforms" */ }
  }
  const llm = resolveNativeLlm(flags);
  if (!llm.ok) {
    printCliErrorBlock({
      command: "article",
      reason: llm.reason,
      hints: ["Configure an LLM provider and API key before generating articles."],
      retryCommand: "pnpm yt2x llm ping",
    });
    return llm.exitCode;
  }

  const batch = await resolveBatchVideoDirs({
    outDir: notesOutDir,
    findAllPending: () => findPendingNativeArticleDirs(notesOutDir, articleOutDir),
    ...(flags.all === true ? { all: true as const } : {}),
    ...(flags.videoId !== undefined && flags.videoId.length > 0 ? { videoId: flags.videoId } : {}),
  });
  if (!batch.ok) {
    if (batch.reason === "empty_pending") {
      printCliErrorBlock({
        command: "article",
        reason: "No pending videos found.",
        details: notesOutDir,
        hints: ["Pending articles require structured-notes.md and no existing article.md."],
        retryCommand: "pnpm yt2x article --video-id <videoId>",
      });
    } else {
      printCliErrorBlock({
        command: "article",
        reason: "Missing target. Article requires --video-id <id...> or --all.",
        hints: ["Run notes first, then pass the generated video directory name."],
        retryCommand: "pnpm yt2x article --video-id <videoId>",
      });
    }
    return batch.exitCode;
  }
  const targets = batch.targets;
  const progress = flags.showProgress === false ? undefined : createCommandProgress("article", targets.length);
  let exitCode = 0;

  logger.info(
    {
      provider: llm.provider,
      model: llm.model,
      targets: targets.length,
      notesOutDir,
      articleOutDir,
      platform,
      outputTargets,
      platformTargets,
    },
    "yt2x article (native x): starting",
  );

  const tokenTotals = { promptTokens: 0, completionTokens: 0 };
  const errors: Array<{ videoDir: string; message: string }> = [];

  for (const videoDir of targets) {
    const stageT0 = performance.now();
    try {
      const artifacts = await readStructuredNotesArtifacts(videoDir);
      progress?.setActive(`article · ${artifacts.videoId}`);
      const url = await readYoutubePageUrl(videoDir, artifacts.videoId);
      const identity = { videoId: artifacts.videoId, url };
      const t0 = Date.now();
      const writtenArtifacts: string[] = [];
      const articleDir = path.join(articleOutDir, artifacts.videoId);
      let articleDirForStatus: string | undefined;
      let resultFile: string | undefined;
      let sourceArticleMd: string | undefined;

      // 读取 scene_manifest.json → available_visuals（所有格式共享）
      const sceneManifestPath = path.join(videoDir, "screenshots", "scene_manifest.json");
      let availableVisuals = null;
      try {
        await access(sceneManifestPath);
        const raw = await readFile(sceneManifestPath, "utf8");
        const manifest = JSON.parse(raw) as SceneManifest;
        availableVisuals = manifestToAvailableVisuals(manifest);
      } catch {
        // 无截图清单时保持纯文本
      }

      if (outputTargets.includes("article")) {
        const articlePath = path.join(articleOutDir, artifacts.videoId, "article.md");
        const runPath = path.join(articleDir, "run.json");
        const articleSource = structuredNotesContentSourceFor({
          metadata: artifacts.metadata,
          structuredNotesMd: artifacts.structuredNotesMd,
          availableVisuals,
        });
        const articleSourceFingerprint = contentSourceFingerprintFor(articleSource);
        const articleShouldSkip = flags.force !== true && await contentCacheHit({
          metadataPath: runPath,
          expectation: {
            target: "article",
            sourceFingerprint: articleSourceFingerprint,
            model: llm.model,
            promptVersion: CONTENT_PROMPT_VERSIONS.article,
          },
          sourceText: artifacts.structuredNotesMd,
          sourceTitle: artifacts.metadata.title ?? "",
          requiredFiles: [articlePath, runPath],
        });
        if (articleShouldSkip) {
          logger.info({ videoId: artifacts.videoId }, "article already exists, skipping");
        } else {
        await patchStepRunning(videoDir, identity, "article").catch(() => {});
        logger.info(
          { videoId: artifacts.videoId, model: llm.model },
          "yt2x article: calling LLM (may take several minutes)…",
        );

        const result = await generateXArticleContent({
          llm: llm.adapter,
          model: llm.model,
          artifacts,
          availableVisuals,
          technicalTermDiscoveryCacheDir: technicalTermDiscoveryCacheDirFor(
            path.join(articleOutDir, artifacts.videoId),
          ),
        });

        // 渲染图片：复制截图到文章 images/ 并替换路径
        const renderedContent = await renderArticleImages(
          result.content,
          videoDir,
          path.join(articleOutDir, artifacts.videoId),
          result.visualPlan,
          availableVisuals,
        );
        sourceArticleMd = renderedContent;

        const written = await writeNativeArticleBundle(
          articleOutDir,
          artifacts.videoId,
          renderedContent,
          {
            v: 1,
            platform: "x",
            videoId: artifacts.videoId,
            target: "article",
            model: result.model,
            finishReason: result.finishReason,
            generatedAt: new Date().toISOString(),
            durationMs: result.durationMs,
            technicalTermProfileFingerprint: result.technicalTermProfileFingerprint,
            technicalTermDiscovery: result.technicalTermDiscovery,
            sourceFingerprint: result.sourceFingerprint,
            promptVersion: result.promptVersion,
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
          },
          {
            force: flags.force === true,
            notesVideoDir: videoDir,
            sourceVideoUrl: url,
            cacheExpectation: {
              target: "article",
              sourceFingerprint: articleSourceFingerprint,
              model: llm.model,
              promptVersion: CONTENT_PROMPT_VERSIONS.article,
              sourceText: artifacts.structuredNotesMd,
              sourceTitle: artifacts.metadata.title ?? "",
              requiredFiles: [articlePath, runPath],
            },
          },
        );
        if (written === null) {
          logger.info({ videoId: artifacts.videoId }, "article already exists, skipping");
        } else {
        writtenArtifacts.push("article.md", "run.json");
        articleDirForStatus = written.articleDir;
        resultFile ??= path.basename(written.articlePath);
        addUsage(tokenTotals, result.usage);
        logger.info(
          {
            videoId: result.videoId,
            articleDir: written.articleDir,
            coverPath: written.coverPath,
            videoPath: written.videoPath,
            model: result.model,
            finishReason: result.finishReason,
            durationMs: result.durationMs,
            usage: result.usage,
          },
          "article generated (native article)",
        );
        const articleIssues = checkArticleQuality(renderedContent, {
          sourceText: `${artifacts.metadata.title ?? ""}\n${artifacts.structuredNotesMd}`,
        });
        logQualityIssues("article", artifacts.videoId, written.articlePath, articleIssues);

        const suggestions = deriveArticleVisualSuggestions(renderedContent);
        const suggestionsPath = await writeVisualSuggestions(written.articleDir, suggestions);
        if (suggestionsPath !== null) {
          writtenArtifacts.push("visual-suggestions.json");
          logger.info(
            {
              videoId: artifacts.videoId,
              suggestionsPath,
              count: suggestions.length,
              kinds: suggestions.map((s) => s.kind),
            },
            "visual suggestions written (article)",
          );
        }
        } // end if (written !== null)
        } // end else (articleShouldSkip)

      }

      if (outputTargets.includes("x-thread")) {
        const threadPath = path.join(articleOutDir, artifacts.videoId, "x-format", "x-thread.md");
        const threadMetadataPath = contentTargetMetadataPathFor(articleDir, "x-thread");
        const structuredSourceFingerprint = contentSourceFingerprintFor(structuredNotesContentSourceFor({
          metadata: artifacts.metadata,
          structuredNotesMd: artifacts.structuredNotesMd,
          availableVisuals,
        }));
        const xthreadShouldSkip = flags.force !== true && await contentCacheHit({
          metadataPath: threadMetadataPath,
          expectation: {
            target: "x-thread",
            sourceFingerprint: structuredSourceFingerprint,
            model: llm.model,
            promptVersion: CONTENT_PROMPT_VERSIONS.xThread,
          },
          sourceText: artifacts.structuredNotesMd,
          sourceTitle: artifacts.metadata.title ?? "",
          requiredFiles: [threadPath, path.join(articleDir, "x-format", "x-hooks.json"), threadMetadataPath],
        });
        if (xthreadShouldSkip) {
          logger.info({ videoId: artifacts.videoId }, "x-thread already exists, skipping");
        } else {
        const result = await generateXThreadContent({
          llm: llm.adapter,
          model: llm.model,
          artifacts,
          availableVisuals,
          technicalTermDiscoveryCacheDir: technicalTermDiscoveryCacheDirFor(articleDir),
        });
        const threadMetadata = contentMetadataForResult("x-thread", result);
        const written = await writeNativeThreadBundle(
          articleOutDir,
          artifacts.videoId,
          result.thread,
          {
            force: flags.force === true,
            cacheExpectation: {
              target: "x-thread",
              sourceFingerprint: structuredSourceFingerprint,
              model: llm.model,
              promptVersion: CONTENT_PROMPT_VERSIONS.xThread,
              sourceText: artifacts.structuredNotesMd,
              sourceTitle: artifacts.metadata.title ?? "",
              requiredFiles: [threadPath, path.join(articleDir, "x-format", "x-hooks.json"), threadMetadataPath],
            },
            ...(threadMetadata === undefined ? {} : { cacheMetadata: threadMetadata }),
          },
        );
        if (written === null) {
          logger.info({ videoId: artifacts.videoId }, "x-thread already exists, skipping");
        } else {
        writtenArtifacts.push("x-thread.md", "x-hooks.json");
        articleDirForStatus = written.articleDir;
        resultFile ??= path.basename(written.threadPath);
        addUsage(tokenTotals, result.usage);
        logger.info(
          {
            videoId: result.videoId,
            articleDir: written.articleDir,
            model: result.model,
            finishReason: result.finishReason,
            durationMs: result.durationMs,
            usage: result.usage,
          },
          "article generated (native x thread)",
        );
        const threadIssues = checkThreadQuality(result.thread, {
          sourceText: `${artifacts.metadata.title ?? ""}\n${artifacts.structuredNotesMd}`,
        });
        logQualityIssues("x-thread", artifacts.videoId, written.threadPath, threadIssues);
        } // end if (written !== null)
        } // end else (xthreadShouldSkip)

      }

      if (outputTargets.includes("x-short")) {
        const shortPath = path.join(articleOutDir, artifacts.videoId, "x-format", "x-short.md");
        const shortMetadataPath = contentTargetMetadataPathFor(articleDir, "x-short");
        const structuredSourceFingerprint = contentSourceFingerprintFor(structuredNotesContentSourceFor({
          metadata: artifacts.metadata,
          structuredNotesMd: artifacts.structuredNotesMd,
          availableVisuals,
        }));
        const xshortShouldSkip = flags.force !== true && await contentCacheHit({
          metadataPath: shortMetadataPath,
          expectation: {
            target: "x-short",
            sourceFingerprint: structuredSourceFingerprint,
            model: llm.model,
            promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
          },
          sourceText: artifacts.structuredNotesMd,
          sourceTitle: artifacts.metadata.title ?? "",
          requiredFiles: [shortPath, shortMetadataPath],
        });
        if (xshortShouldSkip) {
          logger.info({ videoId: artifacts.videoId }, "x-short already exists, skipping");
        } else {
        const result = await generateXShortContent({
          llm: llm.adapter,
          model: llm.model,
          artifacts,
          availableVisuals,
          technicalTermDiscoveryCacheDir: technicalTermDiscoveryCacheDirFor(articleDir),
        });
        const shortMetadata = contentMetadataForResult("x-short", result);
        const written = await writeNativeShortBundle(
          articleOutDir,
          artifacts.videoId,
          result.shortPost,
          {
            force: flags.force === true,
            cacheExpectation: {
              target: "x-short",
              sourceFingerprint: structuredSourceFingerprint,
              model: llm.model,
              promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
              sourceText: artifacts.structuredNotesMd,
              sourceTitle: artifacts.metadata.title ?? "",
              requiredFiles: [shortPath, shortMetadataPath],
            },
            ...(shortMetadata === undefined ? {} : { cacheMetadata: shortMetadata }),
          },
        );
        if (written === null) {
          logger.info({ videoId: artifacts.videoId }, "x-short already exists, skipping");
        } else {
        writtenArtifacts.push("x-short.md");
        articleDirForStatus = written.articleDir;
        resultFile ??= path.basename(written.shortPath);
        addUsage(tokenTotals, result.usage);
        logger.info(
          {
            videoId: result.videoId,
            articleDir: written.articleDir,
            model: result.model,
            finishReason: result.finishReason,
            durationMs: result.durationMs,
            usage: result.usage,
          },
          "article generated (native x short)",
        );
        const shortIssues = checkShortQuality(result.shortPost, {
          sourceText: `${artifacts.metadata.title ?? ""}\n${artifacts.structuredNotesMd}`,
        });
        logQualityIssues("x-short", artifacts.videoId, written.shortPath, shortIssues);
        } // end if (written !== null)
        } // end else (xshortShouldSkip)
      }

      if (outputTargets.includes("x-video-short")) {
        const videoShortPath = path.join(articleOutDir, artifacts.videoId, "x-format", "x-video-short.md");
        const videoShortMetadataPath = contentTargetMetadataPathFor(articleDir, "x-video-short");
        const videoShortSourceFingerprint = contentSourceFingerprintFor(structuredNotesContentSourceFor({
          metadata: artifacts.metadata,
          structuredNotesMd: artifacts.structuredNotesMd,
        }));
        const xvideoshortShouldSkip = flags.force !== true && await contentCacheHit({
          metadataPath: videoShortMetadataPath,
          expectation: {
            target: "x-video-short",
            sourceFingerprint: videoShortSourceFingerprint,
            model: llm.model,
            promptVersion: CONTENT_PROMPT_VERSIONS.xVideoShort,
          },
          sourceText: artifacts.structuredNotesMd,
          sourceTitle: artifacts.metadata.title ?? "",
          requiredFiles: [videoShortPath, videoShortMetadataPath],
        });
        if (xvideoshortShouldSkip) {
          logger.info({ videoId: artifacts.videoId }, "x-video-short already exists, skipping");
        } else {
        const result = await generateXVideoShortContent({
          llm: llm.adapter,
          model: llm.model,
          artifacts,
          availableVisuals: null,
          technicalTermDiscoveryCacheDir: technicalTermDiscoveryCacheDirFor(articleDir),
        });
        const videoShortMetadata = contentMetadataForResult("x-video-short", result);
        const written = await writeNativeVideoShortBundle(
          articleOutDir,
          artifacts.videoId,
          result.videoShortPost,
          {
            force: flags.force === true,
            cacheExpectation: {
              target: "x-video-short",
              sourceFingerprint: videoShortSourceFingerprint,
              model: llm.model,
              promptVersion: CONTENT_PROMPT_VERSIONS.xVideoShort,
              sourceText: artifacts.structuredNotesMd,
              sourceTitle: artifacts.metadata.title ?? "",
              requiredFiles: [videoShortPath, videoShortMetadataPath],
            },
            ...(videoShortMetadata === undefined ? {} : { cacheMetadata: videoShortMetadata }),
          },
        );
        if (written === null) {
          logger.info({ videoId: artifacts.videoId }, "x-video-short already exists, skipping");
        } else {
        writtenArtifacts.push("x-video-short.md");
        articleDirForStatus = written.articleDir;
        resultFile ??= path.basename(written.shortPath);
        addUsage(tokenTotals, result.usage);
        logger.info(
          {
            videoId: result.videoId,
            articleDir: written.articleDir,
            model: result.model,
            finishReason: result.finishReason,
            durationMs: result.durationMs,
            usage: result.usage,
          },
          "article generated (native x video short)",
        );
        } // end if (written !== null)
        } // end else (xvideoshortShouldSkip)
      }

      for (const platformTarget of platformTargets) {
        const platformArticlePath = path.join(
          articleOutDir, artifacts.videoId,
          `${platformTarget}-format`, `${platformTarget}-article.md`,
        );
        const articlePath = path.join(articleOutDir, artifacts.videoId, "article.md");
        sourceArticleMd ??= await readFile(articlePath, "utf8").catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Platform target "${platformTarget}" requires an existing article.md at ${articlePath}. ` +
              `Generate article first with --targets article, or include --targets article in this run. ${message}`,
          );
        });
        const timestampedCuesPath = path.join(videoDir, "timestamped-cues.md");
        const timestampedCuesMd = await readFile(timestampedCuesPath, "utf8").catch(() => undefined);
        const platformSourceText = [artifacts.structuredNotesMd, sourceArticleMd, timestampedCuesMd ?? ""].join("\n");
        const platformSourceFingerprint = contentSourceFingerprintFor(platformArticleContentSourceFor({
          metadata: artifacts.metadata,
          structuredNotesMd: artifacts.structuredNotesMd,
          articleMd: sourceArticleMd,
          timestampedCuesMd: timestampedCuesMd ?? "",
          target: platformTarget,
        }));
        const platformMetadataPath = contentTargetMetadataPathFor(
          articleDir,
          `platform-article-${platformTarget}`,
        );
        if (flags.force !== true) {
          const platformFresh = await contentCacheHit({
            metadataPath: platformMetadataPath,
            expectation: {
              target: `platform-article-${platformTarget}`,
              sourceFingerprint: platformSourceFingerprint,
              model: llm.model,
              promptVersion: CONTENT_PROMPT_VERSIONS.platformArticle,
            },
            sourceText: platformSourceText,
            sourceTitle: artifacts.metadata.title ?? "",
            requiredFiles: [
              platformArticlePath,
              path.join(articleDir, `${platformTarget}-format`, `${platformTarget}-metadata.json`),
              platformMetadataPath,
            ],
          });
          if (platformFresh) {
            logger.info({ videoId: artifacts.videoId, target: platformTarget }, "platform article already exists, skipping");
            continue;
          }
        }
        const result = await generatePlatformArticleContent({
          llm: llm.adapter,
          model: llm.model,
          target: platformTarget,
          artifacts,
          articleMd: sourceArticleMd,
          ...(timestampedCuesMd !== undefined ? { timestampedCuesMd } : {}),
          technicalTermDiscoveryCacheDir: technicalTermDiscoveryCacheDirFor(articleDir),
        });
        const platformMetadata = contentMetadataForResult(`platform-article-${platformTarget}`, result);
        const written = await writePlatformArticleBundle(
          articleOutDir,
          artifacts.videoId,
          result.platformArticle,
          {
            force: flags.force === true,
            cacheExpectation: {
              target: `platform-article-${platformTarget}`,
              sourceFingerprint: platformSourceFingerprint,
              model: llm.model,
              promptVersion: CONTENT_PROMPT_VERSIONS.platformArticle,
              sourceText: platformSourceText,
              sourceTitle: artifacts.metadata.title ?? "",
              requiredFiles: [],
            },
            ...(platformMetadata === undefined ? {} : { cacheMetadata: platformMetadata }),
          },
        );
        if (written === null) {
          logger.info({ videoId: artifacts.videoId, target: platformTarget }, "platform article already exists, skipping");
          continue;
        }
        writtenArtifacts.push(`${platformTarget}-article.md`, `${platformTarget}-metadata.json`);
        articleDirForStatus = written.articleDir;
        resultFile ??= path.basename(written.articlePath);
        addUsage(tokenTotals, result.usage);
        logger.info(
          {
            videoId: result.videoId,
            target: platformTarget,
            articleDir: written.articleDir,
            model: result.model,
            finishReason: result.finishReason,
            durationMs: result.durationMs,
            usage: result.usage,
          },
          "article generated (native platform adaptation)",
        );
      }

      if (writtenArtifacts.length === 0) {
        logger.info(
          { videoId: artifacts.videoId },
          "article stage: all targets already exist, nothing new written",
        );
        continue;
      }

      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - t0;
      await patchProcessStatus(videoDir, identity, {
        step: "article",
        stepInfo: {
          status: "done",
          artifacts: writtenArtifacts,
          finishedAt,
          durationMs,
          resultFile,
        },
      }).catch(() => {});

      exitCode = 0;
      logger.info(
        {
          videoId: artifacts.videoId,
          articleDir: articleDirForStatus,
          durationMs: Date.now() - stageT0,
          artifacts: writtenArtifacts,
        },
        "article stage finished",
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ videoDir, message });
      logger.error({ videoDir, err: message }, "article stage failed");
      if (isLlmError(err)) {
        await patchLlmStepFailed(videoDir, "article", err).catch(() => {});
        exitCode = exitFromLlmKind(err.kind);
        if (flags.errorStrategy !== "skip") break;
      } else if (flags.errorStrategy !== "skip") {
        exitCode = 1;
        break;
      }
    } finally {
      // no-op: error handling above is self-contained
    }
  }

  if (errors.length > 0 && exitCode === 0) {
    exitCode = 1;
  }
  if (errors.length > 0) {
    logger.error({ count: errors.length }, "article completed with errors");
  }

  if (exitCode === 0) {
    progress?.printSummary();
  } else {
    progress?.clear();
  }
  return exitCode;
};
