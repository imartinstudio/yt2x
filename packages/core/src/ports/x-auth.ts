/**
 * X (Twitter) OAuth 2.0 PKCE 端口定义。
 *
 * 设计原则：
 *  - 端口只描述**业务行为**与**契约**，不关心 fetch / http server / 文件系统等实现细节。
 *  - 所有时间戳一律使用 epoch 毫秒（number），方便 JSON 序列化。
 *  - 所有"机密"字段（accessToken / refreshToken / clientSecret 若有）只在内存或 0600 文件中流转，
 *    永远不进 process.argv、不进 log、不出现在错误消息里。Adapter 必须遵守这一不变量。
 */

export type XScope =
  | "tweet.read"
  | "tweet.write"
  | "users.read"
  | "offline.access"
  | "media.write";

export const DEFAULT_X_SCOPES: readonly XScope[] = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
] as const;

export type XAppConfig = {
  clientId: string;
  /**
   * Public client（Native App）= undefined；Confidential client = 配 secret。
   * 当前 yt2x 推荐 Public client；该字段保留是为未来兼容。
   */
  clientSecret?: string;
  redirectUri: string;
  scopes: readonly XScope[];
};

export type OAuth2Tokens = {
  accessToken: string;
  /** 可选：用户没勾 offline.access 时不会有 refresh */
  refreshToken?: string;
  tokenType: "bearer";
  /** epoch ms，access token 过期点 */
  expiresAt: number;
  /** server 实际授予的 scope（可能少于请求的） */
  scope: string;
};

export type XUserSummary = {
  id: string;
  username: string;
  name?: string;
};

export type StoredCredentials = {
  provider: "x";
  clientId: string;
  tokens: OAuth2Tokens;
  user?: XUserSummary;
  createdAt: number;
  updatedAt: number;
};

export type CredentialsFileV1 = {
  version: 1;
  profiles: Record<string, StoredCredentials>;
};

/**
 * 高阶认证流程（login 一步到位、refresh、revoke）。
 * Adapter 内部组合 PKCE / authorize URL / loopback server / token client / token store 实现。
 */
export interface XAuthPort {
  /**
   * 启动一次完整 OAuth 2.0 PKCE 登录流程：
   *  1. 生成 verifier+challenge+state
   *  2. 拉起 loopback server（默认 127.0.0.1:8989）
   *  3. 自动在默认浏览器打开授权 URL
   *  4. 等待回调，校验 state，code+verifier 兑换 token
   *  5. 调 /2/users/me 拿用户摘要
   *  6. 写入 credentials file
   *
   * 完成后返回最终凭证。被 AbortSignal 中止时清理 server 与临时 state。
   */
  login(opts?: { profile?: string; signal?: AbortSignal }): Promise<StoredCredentials>;

  /** 用 refresh token 刷新；不存在或失败时 throw */
  refresh(opts?: { profile?: string }): Promise<StoredCredentials>;

  /** 撤销 token 并删除本地凭证。不存在视为 noop */
  logout(opts?: { profile?: string }): Promise<void>;

  /** 读取当前凭证（不刷新、不联网） */
  status(opts?: { profile?: string }): Promise<StoredCredentials | null>;

  /**
   * 联网验证 token 是否仍然有效（hits /2/users/me）。
   * 若 access token 60s 内将过期，会自动尝试一次 refresh。
   */
  whoami(opts?: { profile?: string }): Promise<XUserSummary>;
}

/** 端口层错误：adapter 层抛出，CLI 层据此映射退出码 */
export class XAuthError extends Error {
  readonly code: XAuthErrorCode;
  constructor(code: XAuthErrorCode, message: string) {
    super(message);
    this.name = "XAuthError";
    this.code = code;
  }
}

export type XAuthErrorCode =
  | "NOT_LOGGED_IN"
  | "TOKEN_EXPIRED"
  | "REFRESH_FAILED"
  | "STATE_MISMATCH"
  | "USER_CANCELLED"
  | "PORT_IN_USE"
  | "NETWORK"
  | "BAD_RESPONSE"
  | "REVOKE_FAILED"
  | "UNKNOWN";
