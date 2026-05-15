/**
 * X 发布端口：用 OAuth 2.0 user-context bearer token 调 X v2 API。
 *
 * 设计原则：
 *  - 端口只描述业务行为，所有 HTTP / fetch / token store 都在 adapters-node。
 *  - 错误一律抛 `XPublishError`，kind 字段允许调用方做精准退出码/重试决策。
 *  - 长推 thread 切分是纯函数（@yt2x/core/domain/publish），与本端口无依赖。
 */

export type Tweet = {
  /** X 返回的 tweet id */
  id: string;
  /** X 返回的实际文本（可能被 X 标准化） */
  text: string;
};

export type PostTweetInput = {
  text: string;
  /** 把这条推作为某条推的回复（实现 thread 串联） */
  replyToTweetId?: string;
  /** v1.1/v2 media upload 返回的 media id 列表（仅首推附图） */
  mediaIds?: string[];
  signal?: AbortSignal;
};

export type PostThreadInput = {
  tweets: string[];
  /** 仅首推附图（X 推荐做法） */
  firstTweetMediaIds?: string[];
  /** 中途某条失败时是否继续发剩余条；默认 false：第一次失败立即停止 */
  continueOnFailure?: boolean;
  signal?: AbortSignal;
};

export type PostThreadResult = {
  /** 已成功发布的推（按顺序）；若中途失败则只包含成功部分 */
  tweets: Tweet[];
  /** 第一条推的 https URL；若一条都没成功发帖则为 `undefined`（勿用空字符串作哨兵） */
  threadUrl?: string;
  /** 中途失败原因（成功时为 undefined） */
  partialFailure?: { atIndex: number; message: string };
};

export type WhoamiResult = {
  id: string;
  username: string;
  name?: string;
};

export type XPublishErrorKind =
  | "AUTH" // 401/403 + refresh 也失败
  | "RATE_LIMITED" // 429
  | "FORBIDDEN" // 403（权限/scope 缺失）
  | "DUPLICATE" // 187 duplicate status
  | "BAD_REQUEST" // 400 其它
  | "SERVER" // 5xx
  | "NETWORK" // fetch 抛错
  | "BAD_RESPONSE" // 解析失败
  | "MEDIA_PROCESSING"; // 媒体异步处理失败或超时

export type XPublishErrorContext = {
  status?: number;
  retryAfterMs?: number;
  url?: string;
  detail?: string;
};

const XPUBLISH_ERROR_BRAND = Symbol.for("@yt2x/core/XPublishError");

export class XPublishError extends Error {
  public readonly kind: XPublishErrorKind;
  public readonly context: XPublishErrorContext;
  // 跨 realm（bundle/boundary）稳定的品牌标记，替代脆弱的 name 字符串比较
  public readonly [XPUBLISH_ERROR_BRAND] = true as const;

  public constructor(kind: XPublishErrorKind, message: string, context: XPublishErrorContext = {}) {
    super(message);
    this.name = "XPublishError";
    this.kind = kind;
    this.context = context;
  }
}

export const isXPublishError = (e: unknown): e is XPublishError =>
  e instanceof XPublishError ||
  (typeof e === "object" && e !== null && (e as { [XPUBLISH_ERROR_BRAND]?: boolean })[XPUBLISH_ERROR_BRAND] === true);

/** 推文附图 MIME（与 X v2 media upload 一致） */
export type TweetImageContentType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export type UploadTweetImageInput = {
  /** 图片二进制（端口层不携带本地路径，由 adapter/CLI 读盘） */
  bytes: Uint8Array;
  contentType: TweetImageContentType;
  signal?: AbortSignal;
};

export interface XPublishPort {
  postTweet(input: PostTweetInput): Promise<Tweet>;
  postThread(input: PostThreadInput): Promise<PostThreadResult>;
  whoami(signal?: AbortSignal): Promise<WhoamiResult>;
  /**
   * OAuth 2.0 + `media.write`：上传一张可附在推文上的图片，返回 `media_id`（供 POST /2/tweets `media.media_ids`）。
   * 小文件优先 one-shot；较大或 one-shot 失败时自动走 INIT/APPEND/FINALIZE + STATUS 轮询。
   */
  uploadTweetImage(input: UploadTweetImageInput): Promise<string>;
}
