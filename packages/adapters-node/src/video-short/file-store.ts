import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GeneratedVideoShortPost } from "@yt2x/core";
import { isValidVideoId } from "../article/file-store.js";

export type WriteNativeVideoShortResult = {
  articleDir: string;
  shortPath: string;
};

export const renderXVideoShortMarkdown = (post: GeneratedVideoShortPost): string => {
  let text = post.text.trim();

  // 确保 "完整视频+中文字幕" 前面有空行，且后面没有链接
  text = text.replace(/\n?(完整视频\+中文字幕：👇).*/g, "\n\n$1");

  return text + "\n";
};

export const writeNativeVideoShortBundle = async (
  articleOutDir: string,
  videoId: string,
  post: GeneratedVideoShortPost,
  options: { force?: boolean } = {},
): Promise<WriteNativeVideoShortResult | null> => {
  if (!isValidVideoId(videoId)) {
    throw new Error(`Invalid videoId: "${videoId}". Expected alphanumeric, hyphens, and underscores only.`);
  }

  const articleDir = path.join(path.resolve(articleOutDir), videoId);
  const shortPath = path.join(articleDir, "x-format", "x-video-short.md");

  if (options.force !== true) {
    const exists = await assertMissing(shortPath);
    if (exists) return null;
  }

  await mkdir(articleDir, { recursive: true });
  await atomicWriteUtf8(shortPath, renderXVideoShortMarkdown(post));

  return { articleDir, shortPath };
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
