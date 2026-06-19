import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GeneratedThread } from "@yt2x/core";
import { isValidVideoId } from "../article/file-store.js";

export type WriteNativeThreadResult = {
  articleDir: string;
  threadPath: string;
  hooksPath: string;
  visualsPath: string | null;
};

export const renderXThreadMarkdown = (thread: GeneratedThread): string => {
  const lines: string[] = [];
  thread.tweets.forEach((tweet, index) => {
    lines.push(`${index + 1}/ ${tweet.trim()}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd() + "\n";
};

export const writeNativeThreadBundle = async (
  articleOutDir: string,
  videoId: string,
  thread: GeneratedThread,
  options: { force?: boolean } = {},
): Promise<WriteNativeThreadResult> => {
  if (!isValidVideoId(videoId)) {
    throw new Error(`Invalid videoId: "${videoId}". Expected alphanumeric, hyphens, and underscores only.`);
  }

  const articleDir = path.join(path.resolve(articleOutDir), videoId);
  const threadPath = path.join(articleDir, "x-format", "x-thread.md");
  const hooksPath = path.join(articleDir, "x-format", "x-hooks.json");

  if (options.force !== true) {
    await assertMissing(threadPath);
    await assertMissing(hooksPath);
  }

  await mkdir(articleDir, { recursive: true });
  await atomicWriteUtf8(threadPath, renderXThreadMarkdown(thread));
  await atomicWriteUtf8(hooksPath, JSON.stringify({ hooks: thread.hooks }, null, 2) + "\n");

  let visualsPath: string | null = null;
  if (thread.visuals !== undefined && thread.visuals.length > 0) {
    visualsPath = path.join(articleDir, "x-format", "x-thread-visuals.json");
    await atomicWriteUtf8(
      visualsPath,
      JSON.stringify({ visuals: thread.visuals }, null, 2) + "\n",
    );
  }

  return { articleDir, threadPath, hooksPath, visualsPath };
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
