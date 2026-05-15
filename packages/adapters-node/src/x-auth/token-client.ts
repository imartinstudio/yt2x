import { XAuthError, type OAuth2Tokens, type XAppConfig, type XUserSummary } from "@yt2x/core";
import { X_OAUTH_ENDPOINTS } from "./authorize-url.js";

type RawTokenResponse = {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type RawUserResponse = {
  data?: {
    id?: string;
    username?: string;
    name?: string;
  };
  errors?: Array<{ message?: string; detail?: string }>;
};

export type Fetcher = typeof fetch;

const DEFAULT_TIMEOUT_MS = 15_000;

/** 合并外部 signal 与超时；返回的 signal 须传入 fetch。 */
const mergeAbortSignal = (
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("token request timed out")), timeoutMs);
  const clear = (): void => clearTimeout(timer);
  if (outer !== undefined) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener("abort", () => ctrl.abort(outer.reason), { once: true });
  }
  return { signal: ctrl.signal, clear };
};

const parseTokenResponse = (raw: RawTokenResponse, previousScope?: string): OAuth2Tokens => {
  if (raw.error !== undefined) {
    throw new XAuthError(
      "BAD_RESPONSE",
      `Token endpoint error: ${raw.error}${raw.error_description ? ` — ${raw.error_description}` : ""}`,
    );
  }
  const tokenType = raw.token_type?.toLowerCase();
  if (tokenType !== "bearer") {
    throw new XAuthError(
      "BAD_RESPONSE",
      `Unexpected token_type "${raw.token_type ?? "(missing)"}". Only "bearer" is supported.`,
    );
  }
  if (typeof raw.access_token !== "string" || raw.access_token.length === 0) {
    throw new XAuthError("BAD_RESPONSE", "Token endpoint did not return access_token");
  }
  if (typeof raw.expires_in !== "number" || raw.expires_in <= 0) {
    throw new XAuthError("BAD_RESPONSE", "Token endpoint did not return a valid expires_in");
  }
  const expiresAt = Date.now() + raw.expires_in * 1000;
  const scopeFromResponse = raw.scope?.trim() ?? "";
  const tokens: OAuth2Tokens = {
    accessToken: raw.access_token,
    tokenType: "bearer",
    expiresAt,
    scope: scopeFromResponse.length > 0 ? scopeFromResponse : (previousScope?.trim() ?? ""),
  };
  if (typeof raw.refresh_token === "string" && raw.refresh_token.length > 0) {
    tokens.refreshToken = raw.refresh_token;
  }
  return tokens;
};

const basicAuthHeader = (clientId: string, clientSecret: string): string => {
  const credentials = `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
};

const postForm = async (
  url: string,
  body: URLSearchParams,
  opts: {
    app: XAppConfig;
    fetcher: Fetcher;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<unknown> => {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (opts.app.clientSecret !== undefined && opts.app.clientSecret.length > 0) {
    headers.authorization = basicAuthHeader(opts.app.clientId, opts.app.clientSecret);
  } else {
    body.set("client_id", opts.app.clientId);
  }
  const { signal, clear } = mergeAbortSignal(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const init: RequestInit = {
    method: "POST",
    headers,
    body: body.toString(),
    signal,
  };
  let resp: Response;
  try {
    resp = await opts.fetcher(url, init);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new XAuthError("NETWORK", `Network failure calling ${url}: ${message}`);
  } finally {
    clear();
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new XAuthError("BAD_RESPONSE", `Token endpoint returned non-JSON body: ${message}`);
  }
  if (!resp.ok) {
    const raw = json as RawTokenResponse;
    throw new XAuthError(
      "BAD_RESPONSE",
      `Token endpoint HTTP ${resp.status}: ${raw.error ?? "(no error code)"}${raw.error_description ? ` — ${raw.error_description}` : ""}`,
    );
  }
  return json;
};

export type ExchangeCodeInput = {
  app: XAppConfig;
  code: string;
  codeVerifier: string;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export const exchangeCodeForTokens = async (input: ExchangeCodeInput): Promise<OAuth2Tokens> => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.app.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const json = (await postForm(X_OAUTH_ENDPOINTS.token, body, {
    app: input.app,
    fetcher: input.fetcher ?? fetch,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  })) as RawTokenResponse;
  return parseTokenResponse(json);
};

export type RefreshTokensInput = {
  app: XAppConfig;
  refreshToken: string;
  /** X refresh 响应常省略 scope；须保留登录时的 scope 供 publish 校验。 */
  previousScope?: string;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export const refreshTokens = async (input: RefreshTokensInput): Promise<OAuth2Tokens> => {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  try {
    const json = (await postForm(X_OAUTH_ENDPOINTS.token, body, {
      app: input.app,
      fetcher: input.fetcher ?? fetch,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    })) as RawTokenResponse;
    return parseTokenResponse(json, input.previousScope);
  } catch (err: unknown) {
    if (err instanceof XAuthError && err.code === "BAD_RESPONSE") {
      throw new XAuthError("REFRESH_FAILED", err.message);
    }
    throw err;
  }
};

export type RevokeTokenInput = {
  app: XAppConfig;
  token: string;
  tokenTypeHint?: "access_token" | "refresh_token";
  fetcher?: Fetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export const revokeToken = async (input: RevokeTokenInput): Promise<void> => {
  const body = new URLSearchParams({ token: input.token });
  if (input.tokenTypeHint !== undefined) {
    body.set("token_type_hint", input.tokenTypeHint);
  }
  try {
    await postForm(X_OAUTH_ENDPOINTS.revoke, body, {
      app: input.app,
      fetcher: input.fetcher ?? fetch,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
  } catch (err: unknown) {
    if (err instanceof XAuthError && err.code === "BAD_RESPONSE") {
      throw new XAuthError("REVOKE_FAILED", err.message);
    }
    throw err;
  }
};

export type FetchUsersMeInput = {
  accessToken: string;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export const fetchUsersMe = async (input: FetchUsersMeInput): Promise<XUserSummary> => {
  const fetcher = input.fetcher ?? fetch;
  const init: RequestInit = {
    method: "GET",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      accept: "application/json",
    },
  };
  const { signal, clear } = mergeAbortSignal(input.signal, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  init.signal = signal;
  let resp: Response;
  try {
    resp = await fetcher(X_OAUTH_ENDPOINTS.usersMe, init);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new XAuthError("NETWORK", `Network failure calling /2/users/me: ${message}`);
  } finally {
    clear();
  }
  let json: RawUserResponse;
  try {
    json = (await resp.json()) as RawUserResponse;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new XAuthError("BAD_RESPONSE", `/2/users/me returned non-JSON: ${message}`);
  }
  if (resp.status === 401) {
    throw new XAuthError("TOKEN_EXPIRED", "Access token rejected by /2/users/me");
  }
  if (!resp.ok) {
    const detail = json.errors?.[0]?.detail ?? json.errors?.[0]?.message ?? "(no detail)";
    throw new XAuthError("BAD_RESPONSE", `/2/users/me HTTP ${resp.status}: ${detail}`);
  }
  const data = json.data;
  if (data === undefined || typeof data.id !== "string" || typeof data.username !== "string") {
    throw new XAuthError("BAD_RESPONSE", "/2/users/me missing required fields");
  }
  const summary: XUserSummary = { id: data.id, username: data.username };
  if (typeof data.name === "string") summary.name = data.name;
  return summary;
};
