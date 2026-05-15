import { readFile } from "node:fs/promises";
import type { UploadTweetImageInput } from "@yt2x/core";
import { tweetImageContentTypeFromPath } from "./media-upload.js";

/** 从本地路径读入二进制，供 `XPublishPort.uploadTweetImage` 使用（文件 I/O 留在 adapter 层）。 */
export const loadTweetImageFromPath = async (
  filePath: string,
  signal?: AbortSignal,
): Promise<UploadTweetImageInput> => {
  const bytes = await readFile(filePath);
  const contentType = tweetImageContentTypeFromPath(filePath);
  return {
    bytes,
    contentType,
    ...(signal !== undefined ? { signal } : {}),
  };
};
