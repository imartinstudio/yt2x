import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_OUT_DIR,
  NoCredentialsError,
  NoRefreshTokenError,
  assertArticleDraftImagesExist,
  createTokenSource,
  createTokenStore,
  createXArticlesDraftAdapter,
  createXPublishAdapter,
  defaultCredentialsPath,
  findArticleArtifacts,
  findCoverImage,
  isValidVideoId,
  loadTweetImageFromPath,
  materializeArticleDraftAdaptations,
  parseArticleDraftMarkdown,
  patchProcessStatus,
  patchStepRunning,
  readYoutubePageUrl,
} from "@yt2x/adapters-node";
import type { ThreadVisualItem, ShortVisualItem } from "@yt2x/core";
import {
  XAuthError,
  XArticleSubscriptionTierSchema,
  adaptArticleForX,
  articleToLongPost,
  articleToThread,
  isXPublishError,
  prepareTextForXPublish,
  tweetLength,
  type PostThreadResult,
} from "@yt2x/core";
import { logger } from "../logger.js";
import type { SingleStageFlags } from "../commands/command-flags.js";
import { printCliErrorBlock } from "../diagnostics/error-format.js";
import { createCommandProgress } from "../progress/pipeline-progress.js";
import { NATIVE_EXIT, resolveArticleOutRoot } from "./native-stage-common.js";

export type PublishFlags = SingleStageFlags & {
  publishDryRun?: boolean;
  videoId?: string;
  articleOutDir?: string;
  articleDir?: string;
  profile?: string;
  maxChars?: string;
  publishMaxChars?: string;
  maxTweets?: string;
  threadDelay?: string;
  /** 发布目标；默认 article 只预览；--thread 兼容旧串推行为 */
  target?: string;
  /** x-thread 来源；generated=x-thread.md，article=article.md 机械切分，auto=优先 generated */
  threadSource?: string;
  /** 串推模式；默认 false = 单条长文 */
  thread?: boolean;
  numbering?: boolean;
  continueOnFailure?: boolean;
  dryRun?: boolean;
  showProgress?: boolean;
  /** Premium 账号支持更长单帖（article / x-short）；默认 false = 普通账号上限 280 */
  premium?: boolean;
  /** 把 article.md 写入 X Articles 草稿编辑器，而不是调用 X API。 */
  browserDraft?: boolean;
  /** X Articles 订阅档位，影响 article_for_x.md 适配。 */
  xSubscription?: string;
  /** Playwright persistent context 用户目录。 */
  browserProfileDir?: string;
  /** Playwright 有头模式默认值为 false。 */
  headless?: boolean;
};

const EXIT_CONFIG_MISSING = NATIVE_EXIT.CONFIG_MISSING;
const EXIT_AUTH = NATIVE_EXIT.LLM_AUTH;
const EXIT_PARTIAL = NATIVE_EXIT.PARTIAL_FAILURE;
const EXIT_RATE_LIMITED = 7;
const EXIT_SERVER = 8;
const DEFAULT_THREAD_REPLY_DELAY_MS = { min: 20_000, max: 30_000 } as const;

const exitFromPublishKind = (kind: string): number => {
  if (kind === "AUTH" || kind === "FORBIDDEN") return EXIT_AUTH;
  if (kind === "RATE_LIMITED") return EXIT_RATE_LIMITED;
  if (kind === "SERVER") return EXIT_SERVER;
  return 1;
};

const parsePositiveInt = (raw: string | undefined, fallback: number, label: string): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid --${label}: "${raw}" (expected positive integer)`);
  }
  return n;
};

const parseMaxTweets = (raw: string | undefined, fallback: number): number => {
  const n = parsePositiveInt(raw, fallback, "max-tweets");
  if (n > 10) {
    throw new Error(`Invalid --max-tweets: "${String(raw ?? n)}" (expected integer between 1 and 10)`);
  }
  return n;
};

const parseThreadDelayMs = (raw: string | undefined): { min: number; max: number } => {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_THREAD_REPLY_DELAY_MS;
  const normalized = raw.trim();
  const match = /^(\d+)(?:-(\d+))?$/u.exec(normalized);
  if (match === null) {
    throw new Error(`Invalid --thread-delay: "${raw}" (expected seconds or range like 20-30)`);
  }
  const minSeconds = Number.parseInt(match[1]!, 10);
  const maxSeconds = match[2] === undefined ? minSeconds : Number.parseInt(match[2], 10);
  if (maxSeconds < minSeconds) {
    throw new Error(`Invalid --thread-delay: "${raw}" (range end must be greater than or equal to start)`);
  }
  return { min: minSeconds * 1000, max: maxSeconds * 1000 };
};

type PublishTarget = "article" | "x-thread" | "x-short" | "x-thread-short";
type ThreadSource = "generated" | "article" | "auto";
type PublishMode = "article" | "thread" | "short" | "thread-short";

const THREAD_ITEM_START_RE = /^[ \t]*(?:\d+\/|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])(?:[ \t]|$)/u;

const parseGeneratedThreadMarkdown = (raw: string): string[] => {
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ") && current.length === 0) continue;

    if (THREAD_ITEM_START_RE.test(line)) {
      if (current.length > 0) blocks.push(current.join("\n").trim());
      current = [line.trimStart()];
      continue;
    }

    if (current.length > 0) current.push(line);
  }

  if (current.length > 0) blocks.push(current.join("\n").trim());
  if (blocks.length > 0) return blocks;

  return raw
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith("# "));
};

const parsePublishTarget = (raw: string | undefined, legacyThreadMode: boolean): PublishTarget => {
  if (raw === undefined) return legacyThreadMode ? "x-thread" : "article";
  if (raw === "article" || raw === "x-thread" || raw === "x-short" || raw === "x-thread-short") return raw;
  if (raw === "x-longform") return "article";
  throw new Error(`Invalid --target: "${raw}" (expected article, x-thread, x-short, or x-thread-short)`);
};

const publishModeForTarget = (target: PublishTarget): PublishMode => {
  if (target === "article") return "article";
  if (target === "x-thread") return "thread";
  if (target === "x-short") return "short";
  return "thread-short";
};

const parseThreadSource = (raw: string | undefined): ThreadSource => {
  if (raw === undefined) return "generated";
  if (raw === "generated" || raw === "article" || raw === "auto") return raw;
  throw new Error(`Invalid --thread-source: "${raw}" (expected generated, article, or auto)`);
};

type VideoAssetsInfo = {
  videoFile: string;
  subtitleFile?: string;
  burnedVideoFile?: string;
  /** v2: bilingual subtitle SRT asset */
  bilingualSubtitleFile?: string;
  /** v2: bilingual subtitle ASS asset */
  bilingualAssFile?: string;
  /** v2: burned bilingual video asset */
  bilingualBurnedVideoFile?: string;
  recommendedUploadMode: "video_with_srt" | "burned_video" | "bilingual_burned_video" | "video_only";
};

const resolveVideoAssets = async (articleDir: string): Promise<VideoAssetsInfo | null> => {
  const videoDir = path.join(articleDir, "video");
  // Prefer clip.mp4 (clipped video), fall back to full.mp4 (full download).
  // The full-video workflow produces full.mp4 + bilingual burned assets
  // without a clip.mp4.
  const clipFile = path.join(videoDir, "clip.mp4");
  const fullFile = path.join(videoDir, "full.mp4");
  let videoFile = clipFile;
  let videoRelPath = "video/clip.mp4";
  try {
    await access(videoFile);
  } catch {
    try {
      await access(fullFile);
      videoFile = fullFile;
      videoRelPath = "video/full.mp4";
    } catch {
      return null;
    }
  }

  const subtitleFile = path.join(videoDir, "full.zh.srt");
  const burnedFile = path.join(videoDir, "full.zh-burned.mp4");
  const bilingualBurnedFile = path.join(videoDir, "full.bilingual-burned.mp4");
  const bilingualSrtFile = path.join(videoDir, "full.bilingual.srt");
  const bilingualAssFile = path.join(videoDir, "full.bilingual.ass");

  let hasSubtitle = false;
  let hasBurned = false;
  let hasBilingualBurned = false;
  let hasBilingualSrt = false;
  let hasBilingualAss = false;

  try { await access(subtitleFile); hasSubtitle = true; } catch { /* */ }
  try { await access(burnedFile); hasBurned = true; } catch { /* */ }
  try { await access(bilingualBurnedFile); hasBilingualBurned = true; } catch { /* */ }
  try { await access(bilingualSrtFile); hasBilingualSrt = true; } catch { /* */ }
  try { await access(bilingualAssFile); hasBilingualAss = true; } catch { /* */ }

  // Priority: bilingual burned > zh burned > video + zh srt > video only
  const recommendedUploadMode: VideoAssetsInfo["recommendedUploadMode"] =
    hasBilingualBurned
      ? "bilingual_burned_video"
      : hasBurned
        ? "burned_video"
        : hasSubtitle
          ? "video_with_srt"
          : "video_only";

  return {
    videoFile: videoRelPath,
    ...(hasSubtitle ? { subtitleFile: "video/full.zh.srt" } : {}),
    ...(hasBurned ? { burnedVideoFile: "video/full.zh-burned.mp4" } : {}),
    ...(hasBilingualBurned ? { bilingualBurnedVideoFile: "video/full.bilingual-burned.mp4" } : {}),
    ...(hasBilingualSrt ? { bilingualSubtitleFile: "video/full.bilingual.srt" } : {}),
    ...(hasBilingualAss ? { bilingualAssFile: "video/full.bilingual.ass" } : {}),
    recommendedUploadMode,
  };
};

const buildPublishTexts = (
  articleContent: string,
  opts: { threadMode: boolean; maxChars: number; maxTweets: number; numbering: boolean },
): string[] => {
  if (opts.threadMode) {
    return articleToThread(articleContent, {
      maxChars: opts.maxChars,
      maxTweets: opts.maxTweets,
      ...(opts.numbering ? { numbering: true } : {}),
    });
  }
  const longPost = articleToLongPost(articleContent, { maxChars: opts.maxChars });
  return longPost.length > 0 ? [longPost] : [];
};

const resolveArticleDirForTarget = (flags: PublishFlags, articleRootDir: string): string =>
  flags.articleDir !== undefined ? path.resolve(flags.articleDir) : path.resolve(articleRootDir, flags.videoId!);

const loadGeneratedThreadTexts = async (
  articleDir: string,
  maxTweets: number,
  maxChars: number,
): Promise<{ texts: string[]; source: "x-thread.md" }> => {
  const threadPath = path.join(articleDir, "x-format", "x-thread.md");
  const raw = await readFile(threadPath, "utf8");
  const texts = parseGeneratedThreadMarkdown(raw)
    .map((block) => block.trim())
    .map((block) => prepareTextForXPublish(block, { orderedListStyle: "circled" }))
    .filter((block) => block.length > 0)
    .slice(0, maxTweets);
  if (texts.length === 0) {
    throw new Error(`${threadPath} did not contain any publishable tweets.`);
  }
  const tooLongIndex = texts.findIndex((text) => tweetLength(text) > maxChars);
  if (tooLongIndex >= 0) {
    throw new Error(
      `${threadPath} tweet #${tooLongIndex + 1} exceeds ${maxChars} weighted characters. Regenerate x-thread.md so long source paragraphs are compressed or merged instead of truncated.`,
    );
  }
  return { texts, source: "x-thread.md" };
};

const loadGeneratedShortText = async (articleDir: string): Promise<{ texts: string[]; source: "x-short.md" }> => {
  const shortPath = path.join(articleDir, "x-format", "x-short.md");
  const raw = await readFile(shortPath, "utf8");
  const text = prepareTextForXPublish(raw, { orderedListStyle: "decimal" });
  if (text.length === 0) {
    throw new Error(`${shortPath} did not contain a publishable short post.`);
  }
  return { texts: [text], source: "x-short.md" };
};

const appendDownPointingEmoji = (text: string): string => {
  const trimmed = text.trimEnd();
  return trimmed.endsWith("👇") ? trimmed : `${trimmed}👇`;
};

const loadThreadVisualPlans = async (
  articleDir: string,
): Promise<ThreadVisualItem[]> => {
  const visualsPath = path.join(articleDir, "x-format", "x-thread-visuals.json");
  try {
    const raw = await readFile(visualsPath, "utf8");
    const parsed = JSON.parse(raw) as { visuals?: ThreadVisualItem[] };
    return parsed.visuals ?? [];
  } catch {
    return [];
  }
};

const loadShortVisualPlan = async (
  articleDir: string,
): Promise<ShortVisualItem | null> => {
  const visualPath = path.join(articleDir, "x-format", "x-short-visual.json");
  try {
    const raw = await readFile(visualPath, "utf8");
    const parsed = JSON.parse(raw) as { visual?: ShortVisualItem };
    return parsed.visual ?? null;
  } catch {
    return null;
  }
};

const loadVisualMediaIds = async (
  articleDir: string,
  notesVideoDir: string,
  adapter: ReturnType<typeof createXPublishAdapter>,
  scopes: string[],
): Promise<Map<string, string>> => {
  const mediaMap = new Map<string, string>();
  if (!scopes.includes("media.write")) return mediaMap;

  // 加载所有视觉计划文件
  const threadVisuals = await loadThreadVisualPlans(articleDir);
  const shortVisual = await loadShortVisualPlan(articleDir);

  const allVisualIds = new Set<string>();
  for (const v of threadVisuals) allVisualIds.add(v.visual_id);
  if (shortVisual !== null) allVisualIds.add(shortVisual.visual_id);

  for (const visualId of allVisualIds) {
    // 尝试找到对应的截图文件
    const screenshotsDir = path.join(notesVideoDir, "screenshots");
    try {
      const files = await readdir(screenshotsDir);
      const match = files.find((f) => f.startsWith(visualId.replace("scene_", "scene_")));
      if (match !== undefined) {
        const imagePath = path.join(screenshotsDir, match);
        const image = await loadTweetImageFromPath(imagePath);
        const mediaId = await adapter.uploadTweetImage(image);
        mediaMap.set(visualId, mediaId);
        logger.info({ visualId, mediaId, imagePath }, "Visual image uploaded");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ visualId, err: message }, "Visual image upload failed; continuing text-only");
    }
  }
  return mediaMap;
};

const pushMediaId = (target: Record<number, string[]>, index: number, mediaId: string): void => {
  const existing = target[index] ?? [];
  if (existing.length >= 4) return;
  target[index] = [...existing, mediaId];
};

export const buildThreadTweetMediaIds = (
  threadVisuals: ThreadVisualItem[],
  visualMediaMap: Map<string, string>,
  opts: { offset: number; tweetCount: number },
): Record<number, string[]> => {
  const tweetMediaIds: Record<number, string[]> = {};
  for (const visual of threadVisuals) {
    const index = visual.tweet_index + opts.offset;
    if (index < 0 || index >= opts.tweetCount) continue;
    const mediaId = visualMediaMap.get(visual.visual_id);
    if (mediaId !== undefined) pushMediaId(tweetMediaIds, index, mediaId);
  }
  return tweetMediaIds;
};

const previewVisualPlans = (
  articleDir: string,
  threadVisuals: ThreadVisualItem[],
  shortVisual: ShortVisualItem | null,
  threadMode: boolean,
): void => {
  if (threadMode && threadVisuals.length > 0) {
    process.stdout.write(`\n── 配图计划（${threadVisuals.length} 张）──\n`);
    for (const v of threadVisuals) {
      process.stdout.write(`  Tweet #${v.tweet_index + 1}: ${v.visual_id} — ${v.caption}\n`);
    }
    process.stdout.write("\n");
  }
  if (!threadMode && shortVisual !== null) {
    process.stdout.write(
      `\n── 配图计划：${shortVisual.visual_id} — ${shortVisual.caption}\n\n`,
    );
  }
};


const previewPublishTexts = (
  texts: string[],
  mode: PublishMode,
  sourceReplyText: string | null,
): void => {
  if (mode === "thread-short") {
    const head = texts[0] ?? "";
    const replies = texts.slice(1);
    process.stdout.write(
      `\n── X thread-short 首推（加权字数 ${tweetLength(head)} / ${head.length} 字符）──\n${head}\n`,
    );
    for (let i = 0; i < replies.length; i += 1) {
      process.stdout.write(`\n── Reply ${i + 1}/${replies.length} ──\n${replies[i]!}\n`);
    }
    if (sourceReplyText !== null) {
      process.stdout.write(`\n── 来源回复 ──\n${sourceReplyText}\n`);
    }
    process.stdout.write("\n");
    return;
  }
  if (mode === "thread") {
    for (let i = 0; i < texts.length; i += 1) {
      process.stdout.write(`\n── Tweet ${i + 1}/${texts.length} ──\n${texts[i]!}\n`);
    }
    if (sourceReplyText !== null) {
      process.stdout.write(`\n── 来源回复 ──\n${sourceReplyText}\n`);
    }
    process.stdout.write("\n");
    return;
  }
  const body = texts[0] ?? "";
  if (mode === "article") {
    process.stdout.write(
      `\n── Article 预览（${body.length} 字符）──\n${body}\n\n`,
    );
    return;
  }
  process.stdout.write(
    `\n── X short post 预览（加权字数 ${tweetLength(body)} / ${body.length} 字符）──\n${body}\n`,
  );
  if (sourceReplyText !== null) {
    process.stdout.write(`\n── 来源回复 ──\n${sourceReplyText}\n`);
  }
  process.stdout.write("\n");
};

/** 供 `pipeline` 编排器与 `yt2x publish` 调用；返回进程退出码。 */
export const executeNativePublish = async (flags: PublishFlags): Promise<number> => {
  if (flags.videoId === undefined || flags.videoId.length === 0) {
    printCliErrorBlock({
      command: "publish",
      reason: "Missing required option: --video-id <id>.",
      hints: ["Publish needs an article target under files/articles/<videoId>/."],
      retryCommand: "pnpm yt2x publish --video-id <videoId> --dry-run",
    });
    return EXIT_CONFIG_MISSING;
  }
  if (!isValidVideoId(flags.videoId)) {
    printCliErrorBlock({
      command: "publish",
      subject: flags.videoId,
      reason: "Invalid --video-id. Expected alphanumeric, hyphens, and underscores only.",
      hints: ["Use a video directory name, not a path."],
      retryCommand: "pnpm yt2x publish --video-id <videoId> --dry-run",
    });
    return EXIT_CONFIG_MISSING;
  }

  const articleRootDir = resolveArticleOutRoot(flags, DEFAULT_ARTICLE_OUT_DIR);
  await mkdir(articleRootDir, { recursive: true });

  // Ensure x-* files are migrated into x-format/ before reading (idempotent)
  const { migrateXFilesToFormatDir } = await import("../commands/migrate-x-files.js");
  await migrateXFilesToFormatDir(articleRootDir);

  const profile = flags.profile ?? "default";
  let publishTarget: PublishTarget;
  let threadSource: ThreadSource;
  try {
    publishTarget = parsePublishTarget(flags.target, flags.thread === true);
    threadSource = parseThreadSource(flags.threadSource);
  } catch (err: unknown) {
    printCliErrorBlock({
      command: "publish",
      subject: flags.videoId,
      reason: err instanceof Error ? err.message : String(err),
      hints: ["Use --target article, --target x-thread, --target x-short, or --target x-thread-short."],
      retryCommand: `pnpm yt2x publish --video-id ${flags.videoId} --target article --dry-run`,
    });
    return EXIT_CONFIG_MISSING;
  }
  const isDryRun = flags.dryRun === true || flags.publishDryRun === true;
  if (publishTarget === "article" && !isDryRun && flags.browserDraft !== true) {
    printCliErrorBlock({
      command: "publish",
      subject: flags.videoId,
      reason: "X Articles have no API publish path. Use browser-draft or preview the article output.",
      hints: [
        "Use --browser-draft to save article.md into the X Articles editor without publishing it.",
        "Use --dry-run to preview article.md without publishing.",
        "Use --target x-thread, --target x-short, or --target x-thread-short for X API publishing.",
      ],
      retryCommand: `pnpm yt2x publish --video-id ${flags.videoId} --target article --dry-run`,
    });
    return EXIT_CONFIG_MISSING;
  }
  const publishMode = publishModeForTarget(publishTarget);
  const threadMode = publishMode === "thread";
  const threadLikeMode = publishMode === "thread" || publishMode === "thread-short";
  let maxChars: number;
  let maxTweets: number;
  let threadDelayMs: { min: number; max: number } = DEFAULT_THREAD_REPLY_DELAY_MS;
  try {
    const defaultMax = flags.premium ? 4000 : 280;
    maxChars = parsePositiveInt(flags.publishMaxChars ?? flags.maxChars, defaultMax, "max-chars");
    maxTweets = threadLikeMode ? parseMaxTweets(flags.maxTweets, publishMode === "thread-short" ? 10 : 8) : 1;
    if (threadLikeMode) threadDelayMs = parseThreadDelayMs(flags.threadDelay);
  } catch (err: unknown) {
    printCliErrorBlock({
      command: "publish",
      subject: flags.videoId,
      reason: err instanceof Error ? err.message : String(err),
      hints: [
        "Use --max-tweets between 1 and 10. Default is 8 for x-thread and 10 for x-thread-short.",
        "Use --thread-delay seconds or a range like 20-30; use 0 to disable waiting.",
      ],
    });
    return EXIT_CONFIG_MISSING;
  }

  let articleDirForStatus = resolveArticleDirForTarget(flags, articleRootDir);
  let coverPath: string | null = null;
  let source = "article.md";
  let texts: string[];
  try {
    const findInput: Parameters<typeof findArticleArtifacts>[0] = {
      videoId: flags.videoId,
      articleRootDir,
    };
    if (flags.articleDir !== undefined) findInput.articleDir = flags.articleDir;
    if (publishTarget === "article") {
      const artifacts = await findArticleArtifacts(findInput);
      articleDirForStatus = artifacts.articleDir;
      coverPath = artifacts.coverPath;
      const raw = artifacts.articleContent.trim();
      const prepared = prepareTextForXPublish(raw);
      texts = prepared.length > 0 ? [prepared] : [];
    } else if (publishTarget === "x-short") {
      const loaded = await loadGeneratedShortText(articleDirForStatus);
      source = loaded.source;
      texts = loaded.texts;
      coverPath = await findCoverImage(articleDirForStatus);
    } else if (publishTarget === "x-thread-short") {
      const short = await loadGeneratedShortText(articleDirForStatus);
      const thread = await loadGeneratedThreadTexts(articleDirForStatus, maxTweets, maxChars);
      source = `${short.source} + ${thread.source}`;
      texts = [appendDownPointingEmoji(short.texts[0]!), ...thread.texts];
      coverPath = await findCoverImage(articleDirForStatus);
    } else if (threadSource === "generated") {
      const loaded = await loadGeneratedThreadTexts(articleDirForStatus, maxTweets, maxChars);
      source = loaded.source;
      texts = loaded.texts;
    } else if (threadSource === "auto") {
      try {
        const loaded = await loadGeneratedThreadTexts(articleDirForStatus, maxTweets, maxChars);
        source = loaded.source;
        texts = loaded.texts;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const artifacts = await findArticleArtifacts(findInput);
        articleDirForStatus = artifacts.articleDir;
        coverPath = artifacts.coverPath;
        source = "article.md";
        texts = buildPublishTexts(artifacts.articleContent, {
          threadMode: true,
          maxChars,
          maxTweets,
          numbering: flags.numbering === true,
        });
      }
    } else {
      const artifacts = await findArticleArtifacts(findInput);
      articleDirForStatus = artifacts.articleDir;
      coverPath = artifacts.coverPath;
      source = "article.md";
      texts = buildPublishTexts(artifacts.articleContent, {
        threadMode: true,
        maxChars,
        maxTweets,
        numbering: flags.numbering === true,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    printCliErrorBlock({
      command: "publish",
      subject: flags.videoId,
      reason: message,
      details: articleRootDir,
      hints: ["Generate the requested target first, or pass --article-dir if it lives elsewhere."],
      retryCommand: `pnpm yt2x article --video-id ${flags.videoId} --targets ${publishTarget}`,
    });
    return EXIT_CONFIG_MISSING;
  }

  if (texts.length === 0) {
    printCliErrorBlock({
      command: "publish",
      subject: flags.videoId,
      reason: "Selected target produced an empty publish body.",
      details: articleDirForStatus,
      hints: ["Check the generated target file and regenerate it if needed."],
      retryCommand: `pnpm yt2x article --video-id ${flags.videoId} --targets ${publishTarget} --force`,
    });
    return EXIT_CONFIG_MISSING;
  }

  const youtubeVideoDir = path.join(path.resolve(flags.outDir ?? DEFAULT_OUT_DIR), flags.videoId);
  const pageUrl = await readYoutubePageUrl(youtubeVideoDir, flags.videoId);
  const sourceReplyText = null;

  if (isDryRun) {
    // 加载视觉计划用于预览
    const threadVisuals = threadLikeMode ? await loadThreadVisualPlans(articleDirForStatus) : [];
    const shortVisual =
      publishTarget === "x-short" || publishTarget === "x-thread-short"
        ? await loadShortVisualPlan(articleDirForStatus)
        : null;

    logger.info(
      {
        articleDir: articleDirForStatus,
        format: publishMode,
        source,
        parts: texts.length,
        coverPath,
        maxChars,
        ...(threadLikeMode ? { threadDelayMs } : {}),
        ...(threadVisuals.length > 0 ? { threadVisuals: threadVisuals.length } : {}),
        ...(shortVisual !== null ? { shortVisual: shortVisual.visual_id } : {}),
      },
      publishMode === "short"
        ? "yt2x publish (native) --dry-run: short preview below"
        : threadLikeMode
          ? "yt2x publish (native) --dry-run: thread preview below"
          : "yt2x publish (native) --dry-run: article preview below",
    );
    previewPublishTexts(texts, publishMode, sourceReplyText);
    previewVisualPlans(articleDirForStatus, threadVisuals, shortVisual, threadLikeMode);
    if (coverPath !== null) {
      logger.info(
        { coverPath },
        "Dry-run: cover would be uploaded on real publish (requires media.write).",
      );
    }
    const previewFile = path.join(articleDirForStatus, "x-format", "publish-preview.json");

    const videoAssets = await resolveVideoAssets(articleDirForStatus);

    const payload = {
      profile,
      format: publishMode,
      mode: publishMode,
      source,
      maxChars,
      maxTweets,
      coverPath,
      ...(threadLikeMode ? { threadDelayMs } : {}),
      ...(threadMode ? { tweets: texts } : {}),
      ...(publishMode === "thread-short" ? { text: texts[0] ?? "", replies: texts.slice(1), tweets: texts } : {}),
      ...(publishTarget === "x-short" || publishTarget === "article" ? { text: texts[0] ?? "" } : {}),
      ...(sourceReplyText !== null ? { sourceReply: sourceReplyText } : {}),
      ...(videoAssets !== null ? { videoAssets } : {}),
      parts: texts.map((text, index) => ({
        index,
        text,
        weightedLength: tweetLength(text),
        charLength: text.length,
      })),
      previewedAt: new Date().toISOString(),
    };
    await writeFile(previewFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await patchProcessStatus(
      youtubeVideoDir,
      { videoId: flags.videoId, url: pageUrl },
      {
        step: "publish",
        stepInfo: {
          status: "done",
          finishedAt: payload.previewedAt,
          artifacts: ["publish-preview.json"],
          resultFile: path.basename(previewFile),
        },
        articleOutDir: articleDirForStatus,
      },
    ).catch(() => {});
    return 0;
  }

  if (publishTarget === "article" && flags.browserDraft === true) {
    const subscription = XArticleSubscriptionTierSchema.safeParse(flags.xSubscription ?? "premium");
    if (!subscription.success) {
      printCliErrorBlock({
        command: "publish",
        subject: flags.videoId,
        reason: `Invalid --x-subscription: "${flags.xSubscription ?? ""}" (expected premium or premium-plus).`,
        hints: ["Use --x-subscription premium unless the X account has Premium+ article formatting support."],
      });
      return EXIT_CONFIG_MISSING;
    }
    try {
      const adapted = await materializeArticleDraftAdaptations({
        adapted: adaptArticleForX({
          markdown: await readFile(path.join(articleDirForStatus, "article.md"), "utf8"),
          subscriptionTier: subscription.data,
          sourceVideoUrl: pageUrl,
        }),
        articleDir: articleDirForStatus,
      });
      const adaptedPath = path.join(articleDirForStatus, "x-format", "article_for_x.md");
      await writeFile(adaptedPath, adapted.markdown, "utf8");
      const parseResult = parseArticleDraftMarkdown(adapted.markdown, articleDirForStatus, coverPath);
      await assertArticleDraftImagesExist(parseResult);
      await patchStepRunning(
        youtubeVideoDir,
        { videoId: flags.videoId, url: pageUrl },
        "publish",
        { articleOutDir: articleDirForStatus },
      ).catch(() => {});
      const saved = await createXArticlesDraftAdapter().saveDraft({
        parseResult,
        articleDir: articleDirForStatus,
        ...(flags.browserProfileDir !== undefined ? { browserProfileDir: flags.browserProfileDir } : {}),
        ...(flags.headless !== undefined ? { headless: flags.headless } : {}),
      });
      const resultFile = path.join(articleDirForStatus, "x-format", "publish-result.json");
      const payload = {
        profile,
        mode: "article-draft",
        source,
        adaptedSource: path.basename(adaptedPath),
        subscriptionTier: subscription.data,
        draftSavedAt: saved.draftSavedAt,
        ...(saved.editorUrl !== undefined ? { editorUrl: saved.editorUrl } : {}),
        warnings: [...adapted.warnings, ...saved.warnings],
        adaptations: adapted.adaptations,
      };
      await writeFile(resultFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await patchProcessStatus(
        youtubeVideoDir,
        { videoId: flags.videoId, url: pageUrl },
        {
          step: "publish",
          stepInfo: {
            status: "done",
            finishedAt: payload.draftSavedAt,
            artifacts: [path.basename(adaptedPath), path.basename(resultFile)],
            resultFile: path.basename(resultFile),
          },
          articleOutDir: articleDirForStatus,
        },
      ).catch(() => {});
      logger.info({ articleDir: articleDirForStatus, resultFile }, "X Article draft saved in browser");
      return 0;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printCliErrorBlock({
        command: "publish",
        subject: flags.videoId,
        reason: message,
        hints: [
          "Use a logged-in X Premium browser profile and keep the editor open for browser-draft automation.",
          "Run --dry-run first if the adapted article or article images need inspection.",
        ],
      });
      return 1;
    }
  }

  const store = createTokenStore();
  const tokenSource = createTokenSource({ store, profile });

  let scopes: string[];
  try {
    scopes = await tokenSource.getScopes();
  } catch (err: unknown) {
    if (err instanceof NoCredentialsError) {
      printCliErrorBlock({
        command: "publish",
        subject: flags.videoId,
        reason: err.message,
        hints: ["Log in to X before publishing."],
        retryCommand: "pnpm yt2x auth login",
      });
      return EXIT_CONFIG_MISSING;
    }
    throw err;
  }

  if (!scopes.includes("tweet.write")) {
    printCliErrorBlock({
      command: "publish",
      subject: flags.videoId,
      reason: 'Stored token lacks "tweet.write" scope.',
      details: defaultCredentialsPath(),
      hints: ["Re-login to grant tweet.write before publishing."],
      retryCommand: "pnpm yt2x auth login",
    });
    return EXIT_AUTH;
  }
  if (coverPath !== null && !scopes.includes("media.write")) {
    logger.warn(
      { coverPath, scopes },
      'Cover image found, but token lacks "media.write" scope. Re-login with `yt2x auth login --scope media.write` to attach the cover image.',
    );
  }

  const progress = flags.showProgress === false ? undefined : createCommandProgress("publish");
  const progressT0 = performance.now();
  progress?.setActive(`publish · ${flags.videoId}`);

  const adapter = createXPublishAdapter({ tokenSource });

  let user;
  try {
    user = await tokenSource.getStored();
  } catch {
    user = null;
  }

  logger.info(
    {
      profile,
      handle: user?.user?.username,
      format: publishMode,
      parts: texts.length,
      articleDir: articleDirForStatus,
    },
    threadLikeMode ? "yt2x publish (native): posting thread" : "yt2x publish (native): posting short post",
  );

  const publishT0 = Date.now();
  await patchStepRunning(
    youtubeVideoDir,
    { videoId: flags.videoId, url: pageUrl },
    "publish",
    { articleOutDir: articleDirForStatus },
  ).catch(() => {});

  try {
    const threadVisuals = threadLikeMode ? await loadThreadVisualPlans(articleDirForStatus) : [];
    const shortVisual =
      publishTarget === "x-short" || publishTarget === "x-thread-short"
        ? await loadShortVisualPlan(articleDirForStatus)
        : null;

    // 上传视觉配图（x-thread-visuals.json / x-short-visual.json）
    const visualMediaMap = await loadVisualMediaIds(
      articleDirForStatus,
      youtubeVideoDir,
      adapter,
      scopes,
    );

    let firstMediaId: string | null = null;
    if (coverPath !== null && scopes.includes("media.write")) {
      try {
        const image = await loadTweetImageFromPath(coverPath);
        firstMediaId = await adapter.uploadTweetImage(image);
        logger.info({ mediaId: firstMediaId, coverPath }, "Cover uploaded");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ coverPath, err: message }, "Cover upload failed; aborting publish");
        throw new Error(`Cover image upload failed for ${coverPath}: ${message}`);
      }
    }

    const firstTweetMediaIds: string[] = [];
    if (firstMediaId !== null) firstTweetMediaIds.push(firstMediaId);
    if (shortVisual !== null) {
      const mediaId = visualMediaMap.get(shortVisual.visual_id);
      if (mediaId !== undefined && firstTweetMediaIds.length < 4) firstTweetMediaIds.push(mediaId);
    }
    const tweetMediaIds = buildThreadTweetMediaIds(threadVisuals, visualMediaMap, {
      offset: publishMode === "thread-short" ? 1 : 0,
      tweetCount: texts.length,
    });

    let result: PostThreadResult;
    if (threadLikeMode) {
      result = await adapter.postThread({
        tweets: texts,
        ...(firstTweetMediaIds.length > 0 ? { firstTweetMediaIds } : {}),
        ...(Object.keys(tweetMediaIds).length > 0 ? { tweetMediaIds } : {}),
        replyDelayMs: threadDelayMs,
        ...(flags.continueOnFailure === true ? { continueOnFailure: true } : {}),
      });
    } else {
      const mediaIds: string[] = [...firstTweetMediaIds];
      const tweet = await adapter.postTweet({
        text: texts[0]!,
        ...(mediaIds.length > 0 ? { mediaIds } : {}),
      });
      result = {
        tweets: [tweet],
        threadUrl: `https://x.com/i/status/${tweet.id}`,
      };
    }

    const sourceReplyParent = result.tweets.at(-1);
    const sourceReplyTweet =
      sourceReplyText !== null && sourceReplyParent !== undefined
        ? await adapter.postTweet({
            text: sourceReplyText,
            replyToTweetId: sourceReplyParent.id,
          })
        : null;

    const resultFile = path.join(articleDirForStatus, "x-format", "publish-result.json");
    const payload = {
      profile,
      handle: user?.user?.username ?? null,
      format: publishMode,
      ...(result.threadUrl !== undefined ? { threadUrl: result.threadUrl } : {}),
      firstMediaId,
      tweets: result.tweets.map((t) => ({ id: t.id, text: t.text })),
      sourceReply:
        sourceReplyTweet !== null
          ? { id: sourceReplyTweet.id, text: sourceReplyTweet.text, inReplyToTweetId: sourceReplyParent!.id }
          : null,
      partialFailure: result.partialFailure ?? null,
      publishedAt: new Date().toISOString(),
    };
    await writeFile(resultFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const publishFinishedAt = new Date().toISOString();
    const publishDurationMs = Date.now() - publishT0;
    try {
      await patchProcessStatus(
        youtubeVideoDir,
        { videoId: flags.videoId, url: pageUrl },
        {
          step: "publish",
          stepInfo: {
            status: "done",
            finishedAt: publishFinishedAt,
            durationMs: publishDurationMs,
            artifacts: ["publish-result.json"],
            resultFile: path.basename(resultFile),
          },
          ...(result.threadUrl !== undefined ? { threadUrl: result.threadUrl } : {}),
          articleOutDir: articleDirForStatus,
        },
      );
    } catch {
      // 状态写入失败不阻断已成功发帖
    }

    if (result.partialFailure !== undefined) {
      progress?.clear();
      logger.warn(
        {
          ok: result.tweets.length,
          totalPlanned: texts.length,
          atIndex: result.partialFailure.atIndex,
          message: result.partialFailure.message,
          resultFile,
        },
        threadLikeMode ? "Thread partially published" : "Publish partially completed",
      );
      return EXIT_PARTIAL;
    }
    logger.info(
      {
        threadUrl: result.threadUrl,
        tweets: result.tweets.length,
        format: publishMode,
        resultFile,
      },
      "yt2x publish (native): done",
    );
    progress?.record("publish", Math.round(performance.now() - progressT0));
    progress?.printSummary();
    return 0;
  } catch (err: unknown) {
    progress?.clear();
    if (pageUrl.length > 0) {
      try {
        const message = err instanceof Error ? err.message : String(err);
        const code = isXPublishError(err) ? `E_PUBLISH_${err.kind}` : "E_UNKNOWN";
        await patchProcessStatus(
          youtubeVideoDir,
          { videoId: flags.videoId, url: pageUrl },
          {
            step: "publish",
            stepInfo: {
              status: "failed",
              finishedAt: new Date().toISOString(),
              durationMs: Date.now() - publishT0,
              artifacts: [],
              error: { code, message },
            },
            articleOutDir: articleDirForStatus,
          },
        );
      } catch {
        // ignore
      }
    }
    if (isXPublishError(err)) {
      const errorBlock: Parameters<typeof printCliErrorBlock>[0] = {
        command: "publish",
        subject: flags.videoId,
        reason: err.message,
        hints: ["Check the X API response and retry after resolving the publishing error."],
      };
      if (err.context.detail !== undefined) errorBlock.details = err.context.detail;
      printCliErrorBlock(errorBlock);
      return exitFromPublishKind(err.kind);
    }
    if (err instanceof NoRefreshTokenError) {
      printCliErrorBlock({
        command: "publish",
        subject: flags.videoId,
        reason: err.message,
        hints: ["Re-login to refresh local X credentials."],
        retryCommand: "pnpm yt2x auth login",
      });
      return EXIT_AUTH;
    }
    if (err instanceof XAuthError) {
      printCliErrorBlock({
        command: "publish",
        subject: flags.videoId,
        reason: err.message,
        hints: ["Re-login to refresh local X credentials."],
        retryCommand: "pnpm yt2x auth login",
      });
      return EXIT_AUTH;
    }
    const message = err instanceof Error ? err.message : String(err);
    printCliErrorBlock({
      command: "publish",
      subject: flags.videoId,
      reason: message,
      hints: ["Rerun with --verbose if the failure is not clear."],
    });
    return 1;
  }
};
