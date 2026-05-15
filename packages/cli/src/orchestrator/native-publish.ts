import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_OUT_DIR,
  NoCredentialsError,
  NoRefreshTokenError,
  createTokenSource,
  createTokenStore,
  createXPublishAdapter,
  defaultCredentialsPath,
  findArticleArtifacts,
  isValidVideoId,
  loadTweetImageFromPath,
  patchProcessStatus,
  patchStepRunning,
  readYoutubePageUrl,
} from "@yt2x/adapters-node";
import {
  XAuthError,
  articleToLongPost,
  articleToThread,
  isXPublishError,
  tweetLength,
  type PostThreadResult,
} from "@yt2x/core";
import { logger } from "../logger.js";
import type { SingleStageFlags } from "../commands/command-flags.js";
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
  /** 串推模式；默认 false = 单条长文 */
  thread?: boolean;
  numbering?: boolean;
  continueOnFailure?: boolean;
  dryRun?: boolean;
};

const EXIT_CONFIG_MISSING = NATIVE_EXIT.CONFIG_MISSING;
const EXIT_AUTH = NATIVE_EXIT.LLM_AUTH;
const EXIT_PARTIAL = NATIVE_EXIT.PARTIAL_FAILURE;
const EXIT_RATE_LIMITED = 7;
const EXIT_SERVER = 8;

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

const previewPublishTexts = (texts: string[], threadMode: boolean): void => {
  if (threadMode) {
    for (let i = 0; i < texts.length; i += 1) {
      process.stdout.write(`\n── Tweet ${i + 1}/${texts.length} ──\n${texts[i]!}\n`);
    }
    process.stdout.write("\n");
    return;
  }
  const body = texts[0] ?? "";
  process.stdout.write(
    `\n── X 长文预览（加权字数 ${tweetLength(body)} / ${body.length} 字符）──\n${body}\n\n`,
  );
};

/** 供 `pipeline` 编排器与 `yt2x publish` 调用；返回进程退出码。 */
export const executeNativePublish = async (flags: PublishFlags): Promise<number> => {
  if (flags.videoId === undefined || flags.videoId.length === 0) {
    logger.error(
      "Publish (native) requires --video-id <id>. Example: yt2x publish --video-id dQw4w9WgXcQ",
    );
    return EXIT_CONFIG_MISSING;
  }
  if (!isValidVideoId(flags.videoId)) {
    logger.error(
      { videoId: flags.videoId },
      "Invalid --video-id. Expected alphanumeric, hyphens, and underscores only.",
    );
    return EXIT_CONFIG_MISSING;
  }

  const articleRootDir = resolveArticleOutRoot(flags, DEFAULT_ARTICLE_OUT_DIR);
  await mkdir(articleRootDir, { recursive: true });
  const profile = flags.profile ?? "default";
  const threadMode = flags.thread === true;
  const maxChars = parsePositiveInt(
    flags.publishMaxChars ?? flags.maxChars,
    threadMode ? 280 : 25_000,
    "max-chars",
  );
  const maxTweets = threadMode ? parsePositiveInt(flags.maxTweets, 25, "max-tweets") : 1;
  const isDryRun = flags.dryRun === true || flags.publishDryRun === true;

  let artifacts;
  try {
    const findInput: Parameters<typeof findArticleArtifacts>[0] = {
      videoId: flags.videoId,
      articleRootDir,
    };
    if (flags.articleDir !== undefined) findInput.articleDir = flags.articleDir;
    artifacts = await findArticleArtifacts(findInput);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ videoId: flags.videoId, articleRootDir }, message);
    return EXIT_CONFIG_MISSING;
  }

  const texts = buildPublishTexts(artifacts.articleContent, {
    threadMode,
    maxChars,
    maxTweets,
    numbering: flags.numbering === true,
  });

  if (texts.length === 0) {
    logger.error({ articlePath: artifacts.articlePath }, "Article produced empty publish body; check input.");
    return EXIT_CONFIG_MISSING;
  }

  const youtubeVideoDir = path.join(path.resolve(flags.outDir ?? DEFAULT_OUT_DIR), flags.videoId);

  if (isDryRun) {
    logger.info(
      {
        articleDir: artifacts.articleDir,
        format: threadMode ? "thread" : "long",
        parts: texts.length,
        coverPath: artifacts.coverPath,
        maxChars,
      },
      threadMode
        ? "yt2x publish (native) --dry-run: thread preview below"
        : "yt2x publish (native) --dry-run: long post preview below",
    );
    previewPublishTexts(texts, threadMode);
    if (artifacts.coverPath !== null) {
      logger.info(
        { coverPath: artifacts.coverPath },
        "Dry-run: cover would be uploaded on real publish (requires media.write).",
      );
    }
    const pageUrl = await readYoutubePageUrl(youtubeVideoDir, flags.videoId);
    const previewFile = path.join(artifacts.articleDir, "publish-preview.json");
    const payload = {
      profile,
      format: threadMode ? "thread" : "long",
      maxChars,
      maxTweets,
      coverPath: artifacts.coverPath,
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
        articleOutDir: artifacts.articleDir,
      },
    ).catch(() => {});
    return 0;
  }

  const store = createTokenStore();
  const tokenSource = createTokenSource({ store, profile });

  let scopes: string[];
  try {
    scopes = await tokenSource.getScopes();
  } catch (err: unknown) {
    if (err instanceof NoCredentialsError) {
      logger.error({ profile }, err.message);
      return EXIT_CONFIG_MISSING;
    }
    throw err;
  }

  if (!scopes.includes("tweet.write")) {
    logger.error(
      { scopes, credentialsFile: defaultCredentialsPath() },
      'Stored token lacks "tweet.write" scope. Re-login: yt2x auth login',
    );
    return EXIT_AUTH;
  }
  if (artifacts.coverPath !== null && !scopes.includes("media.write")) {
    logger.warn(
      { coverPath: artifacts.coverPath, scopes },
      'Cover image found, but token lacks "media.write" scope. Re-login with `yt2x auth login --scope media.write` to attach the cover image.',
    );
  }

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
      format: threadMode ? "thread" : "long",
      parts: texts.length,
      articleDir: artifacts.articleDir,
    },
    threadMode ? "yt2x publish (native): posting thread" : "yt2x publish (native): posting long post",
  );

  const pageUrl = await readYoutubePageUrl(youtubeVideoDir, flags.videoId);
  const publishT0 = Date.now();
  await patchStepRunning(
    youtubeVideoDir,
    { videoId: flags.videoId, url: pageUrl },
    "publish",
    { articleOutDir: artifacts.articleDir },
  ).catch(() => {});

  try {
    let firstMediaId: string | null = null;
    if (artifacts.coverPath !== null && scopes.includes("media.write")) {
      try {
        const image = await loadTweetImageFromPath(artifacts.coverPath);
        firstMediaId = await adapter.uploadTweetImage(image);
        logger.info({ mediaId: firstMediaId, coverPath: artifacts.coverPath }, "Cover uploaded");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { coverPath: artifacts.coverPath, err: message },
          threadMode ? "Cover upload failed; posting text-only thread" : "Cover upload failed; posting text-only",
        );
      }
    }

    let result: PostThreadResult;
    if (threadMode) {
      result = await adapter.postThread({
        tweets: texts,
        ...(firstMediaId !== null ? { firstTweetMediaIds: [firstMediaId] } : {}),
        ...(flags.continueOnFailure === true ? { continueOnFailure: true } : {}),
      });
    } else {
      const tweet = await adapter.postTweet({
        text: texts[0]!,
        ...(firstMediaId !== null ? { mediaIds: [firstMediaId] } : {}),
      });
      result = {
        tweets: [tweet],
        threadUrl: `https://x.com/i/status/${tweet.id}`,
      };
    }

    const resultFile = path.join(artifacts.articleDir, "publish-result.json");
    const payload = {
      profile,
      handle: user?.user?.username ?? null,
      format: threadMode ? "thread" : "long",
      ...(result.threadUrl !== undefined ? { threadUrl: result.threadUrl } : {}),
      firstMediaId,
      tweets: result.tweets.map((t) => ({ id: t.id, text: t.text })),
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
          articleOutDir: artifacts.articleDir,
        },
      );
    } catch {
      // 状态写入失败不阻断已成功发帖
    }

    if (result.partialFailure !== undefined) {
      logger.warn(
        {
          ok: result.tweets.length,
          totalPlanned: texts.length,
          atIndex: result.partialFailure.atIndex,
          message: result.partialFailure.message,
          resultFile,
        },
        threadMode ? "Thread partially published" : "Publish partially completed",
      );
      return EXIT_PARTIAL;
    }
    logger.info(
      {
        threadUrl: result.threadUrl,
        tweets: result.tweets.length,
        format: threadMode ? "thread" : "long",
        resultFile,
      },
      "yt2x publish (native): done",
    );
    return 0;
  } catch (err: unknown) {
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
            articleOutDir: artifacts.articleDir,
          },
        );
      } catch {
        // ignore
      }
    }
    if (isXPublishError(err)) {
      logger.error(
        { kind: err.kind, status: err.context.status, detail: err.context.detail },
        err.message,
      );
      return exitFromPublishKind(err.kind);
    }
    if (err instanceof NoRefreshTokenError) {
      logger.error(err.message);
      return EXIT_AUTH;
    }
    if (err instanceof XAuthError) {
      logger.error({ code: err.code }, err.message);
      return EXIT_AUTH;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "yt2x publish (native): unexpected error");
    return 1;
  }
};
