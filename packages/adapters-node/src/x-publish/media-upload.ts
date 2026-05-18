import path from "node:path";
import { XPublishError, type TweetImageContentType } from "@yt2x/core";

/** 与 `createXPublishAdapter` 内 `authedRequest` 同签名，便于单测注入。 */
export type XAuthedJsonRequest = (req: {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
}) => Promise<unknown>;

export type ReadBinaryFile = (filePath: string) => Promise<Buffer>;

type MediaUploadData = {
  id?: string;
  processing_info?: {
    state?: "succeeded" | "in_progress" | "pending" | "failed";
    check_after_secs?: number;
  };
};

type MediaUploadEnvelope = { data?: MediaUploadData };

const ONESHOT_MAX_BYTES = 5 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const STATUS_MAX_ROUNDS = 60;
const STATUS_MAX_WAIT_MS = 120_000;

const delay = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal !== undefined) {
      const onAbort = (): void => {
        clearTimeout(t);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

export const tweetImageKindFromContentType = (
  contentType: TweetImageContentType,
): { media_type: string; media_category: "tweet_image" | "tweet_gif" } => {
  if (contentType === "image/gif") return { media_type: "image/gif", media_category: "tweet_gif" };
  return { media_type: contentType, media_category: "tweet_image" };
};

/** 由本地路径推断 MIME（仅 Node adapter / CLI 使用，不进 `XPublishPort`）。 */
export const tweetImageContentTypeFromPath = (filePath: string): TweetImageContentType => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".gif") return "image/gif";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  throw new XPublishError(
    "BAD_REQUEST",
    `Unsupported image extension for X upload: "${ext || "(none)"}". Use .jpg/.png/.webp/.gif.`,
    { detail: filePath },
  );
};

const parseMediaId = (json: unknown, step: string): string => {
  const id = (json as MediaUploadEnvelope)?.data?.id;
  if (typeof id !== "string" || !/^[0-9]{1,19}$/.test(id)) {
    throw new XPublishError(
      "BAD_RESPONSE",
      `${step}: response missing data.id (numeric media id)`,
      { detail: (typeof json === "string" ? json : JSON.stringify(json) ?? "(empty response)").slice(0, 400) },
    );
  }
  return id;
};

const waitUntilMediaReady = async (
  mediaId: string,
  authedJson: XAuthedJsonRequest,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const t0 = Date.now();
  for (let round = 0; round < STATUS_MAX_ROUNDS; round += 1) {
    if (Date.now() - t0 > STATUS_MAX_WAIT_MS) {
      throw new XPublishError(
        "MEDIA_PROCESSING",
        `Media ${mediaId} processing timed out after ${STATUS_MAX_WAIT_MS}ms`,
        { detail: "STATUS polling exceeded deadline" },
      );
    }
    const q = new URLSearchParams({ media_id: mediaId, command: "STATUS" });
    const json = (await authedJson({
      method: "GET",
      path: `/2/media/upload?${q.toString()}`,
      ...(signal !== undefined ? { signal } : {}),
    })) as MediaUploadEnvelope;
    const pi = json.data?.processing_info;
    if (pi === undefined) return;
    const st = pi.state;
    if (st === "succeeded") return;
    if (st === "failed") {
      throw new XPublishError(
        "MEDIA_PROCESSING",
        `Media ${mediaId} processing failed on X side`,
        { detail: JSON.stringify(json.data).slice(0, 400) },
      );
    }
    if (st === "pending" || st === "in_progress") {
      const waitSec = pi.check_after_secs ?? 1;
      await delay(Math.min(10_000, Math.max(200, waitSec * 1000)), signal);
      continue;
    }
    return;
  }
  throw new XPublishError(
    "MEDIA_PROCESSING",
    `Media ${mediaId} processing did not complete after ${STATUS_MAX_ROUNDS} STATUS polls`,
    {},
  );
};

const ensureMediaReadyFromUploadResponse = async (
  mediaId: string,
  json: unknown,
  authedJson: XAuthedJsonRequest,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const pi = (json as MediaUploadEnvelope)?.data?.processing_info;
  if (pi === undefined || pi.state === "succeeded") return;
  if (pi.state === "failed") {
    throw new XPublishError(
      "MEDIA_PROCESSING",
      `Media ${mediaId} processing failed on X side`,
      { detail: JSON.stringify((json as MediaUploadEnvelope)?.data).slice(0, 400) },
    );
  }
  await waitUntilMediaReady(mediaId, authedJson, signal);
};

const oneShotUpload = async (
  buf: Buffer,
  kind: { media_type: string; media_category: "tweet_image" | "tweet_gif" },
  authedJson: XAuthedJsonRequest,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const form = new FormData();
  form.set(
    "media",
    new Blob([new Uint8Array(buf)], { type: kind.media_type }),
    kind.media_type === "image/png" ? "image.png" : "image",
  );
  form.set("media_category", kind.media_category);
  form.set("media_type", kind.media_type);

  const json = await authedJson({
    method: "POST",
    path: "/2/media/upload",
    formData: form,
    ...(signal !== undefined ? { signal } : {}),
  });
  const id = parseMediaId(json, "POST /2/media/upload");
  await ensureMediaReadyFromUploadResponse(id, json, authedJson, signal);
  return id;
};

const summarizeUploadFailure = (err: XPublishError): string => {
  const url = typeof err.context.url === "string" ? ` ${err.context.url}` : "";
  return `${err.kind}${url}: ${err.message}`;
};

const buildCombinedUploadContext = (
  first: XPublishError,
  second: XPublishError,
): XPublishError["context"] => {
  const context: XPublishError["context"] = {
    detail: `one-shot=${first.context.detail ?? first.message}; chunked=${second.context.detail ?? second.message}`,
  };
  const status = second.context.status ?? first.context.status;
  if (status !== undefined) context.status = status;
  const url = second.context.url ?? first.context.url;
  if (url !== undefined) context.url = url;
  if (second.context.retryAfterMs !== undefined) context.retryAfterMs = second.context.retryAfterMs;
  return context;
};

const chunkedUpload = async (
  buf: Buffer,
  kind: { media_type: string; media_category: "tweet_image" | "tweet_gif" },
  authedJson: XAuthedJsonRequest,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const initJson = await authedJson({
    method: "POST",
    path: "/2/media/upload/initialize",
    body: {
      media_type: kind.media_type,
      media_category: kind.media_category,
      total_bytes: buf.length,
    },
    ...(signal !== undefined ? { signal } : {}),
  });
  const mediaId = parseMediaId(initJson, "POST /2/media/upload/initialize");

  let offset = 0;
  let segment = 0;
  while (offset < buf.length) {
    const end = Math.min(offset + CHUNK_BYTES, buf.length);
    const chunk = buf.subarray(offset, end);
    await authedJson({
      method: "POST",
      path: `/2/media/upload/${encodeURIComponent(mediaId)}/append`,
      body: {
        segment_index: segment,
        media: chunk.toString("base64"),
      },
      ...(signal !== undefined ? { signal } : {}),
    });
    offset = end;
    segment += 1;
  }

  const finJson = await authedJson({
    method: "POST",
    path: `/2/media/upload/${encodeURIComponent(mediaId)}/finalize`,
    ...(signal !== undefined ? { signal } : {}),
  });
  parseMediaId(finJson, "POST /2/media/upload/{id}/finalize");
  await ensureMediaReadyFromUploadResponse(mediaId, finJson, authedJson, signal);
  return mediaId;
};

/**
 * 上传本地图片为 tweet 附件，返回 `media_id`（字符串数字，供 POST /2/tweets）。
 */
export const uploadTweetImageWithAuthedJson = async (input: {
  bytes: Uint8Array;
  contentType: TweetImageContentType;
  authedJson: XAuthedJsonRequest;
  signal?: AbortSignal;
}): Promise<string> => {
  const kind = tweetImageKindFromContentType(input.contentType);
  const buf = Buffer.from(input.bytes);
  if (buf.length === 0) {
    throw new XPublishError("BAD_REQUEST", "Image bytes are empty", {});
  }

  if (buf.length <= ONESHOT_MAX_BYTES) {
    try {
      return await oneShotUpload(buf, kind, input.authedJson, input.signal);
    } catch (err: unknown) {
      if (!(err instanceof XPublishError)) throw err;
      if (err.kind !== "BAD_REQUEST" && err.kind !== "BAD_RESPONSE" && err.kind !== "SERVER") {
        throw err;
      }
      try {
        return await chunkedUpload(buf, kind, input.authedJson, input.signal);
      } catch (chunkErr: unknown) {
        if (!(chunkErr instanceof XPublishError)) throw chunkErr;
        throw new XPublishError(
          chunkErr.kind,
          `X v2 media upload failed. one-shot=${summarizeUploadFailure(err)}; chunked=${summarizeUploadFailure(chunkErr)}`,
          buildCombinedUploadContext(err, chunkErr),
        );
      }
    }
  }
  return chunkedUpload(buf, kind, input.authedJson, input.signal);
};
