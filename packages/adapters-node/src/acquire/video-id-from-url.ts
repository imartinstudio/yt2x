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

const assertCanonicalVideoId = (id: string, source: string): string => {
  if (/^[A-Za-z0-9_-]{11}$/.test(id)) {
    return id;
  }
  if (/^[A-Za-z0-9_-]{6,10}$/.test(id)) {
    return sanitizeVideoId(id);
  }
  throw new Error(
    `Invalid YouTube video id in ${source}: expected 11 characters, got ${id.length}. Use the unescaped browser URL or the exact 11-character video id.`,
  );
};

/** 与 legacy `prepare_youtube_batch.py` 的 `video_id_from_url` 对齐。 */
export const videoIdFromUrl = (url: string): string => {
  const normalized = normalizeYoutubeUrl(url);

  try {
    const parsed = new URL(normalized);
    const watchId = parsed.searchParams.get("v");
    if (watchId !== null) {
      return assertCanonicalVideoId(watchId.replace(/\\/g, ""), "watch URL");
    }

    const host = parsed.hostname.replace(/^www\./, "");
    const pathParts = parsed.pathname.split("/").filter((part) => part.length > 0);
    if (host === "youtu.be" && pathParts[0] !== undefined) {
      return assertCanonicalVideoId(pathParts[0].replace(/\\/g, ""), "short URL");
    }
    if ((host === "youtube.com" || host === "youtube-nocookie.com") && pathParts[1] !== undefined) {
      if (pathParts[0] === "embed") {
        return assertCanonicalVideoId(pathParts[1].replace(/\\/g, ""), "embed URL");
      }
      if (pathParts[0] === "shorts") {
        return assertCanonicalVideoId(pathParts[1].replace(/\\/g, ""), "shorts URL");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid YouTube video id")) {
      throw error;
    }
  }

  const slug = normalized.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_|_$/g, "");
  return sanitizeVideoId(slug.slice(0, 64) || "video");
};
