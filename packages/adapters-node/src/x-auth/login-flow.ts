import open from "open";
import {
  XAuthError,
  type StoredCredentials,
  type XAppConfig,
  type XAuthPort,
  type XUserSummary,
} from "@yt2x/core";
import { buildAuthorizeUrl } from "./authorize-url.js";
import { startLoopbackServer, type LoopbackServerHandle } from "./loopback-server.js";
import { generatePkcePair, generateState, timingSafeStringEqual } from "./pkce.js";
import {
  exchangeCodeForTokens,
  fetchUsersMe,
  refreshTokens,
  revokeToken,
  type Fetcher,
} from "./token-client.js";
import { createTokenStore, defaultCredentialsPath, type TokenStore } from "./token-store.js";

const REFRESH_LEEWAY_MS = 60_000;

export type CreateXAuthAdapterOptions = {
  app: XAppConfig;
  /** 默认 127.0.0.1 */
  loopbackHost?: string;
  /** 默认从 app.redirectUri 解析；显式覆盖时优先 */
  loopbackPort?: number;
  fetcher?: Fetcher;
  /** 默认走真实浏览器；测试时可注入 noop */
  openBrowser?: (url: string) => Promise<void>;
  /** 默认 ~/.config/yt2x/credentials.json */
  credentialsPath?: string;
  /** 提示用户「请在浏览器完成授权」时的回调，方便 CLI 自定义文案 */
  onAuthorizeUrl?: (url: string) => void;
  /** 默认 5 分钟。用户没在期限内完成 → USER_CANCELLED */
  timeoutMs?: number;
};

type ParsedRedirect = { host: string; port: number; path: string };

const parseRedirectUri = (uri: string): ParsedRedirect => {
  const url = new URL(uri);
  if (url.protocol !== "http:") {
    throw new XAuthError(
      "BAD_RESPONSE",
      `redirect_uri must use http loopback for CLI flow, got ${url.protocol}`,
    );
  }
  if (url.hostname !== "127.0.0.1") {
    throw new XAuthError(
      "BAD_RESPONSE",
      `redirect_uri must use the 127.0.0.1 loopback literal (X rejects "localhost"). Got "${url.hostname}".`,
    );
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new XAuthError("BAD_RESPONSE", `redirect_uri must specify an explicit port, got "${url.port}"`);
  }
  return { host: url.hostname, port, path: url.pathname || "/callback" };
};

const defaultOpenBrowser = async (url: string): Promise<void> => {
  await open(url);
};

export const createXAuthAdapter = (opts: CreateXAuthAdapterOptions): XAuthPort => {
  const credentialsPath = opts.credentialsPath ?? defaultCredentialsPath();
  const store: TokenStore = createTokenStore(credentialsPath);
  const fetcher = opts.fetcher ?? fetch;
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser;
  const redirect = parseRedirectUri(opts.app.redirectUri);
  const host = opts.loopbackHost ?? redirect.host;
  const port = opts.loopbackPort ?? redirect.port;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  const login: XAuthPort["login"] = async ({ profile, signal } = {}) => {
    const pkce = generatePkcePair();
    const state = generateState();

    let server: LoopbackServerHandle | undefined;
    const cleanup = async (): Promise<void> => {
      if (server !== undefined) {
        await server.close();
      }
    };

    try {
      server = await startLoopbackServer({
        port,
        host,
        path: redirect.path,
        ...(signal !== undefined ? { signal } : {}),
      });
      const authorizeUrl = buildAuthorizeUrl({
        app: opts.app,
        state,
        codeChallenge: pkce.codeChallenge,
      });
      opts.onAuthorizeUrl?.(authorizeUrl);
      await openBrowser(authorizeUrl);

      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
      const callback = await Promise.race([
        server.result,
        new Promise<never>((_, reject) => {
          timeoutController.signal.addEventListener("abort", () => {
            reject(
              new XAuthError(
                "USER_CANCELLED",
                `OAuth flow timed out after ${Math.round(timeoutMs / 1000)}s without callback`,
              ),
            );
          });
        }),
      ]);
      clearTimeout(timer);

      if (!callback.ok) {
        if (callback.error === "user_cancelled") {
          throw new XAuthError("USER_CANCELLED", "Authorization was cancelled before completion");
        }
        const detail = callback.errorDescription ?? "(no description)";
        throw new XAuthError("BAD_RESPONSE", `Authorization failed: ${callback.error} — ${detail}`);
      }
      if (!timingSafeStringEqual(callback.state, state)) {
        throw new XAuthError(
          "STATE_MISMATCH",
          "OAuth state mismatch — the callback did not come from the same authorization request",
        );
      }

      const tokens = await exchangeCodeForTokens({
        app: opts.app,
        code: callback.code,
        codeVerifier: pkce.codeVerifier,
        fetcher,
      });

      let user: XUserSummary | undefined;
      try {
        user = await fetchUsersMe({ accessToken: tokens.accessToken, fetcher });
      } catch (err: unknown) {
        if (!(err instanceof XAuthError) || err.code !== "NETWORK") throw err;
        // 联网失败：先存好 token，让用户后续 `yt2x auth whoami` 重试。
      }

      const now = Date.now();
      const stored: StoredCredentials = {
        provider: "x",
        clientId: opts.app.clientId,
        tokens,
        createdAt: now,
        updatedAt: now,
        ...(user !== undefined ? { user } : {}),
      };
      await store.write(stored, profile);
      return stored;
    } finally {
      await cleanup();
    }
  };

  const status: XAuthPort["status"] = async ({ profile } = {}) => store.read(profile);

  const refresh: XAuthPort["refresh"] = async ({ profile } = {}) => {
    const existing = await store.read(profile);
    if (existing === null) {
      throw new XAuthError("NOT_LOGGED_IN", "No credentials found. Run `yt2x auth login` first.");
    }
    if (existing.tokens.refreshToken === undefined) {
      throw new XAuthError(
        "REFRESH_FAILED",
        "Stored credentials have no refresh token. Add `offline.access` to scopes and login again.",
      );
    }
    const next = await refreshTokens({
      app: opts.app,
      refreshToken: existing.tokens.refreshToken,
      previousScope: existing.tokens.scope,
      fetcher,
    });
    const merged: StoredCredentials = {
      ...existing,
      tokens: {
        ...next,
        refreshToken: next.refreshToken ?? existing.tokens.refreshToken,
      },
      updatedAt: Date.now(),
    };
    await store.write(merged, profile);
    return merged;
  };

  const logout: XAuthPort["logout"] = async ({ profile } = {}) => {
    const existing = await store.read(profile);
    if (existing === null) return;
    const revokeTargets: Array<{ token: string; hint: "access_token" | "refresh_token" }> = [];
    if (existing.tokens.refreshToken !== undefined) {
      revokeTargets.push({ token: existing.tokens.refreshToken, hint: "refresh_token" });
    }
    revokeTargets.push({ token: existing.tokens.accessToken, hint: "access_token" });
    for (const target of revokeTargets) {
      try {
        await revokeToken({
          app: opts.app,
          token: target.token,
          tokenTypeHint: target.hint,
          fetcher,
        });
      } catch {
        // 撤销失败也要继续删本地，避免用户被 server 卡住。CLI 会另行提示。
      }
    }
    await store.delete(profile);
  };

  const whoami: XAuthPort["whoami"] = async ({ profile } = {}) => {
    let creds = await store.read(profile);
    if (creds === null) {
      throw new XAuthError("NOT_LOGGED_IN", "No credentials found. Run `yt2x auth login` first.");
    }
    if (creds.tokens.expiresAt - Date.now() < REFRESH_LEEWAY_MS) {
      try {
        creds = await refresh(profile !== undefined ? { profile } : {});
      } catch (err: unknown) {
        if (err instanceof XAuthError && err.code === "REFRESH_FAILED") {
          throw new XAuthError("TOKEN_EXPIRED", err.message);
        }
        throw err;
      }
    }
    return fetchUsersMe({ accessToken: creds.tokens.accessToken, fetcher });
  };

  return { login, refresh, logout, status, whoami };
};
