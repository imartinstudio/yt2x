import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GeneratedShortPost } from "@yt2x/core";
import { isValidVideoId } from "../article/file-store.js";
import {
  contentTargetMetadataPathFor,
  isContentTargetMetadataFresh,
  readContentTargetMetadata,
  writeContentTargetMetadata,
  type ContentTargetCacheExpectation,
  type ContentTargetMetadata,
} from "../content-cache.js";

export type WriteNativeShortResult = {
  articleDir: string;
  shortPath: string;
  visualPath: string | null;
};

export const renderXShortMarkdown = (shortPost: GeneratedShortPost): string =>
  shortPost.text.trim() + "\n";

export const writeNativeShortBundle = async (
  articleOutDir: string,
  videoId: string,
  shortPost: GeneratedShortPost,
  options: {
    force?: boolean;
    cacheExpectation?: ContentTargetCacheExpectation;
    cacheMetadata?: ContentTargetMetadata;
  } = {},
): Promise<WriteNativeShortResult | null> => {
  if (!isValidVideoId(videoId)) {
    throw new Error(`Invalid videoId: "${videoId}". Expected alphanumeric, hyphens, and underscores only.`);
  }

  const articleDir = path.join(path.resolve(articleOutDir), videoId);
  const shortPath = path.join(articleDir, "x-format", "x-short.md");
  const metadataPath = contentTargetMetadataPathFor(articleDir, "x-short");

  if (options.force !== true) {
    if (options.cacheExpectation !== undefined) {
      const existing = await readContentTargetMetadata(metadataPath);
      if (await isContentTargetMetadataFresh(existing, {
        ...options.cacheExpectation,
        requiredFiles: [shortPath, metadataPath],
      })) return null;
    } else {
      const exists = await assertMissing(shortPath);
      if (exists) return null;
    }
  }

  await mkdir(articleDir, { recursive: true });
  await atomicWriteUtf8(shortPath, renderXShortMarkdown(shortPost));

  let visualPath: string | null = null;
  if (shortPost.visual !== undefined) {
    visualPath = path.join(articleDir, "x-format", "x-short-visual.json");
    await atomicWriteUtf8(
      visualPath,
      JSON.stringify({ visual: shortPost.visual }, null, 2) + "\n",
    );
  }
  if (options.cacheMetadata !== undefined) {
    await writeContentTargetMetadata(metadataPath, options.cacheMetadata);
  }

  return { articleDir, shortPath, visualPath };
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

const atomicWriteUtf8 = async (targetPath: string, body: string): Promise<void> => {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = targetPath + "." + String(process.pid) + "." + String(Date.now()) + ".tmp";
  await writeFile(tmp, body, "utf8");
  await rename(tmp, targetPath);
};
