/** 去掉 CLI / 分享链接里误带的反斜杠（如 `youtu.be/ID\\?si=...`） */
export const normalizeYoutubeUrl = (url: string): string =>
  url.trim().replace(/\\([?&#=])/g, "$1");

/**
 * 规范为 YouTube 11 位 video id（仅 [A-Za-z0-9_-]）。
 * 避免 `4ByJZRP5oYI\\` 这类目录名污染 `--out-dir`。
 */
export const sanitizeVideoId = (raw: string): string => {
  const trimmed = raw.trim();
  const embedded = /[A-Za-z0-9_-]{11}/.exec(trimmed.replace(/\\/g, ""));
  if (embedded?.[0] !== undefined) {
    return embedded[0];
  }
  const cleaned = trimmed.replace(/[^A-Za-z0-9_-]/g, "");
  if (cleaned.length >= 6) {
    return cleaned.slice(0, 11);
  }
  return "video";
};

/** 与 legacy `prepare_youtube_batch.py` 的 `video_id_from_url` 对齐。 */
export const videoIdFromUrl = (url: string): string => {
  const normalized = normalizeYoutubeUrl(url);
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{6,})/,
    /youtu\.be\/([A-Za-z0-9_-]{6,})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/,
    /\/shorts\/([A-Za-z0-9_-]{6,})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match?.[1] !== undefined) {
      return sanitizeVideoId(match[1]);
    }
  }
  const slug = normalized.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_|_$/g, "");
  return sanitizeVideoId(slug.slice(0, 64) || "video");
};
