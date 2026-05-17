import {
  XPublishError,
  type PostTweetInput,
  type PostThreadInput,
  type PostThreadResult,
  type Tweet,
  type UploadTweetImageInput,
  type WhoamiResult,
  type XPublishPort,
} from "@yt2x/core";
import type { Fetcher } from "../x-auth/token-client.js";
import type { TokenSource } from "./token-source.js";
import { uploadTweetImageWithAuthedJson, type XAuthedJsonRequest } from "./media-upload.js";

export const X_API_BASE = "https://api.x.com";

const DEFAULT_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const randomDelayMs = (range: { min: number; max: number }): number => {
  const min = Math.max(0, Math.floor(range.min));
  const max = Math.max(min, Math.floor(range.max));
  return min + Math.floor(Math.random() * (max - min + 1));
};

export type CreateXPublishAdapterOptions = {
  tokenSource: TokenSource;
  /** 注入 fetch（测试用）。 */
  fetcher?: Fetcher;
  /** 单次请求超时；默认 30s。 */
  timeoutMs?: number;
  /** 基础 URL 覆盖；默认 `https://api.x.com`。 */
  baseUrl?: string;
};

type RawV2Error = {
  title?: string;
  detail?: string;
  type?: string;
  errors?: Array<{ message?: string; code?: number; parameters?: unknown }>;
};

const parseRetryAfter = (resp: Response): number | undefined => {
  // x-rate-limit-reset：epoch second（X 自定义）
  const reset = resp.headers.get("x-rate-limit-reset");
  if (reset !== null) {
    const epochSec = Number.parseInt(reset, 10);
    if (Number.isFinite(epochSec)) {
      const ms = epochSec * 1000 - Date.now();
      if (ms > 0) return ms;
    }
  }
  // Retry-After：HTTP 标准（秒数或日期）
  const retryAfter = resp.headers.get("retry-after");
  if (retryAfter !== null) {
    const sec = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(sec)) return sec * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      const ms = date - Date.now();
      if (ms > 0) return ms;
    }
  }
  return undefined;
};

const safeJson = async (resp: Response): Promise<unknown> => {
  const text = await resp.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.slice(0, 400) };
  }
};

const classifyError = (
  status: number,
  json: unknown,
  url: string,
  resp: Response,
): XPublishError => {
  const raw = (json ?? {}) as RawV2Error;
  const detail =
    raw.detail ?? raw.title ?? raw.errors?.[0]?.message ?? `HTTP ${status}`;

  if (status === 401) {
    return new XPublishError("AUTH", `X API 401 Unauthorized: ${detail}`, {
      status,
      url,
      detail,
    });
  }
  if (status === 403) {
    return new XPublishError("FORBIDDEN", `X API 403 Forbidden: ${detail}`, {
      status,
      url,
      detail,
    });
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(resp);
    return new XPublishError("RATE_LIMITED", `X API 429 Rate Limited: ${detail}`, {
      status,
      url,
      detail,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (status === 400) {
    if (raw.errors?.some((e) => e.code === 187)) {
      return new XPublishError("DUPLICATE", `X API duplicate tweet: ${detail}`, {
        status,
        url,
        detail,
      });
    }
    return new XPublishError("BAD_REQUEST", `X API 400: ${detail}`, {
      status,
      url,
      detail,
    });
  }
  if (status >= 500) {
    return new XPublishError("SERVER", `X API ${status}: ${detail}`, {
      status,
      url,
      detail,
    });
  }
  return new XPublishError("BAD_RESPONSE", `X API ${status}: ${detail}`, {
    status,
    url,
    detail,
  });
};

const withTimeout = (
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("X API request timed out")), timeoutMs);
  const clear = (): void => clearTimeout(t);
  if (signal !== undefined) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", () => ctrl.abort(signal.reason));
  }
  return { signal: ctrl.signal, clear };
};

export const createXPublishAdapter = (
  opts: CreateXPublishAdapterOptions,
): XPublishPort => {
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = (opts.baseUrl ?? X_API_BASE).replace(/\/+$/, "");

  type RequestOpts = {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: unknown;
    signal?: AbortSignal;
  };

  const doRequest = async (
    accessToken: string,
    req: RequestOpts,
  ): Promise<Response> => {
    const url = `${baseUrl}${req.path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.body);
    }
    const { signal, clear } = withTimeout(req.signal, timeoutMs);
    const init: RequestInit = { method: req.method, headers, signal };
    if (body !== undefined) init.body = body;
    try {
      return await fetcher(url, init);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new XPublishError("NETWORK", `Network failure calling ${url}: ${message}`, {
        url,
      });
    } finally {
      clear();
    }
  };

  /** authedRequest：自动注入 token；遇 401 强 refresh 一次后重试一次。 */
  const authedRequest = async (req: RequestOpts): Promise<unknown> => {
    let accessToken = await opts.tokenSource.getAccessToken(req.signal);
    let resp = await doRequest(accessToken, req);
    if (resp.status === 401) {
      accessToken = await opts.tokenSource.forceRefresh(req.signal);
      resp = await doRequest(accessToken, req);
    }
    const json = await safeJson(resp);
    const url = `${baseUrl}${req.path}`;
    if (!resp.ok) throw classifyError(resp.status, json, url, resp);
    return json;
  };

  const authedJson: XAuthedJsonRequest = async (req) =>
    authedRequest({
      method: req.method,
      path: req.path,
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    });

  const uploadTweetImage = async (input: UploadTweetImageInput): Promise<string> =>
    uploadTweetImageWithAuthedJson({
      bytes: input.bytes,
      contentType: input.contentType,
      authedJson,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

  const postTweet = async (input: PostTweetInput): Promise<Tweet> => {
    const body: Record<string, unknown> = { text: input.text };
    if (input.replyToTweetId !== undefined) {
      body.reply = { in_reply_to_tweet_id: input.replyToTweetId };
    }
    if (input.mediaIds !== undefined && input.mediaIds.length > 0) {
      body.media = { media_ids: input.mediaIds };
    }
    const reqOpts: RequestOpts = {
      method: "POST",
      path: "/2/tweets",
      body,
    };
    if (input.signal !== undefined) reqOpts.signal = input.signal;
    const json = (await authedRequest(reqOpts)) as { data?: Tweet };
    if (json?.data?.id === undefined || json.data.text === undefined) {
      throw new XPublishError(
        "BAD_RESPONSE",
        "POST /2/tweets did not return data.id / data.text",
        { url: "/2/tweets" },
      );
    }
    return { id: json.data.id, text: json.data.text };
  };

  const postThread = async (input: PostThreadInput): Promise<PostThreadResult> => {
    if (input.tweets.length === 0) {
      return { tweets: [] };
    }
    const results: Tweet[] = [];
    let replyTo: string | undefined;
    let partial: PostThreadResult["partialFailure"];
    for (let i = 0; i < input.tweets.length; i += 1) {
      if (i > 0 && input.replyDelayMs !== undefined) {
        await sleep(randomDelayMs(input.replyDelayMs));
      }
      const text = input.tweets[i]!;
      const tweetInput: PostTweetInput = { text };
      if (replyTo !== undefined) tweetInput.replyToTweetId = replyTo;
      if (i === 0 && input.firstTweetMediaIds !== undefined) {
        tweetInput.mediaIds = input.firstTweetMediaIds;
      }
      if (input.signal !== undefined) tweetInput.signal = input.signal;
      try {
        const t = await postTweet(tweetInput);
        results.push(t);
        replyTo = t.id;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (results.length === 0) throw err;
        if (input.continueOnFailure !== true) {
          partial = { atIndex: i, message };
          break;
        }
        partial = { atIndex: i, message };
        // 跳过失败条，后续推文仍 reply 到最后一条成功推文
        continue;
      }
    }
    const head = results[0];
    const result: PostThreadResult = {
      tweets: results,
      ...(head !== undefined ? { threadUrl: `https://x.com/i/status/${head.id}` } : {}),
    };
    if (partial !== undefined) result.partialFailure = partial;
    return result;
  };

  const whoami = async (signal?: AbortSignal): Promise<WhoamiResult> => {
    const reqOpts: RequestOpts = { method: "GET", path: "/2/users/me" };
    if (signal !== undefined) reqOpts.signal = signal;
    const json = (await authedRequest(reqOpts)) as {
      data?: { id?: string; username?: string; name?: string };
    };
    if (json?.data?.id === undefined || json.data.username === undefined) {
      throw new XPublishError("BAD_RESPONSE", "GET /2/users/me did not return data.id/username", {
        url: "/2/users/me",
      });
    }
    const r: WhoamiResult = { id: json.data.id, username: json.data.username };
    if (json.data.name !== undefined) r.name = json.data.name;
    return r;
  };

  return { postTweet, postThread, whoami, uploadTweetImage };
};
