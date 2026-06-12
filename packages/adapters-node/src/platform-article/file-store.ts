import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlatformArticleTarget } from "@yt2x/core";
import { isValidVideoId } from "../article/file-store.js";
import type { GeneratedPlatformArticle } from "./generator.js";

export type WritePlatformArticleResult = {
  articleDir: string;
  articlePath: string;
  metadataPath: string;
};

const assertMissing = async (targetPath: string): Promise<void> => {
  try {
    await stat(targetPath);
    throw new Error(`${targetPath} already exists. Pass --force to overwrite, or delete it first.`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
};

const atomicWriteUtf8 = async (targetPath: string, body: string): Promise<void> => {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = targetPath + "." + String(process.pid) + "." + String(Date.now()) + ".tmp";
  await writeFile(tmp, body, "utf8");
  await rename(tmp, targetPath);
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
      "## 封面/配图建议",
      "",
      `- 主标题：${article.cover.headline}`,
      ...(article.cover.subhead !== undefined ? [`- 副标题：${article.cover.subhead}`] : []),
      `- 视觉说明：${article.cover.visual_prompt}`,
      ...(article.notes !== undefined && article.notes.length > 0
        ? ["", "## 发布注意事项", "", ...article.notes.map((note) => `- ${note}`)]
        : []),
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
): { articleFile: string; metadataFile: string } => ({
  articleFile: `${target}-article.md`,
  metadataFile: `${target}-metadata.json`,
});

export const writePlatformArticleBundle = async (
  articleOutDir: string,
  videoId: string,
  article: GeneratedPlatformArticle,
  options: { force?: boolean } = {},
): Promise<WritePlatformArticleResult> => {
  if (!isValidVideoId(videoId)) {
    throw new Error(`Invalid videoId: "${videoId}". Expected alphanumeric, hyphens, and underscores only.`);
  }

  const articleDir = path.join(path.resolve(articleOutDir), videoId);
  const { articleFile, metadataFile } = platformArticleFileNames(article.target);
  const articlePath = path.join(articleDir, articleFile);
  const metadataPath = path.join(articleDir, metadataFile);

  if (options.force !== true) {
    await assertMissing(articlePath);
    await assertMissing(metadataPath);
  }

  await mkdir(articleDir, { recursive: true });
  await atomicWriteUtf8(articlePath, renderPlatformArticleMarkdown(article));
  await atomicWriteUtf8(metadataPath, JSON.stringify(article, null, 2) + "\n");

  return { articleDir, articlePath, metadataPath };
};
