import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isValidVideoId } from "../article/file-store.js";

export type ArticleArtifacts = {
  /** article.md 所在目录（native 扁平：<articleRoot>/<videoId>/） */
  articleDir: string;
  /** article.md 绝对路径 */
  articlePath: string;
  /** article.md 内容 */
  articleContent: string;
  /** 检测到的封面图绝对路径（可能为 null） */
  coverPath: string | null;
  videoId: string;
};

const COVER_CANDIDATES = ["cover.webp", "cover.jpg", "cover.jpeg", "cover.png"] as const;

/**
 * 在 `<articleRoot>/<videoId>/article.md` 下解析 native 长文产物。
 */
export const findArticleArtifacts = async (input: {
  videoId: string;
  /** 长文根目录（通常为 `files/articles`） */
  articleRootDir: string;
  /** 显式 article 目录路径（绝对或 relative cwd），跳过自动发现 */
  articleDir?: string;
}): Promise<ArticleArtifacts> => {
  if (!isValidVideoId(input.videoId)) {
    throw new Error(`Invalid videoId: "${input.videoId}". Expected alphanumeric, hyphens, and underscores only.`);
  }

  const articleRoot = input.articleRootDir;
  let articleDir: string;
  if (input.articleDir !== undefined) {
    articleDir = path.resolve(input.articleDir);
  } else {
    const videoRoot = path.resolve(articleRoot, input.videoId);
    articleDir = await resolveFlatArticleDir(videoRoot, input.videoId);
  }

  const articlePath = path.join(articleDir, "article.md");
  let articleContent: string;
  try {
    articleContent = await readFile(articlePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `article.md not found in ${articleDir}. Run \`pnpm yt2x article --video-id ${input.videoId}\` first.`,
      );
    }
    throw err;
  }
  if (articleContent.trim().length === 0) {
    throw new Error(`${articlePath} is empty.`);
  }

  const coverPath = await findCoverImage(articleDir);

  return {
    articleDir,
    articlePath,
    articleContent,
    coverPath,
    videoId: input.videoId,
  };
};

const resolveFlatArticleDir = async (videoRoot: string, videoId: string): Promise<string> => {
  const flatArticle = path.join(videoRoot, "article.md");
  try {
    await stat(flatArticle);
    return videoRoot;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No article for video "${videoId}" under ${videoRoot}. Run \`pnpm yt2x article --video-id ${videoId}\` first.`,
      );
    }
    throw err;
  }
};

const findCoverImage = async (articleDir: string): Promise<string | null> => {
  const imagesDir = path.join(articleDir, "images");
  for (const name of COVER_CANDIDATES) {
    const p = path.join(imagesDir, name);
    try {
      await stat(p);
      return p;
    } catch {
      // 继续找
    }
  }
  for (const name of COVER_CANDIDATES) {
    const p = path.join(articleDir, name);
    try {
      await stat(p);
      return p;
    } catch {
      // 继续
    }
  }
  return null;
};
