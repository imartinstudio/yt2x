import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { UploadTweetImageInput } from "@yt2x/core";
import { tweetImageContentTypeFromPath } from "./media-upload.js";

const execFileAsync = promisify(execFile);
const WEBP_TO_PNG_MAX_BYTES = 20 * 1024 * 1024;

const transcodeWebpToPng = async (filePath: string, signal?: AbortSignal): Promise<Buffer> => {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    ["-v", "error", "-i", filePath, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
    {
      encoding: "buffer",
      maxBuffer: WEBP_TO_PNG_MAX_BYTES,
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  return Buffer.from(stdout);
};

/** 从本地路径读入二进制，供 `XPublishPort.uploadTweetImage` 使用（文件 I/O 留在 adapter 层）。 */
export const loadTweetImageFromPath = async (
  filePath: string,
  signal?: AbortSignal,
): Promise<UploadTweetImageInput> => {
  const contentType = tweetImageContentTypeFromPath(filePath);
  if (contentType === "image/webp") {
    return {
      bytes: await transcodeWebpToPng(filePath, signal),
      contentType: "image/png",
      ...(signal !== undefined ? { signal } : {}),
    };
  }
  const bytes = await readFile(filePath);
  return {
    bytes,
    contentType,
    ...(signal !== undefined ? { signal } : {}),
  };
};
