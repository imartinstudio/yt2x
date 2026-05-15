import type { YouTubeMetadata } from "@yt2x/core";

/** 落盘 / LLM 共用的精简字段（去掉 yt-dlp 的 formats、thumbnails 等大数组）。 */
const SLIM_METADATA_KEYS: readonly (keyof YouTubeMetadata)[] = [
  "id",
  "title",
  "webpage_url",
  "original_url",
  "channel",
  "channel_id",
  "channel_url",
  "uploader",
  "uploader_id",
  "upload_date",
  "duration",
  "description",
  "thumbnail",
  "language",
  "categories",
  "tags",
  "view_count",
  "like_count",
  "availability",
];

export const slimVideoMetadata = (raw: Record<string, unknown>): YouTubeMetadata => {
  const out: YouTubeMetadata = {};
  for (const key of SLIM_METADATA_KEYS) {
    if (raw[key] !== undefined) {
      out[key] = raw[key];
    }
  }
  if (out.webpage_url === undefined && typeof raw.original_url === "string") {
    out.webpage_url = raw.original_url;
  }
  return out;
};
