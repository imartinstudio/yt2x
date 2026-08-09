import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { PlatformArticleTarget } from "@yt2x/core";
import { isValidVideoId } from "../article/file-store.js";
import type { GeneratedPlatformArticle } from "./generator.js";
import {
  contentTargetMetadataPathFor,
  isContentTargetMetadataFresh,
  readContentTargetMetadata,
  writeContentTargetMetadata,
  type ContentTargetCacheExpectation,
  type ContentTargetMetadata,
} from "../content-cache.js";
import { atomicWriteUtf8, withContentTargetLock } from "../content-transaction.js";

export type WritePlatformArticleResult = {
  articleDir: string;
  articlePath: string;
  metadataPath: string;
};

const assertMissing = async (targetPath: string): Promise<boolean> => {
  try {
    await stat(targetPath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return false;
  }
};

const tagLine = (tags: readonly string[]): string => tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ");

export const renderPlatformArticleMarkdown = (article: GeneratedPlatformArticle): string => {
  if (article.target === "xiaohongshu") {
    return [
      `# ${article.title}`,
      "",
      "## 正文",
      "",
      article.body.trim(),
      "",
      "## 标签",
      "",
      tagLine(article.tags),
      "",
    ].join("\n");
  }

  if (article.target === "wechat") {
    return [
      `# ${article.title}`,
      "",
      "## 备选标题",
      "",
      ...article.title_options.map((title, index) => `${index + 1}. ${title}`),
      "",
      "## 摘要",
      "",
      article.summary,
      "",
      "## 导语",
      "",
      article.lead,
      "",
      article.body.trim(),
      "",
      "## 封面图建议",
      "",
      `- 主标题：${article.cover.headline}`,
      ...(article.cover.subhead !== undefined ? [`- 副标题：${article.cover.subhead}`] : []),
      `- 视觉说明：${article.cover.visual_prompt}`,
      "",
    ].join("\n");
  }

  return [
    `# ${article.title}`,
    "",
    "## 视频简介",
    "",
    article.description.trim(),
    "",
    "## 分区建议",
    "",
    article.category,
    "",
    "## 标签",
    "",
    tagLine(article.tags),
    "",
    "## 章节时间线草案",
    "",
    ...article.timeline.map((item) => {
      const prefix = item.time.trim().length > 0 ? `${item.time} ` : "";
      return `- ${prefix}${item.title}：${item.description}`;
    }),
    "",
    "## 评论引导",
    "",
    article.comment_prompt,
    "",
  ].join("\n");
};

export const platformArticleFileNames = (
  target: PlatformArticleTarget,
): { articleFile: string; metadataFile: string } => {
  const dir = `${target}-format`;
  return {
    articleFile: `${dir}/${target}-article.md`,
    metadataFile: `${dir}/${target}-metadata.json`,
  };
};

export const writePlatformArticleBundle = async (
  articleOutDir: string,
  videoId: string,
  article: GeneratedPlatformArticle,
  options: {
    force?: boolean;
    cacheExpectation?: ContentTargetCacheExpectation;
    cacheMetadata?: ContentTargetMetadata;
    lock?: boolean;
  } = {},
): Promise<WritePlatformArticleResult | null> => {
  if (!isValidVideoId(videoId)) {
    throw new Error(`Invalid videoId: "${videoId}". Expected alphanumeric, hyphens, and underscores only.`);
  }

  const articleDir = path.join(path.resolve(articleOutDir), videoId);
  const { articleFile, metadataFile } = platformArticleFileNames(article.target);
  const articlePath = path.join(articleDir, articleFile);
  const metadataPath = path.join(articleDir, metadataFile);
  const targetMetadataPath = contentTargetMetadataPathFor(articleDir, `platform-article-${article.target}`);

  if (options.lock !== false) {
    return withContentTargetLock(articleDir, `platform-article-${article.target}`, () => writePlatformArticleBundle(
      articleOutDir,
      videoId,
      article,
      { ...options, lock: false },
    ));
  }

  if (options.force !== true) {
    if (options.cacheExpectation !== undefined) {
      const existing = await readContentTargetMetadata(targetMetadataPath);
      if (await isContentTargetMetadataFresh(existing, {
        ...options.cacheExpectation,
        requiredFiles: [articlePath, metadataPath, targetMetadataPath],
      })) return null;
    } else {
      const exists = (await assertMissing(articlePath)) || (await assertMissing(metadataPath));
      if (exists) return null;
    }
  }

  await mkdir(articleDir, { recursive: true });
  await atomicWriteUtf8(articlePath, renderPlatformArticleMarkdown(article));
  await atomicWriteUtf8(metadataPath, JSON.stringify(article, null, 2) + "\n");
  if (options.cacheMetadata !== undefined) {
    await writeContentTargetMetadata(targetMetadataPath, options.cacheMetadata);
  }

  return { articleDir, articlePath, metadataPath };
};
