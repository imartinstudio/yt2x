import {
  XAuthError,
  type OAuth2Tokens,
  type StoredCredentials,
  type XAppConfig,
} from "@yt2x/core";
import { refreshTokens, type Fetcher } from "../x-auth/token-client.js";
import type { TokenStore } from "../x-auth/token-store.js";

export type TokenSourceOptions = {
  store: TokenStore;
  /** profile name, 默认 "default" */
  profile?: string;
  /**
   * 剩余有效期 < 该值（毫秒）即触发主动 refresh。
   * 默认 60_000（60 秒），覆盖网络抖动 + 时钟漂移。
   */
  refreshSkewMs?: number;
  /** 注入用 fetch（测试 mock） */
  fetcher?: Fetcher;
  /**
   * 注入 XAppConfig；若不传则从 stored credentials 的 clientId 重建一个最小 config。
   * refresh_token grant 只用 clientId，redirectUri / scopes 不参与。
   */
  app?: XAppConfig;
};

export interface TokenSource {
  /** 拿一个"返回时刻仍然有效"的 access token；过期则自动 refresh。 */
  getAccessToken(signal?: AbortSignal): Promise<string>;
  /** 强制 refresh（401 重试场景调用）。 */
  forceRefresh(signal?: AbortSignal): Promise<string>;
  /** 当前 token 的 scope 字符串数组（用于 publish 前检查 media.write 等） */
  getScopes(): Promise<string[]>;
  /** 拿一份 StoredCredentials 快照，主要供 whoami 等用户信息读取 */
  getStored(): Promise<StoredCredentials>;
}

export class NoCredentialsError extends Error {
  public constructor(profile: string) {
    super(
      `No X credentials found for profile "${profile}". Run \`yt2x auth login\` first.`,
    );
    this.name = "NoCredentialsError";
  }
}

export class NoRefreshTokenError extends Error {
  public constructor() {
    super(
      'Access token expired but no refresh_token was issued. Re-login with `yt2x auth login` (offline.access scope is required).',
    );
    this.name = "NoRefreshTokenError";
  }
}

const reconstructAppConfig = (clientId: string): XAppConfig => ({
  clientId,
  redirectUri: "http://127.0.0.1:8989/callback",
  scopes: [],
});

export const createTokenSource = (opts: TokenSourceOptions): TokenSource => {
  const profile = opts.profile ?? "default";
  const skew = opts.refreshSkewMs ?? 60_000;

  let cached: StoredCredentials | null = null;
  let inflight: Promise<string> | null = null;

  const loadFromStore = async (): Promise<StoredCredentials> => {
    const creds = await opts.store.read(profile);
    if (creds === null) throw new NoCredentialsError(profile);
    cached = creds;
    return creds;
  };

  const needsRefresh = (creds: StoredCredentials, now: number): boolean =>
    creds.tokens.expiresAt - now < skew;

  const runRefresh = async (signal: AbortSignal | undefined): Promise<string> => {
    const creds = cached ?? (await loadFromStore());
    if (creds.tokens.refreshToken === undefined) throw new NoRefreshTokenError();

    const app = opts.app ?? reconstructAppConfig(creds.clientId);
    let next: OAuth2Tokens;
    try {
      next = await refreshTokens({
        app,
        refreshToken: creds.tokens.refreshToken,
        previousScope: creds.tokens.scope,
        ...(opts.fetcher !== undefined ? { fetcher: opts.fetcher } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err: unknown) {
      // refresh 失败 → 通常 invalid_grant；清缓存让下次 getStored 重读
      cached = null;
      throw err;
    }

    // X 在 refresh 时可能不重发 refresh_token；保留旧值
    const mergedTokens: OAuth2Tokens = {
      ...next,
      ...(next.refreshToken === undefined
        ? { refreshToken: creds.tokens.refreshToken }
        : {}),
    };
    const merged: StoredCredentials = {
      ...creds,
      tokens: mergedTokens,
      updatedAt: Date.now(),
    };
    await opts.store.write(merged, profile);
    cached = merged;
    return merged.tokens.accessToken;
  };

  const refreshOnce = (signal: AbortSignal | undefined): Promise<string> => {
    if (inflight !== null) return inflight;
    inflight = runRefresh(signal).finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    async getAccessToken(signal) {
      const creds = cached ?? (await loadFromStore());
      if (!needsRefresh(creds, Date.now())) return creds.tokens.accessToken;
      return refreshOnce(signal);
    },
    async forceRefresh(signal) {
      cached = await loadFromStore();
      return refreshOnce(signal);
    },
    async getScopes() {
      const creds = cached ?? (await loadFromStore());
      return creds.tokens.scope.split(/\s+/).filter((s) => s.length > 0);
    },
    async getStored() {
      return cached ?? (await loadFromStore());
    },
  };
};

/** 把任意 thrown value 归一化成 XAuthError 或原样；adapters 内部小工具 */
export const ensureAuthError = (err: unknown): Error => {
  if (err instanceof XAuthError) return err;
  if (err instanceof Error) return err;
  return new Error(String(err));
};
