import { stat } from "node:fs/promises";
import path from "node:path";
import {
  parseArticleDraftFromMarkdown,
  type ArticleDraftParseResult,
} from "@yt2x/core";

export const parseArticleDraftMarkdown = (
  markdown: string,
  articleDir: string,
  fallbackCoverImage?: string | null,
): ArticleDraftParseResult => {
  const options: Parameters<typeof parseArticleDraftFromMarkdown>[1] = {
    resolveMediaPath: (source) => resolveArticleMediaPath(articleDir, source),
  };
  if (fallbackCoverImage !== undefined) {
    options.fallbackCoverImage = fallbackCoverImage;
  }
  return parseArticleDraftFromMarkdown(markdown, options);
};

export const assertArticleDraftImagesExist = async (parsed: ArticleDraftParseResult): Promise<void> => {
  const media = [
    ...(parsed.coverImage === null ? [] : [{ role: "cover image", path: parsed.coverImage }]),
    ...parsed.contentImages.map((image) => ({ role: "content image", path: image.path })),
    ...parsed.contentVideos.map((video) => ({ role: "content video", path: video.path })),
  ];
  for (const item of media) {
    try {
      await stat(item.path);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`X Article ${item.role} was not found: ${item.path}`);
      }
      throw err;
    }
  }
};

const resolveArticleMediaPath = (articleDir: string, source: string): string =>
  path.isAbsolute(source) ? source : path.resolve(articleDir, decodeURIComponent(source));
