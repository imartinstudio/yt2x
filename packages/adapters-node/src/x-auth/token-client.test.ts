import { describe, expect, it, vi } from "vitest";
import { DEFAULT_X_SCOPES, type XAppConfig } from "@yt2x/core";
import {
  exchangeCodeForTokens,
  fetchUsersMe,
  refreshTokens,
  revokeToken,
} from "./token-client.js";
import { X_OAUTH_ENDPOINTS } from "./authorize-url.js";

const baseApp: XAppConfig = {
  clientId: "public-client",
  redirectUri: "http://127.0.0.1:8989/callback",
  scopes: DEFAULT_X_SCOPES,
};

const confidentialApp: XAppConfig = {
  ...baseApp,
  clientSecret: "shh",
};

const makeFetch = (
  expected: (url: string, init: RequestInit) => Response | Promise<Response>,
) => vi.fn(async (url: string | URL, init?: RequestInit) =>
  expected(typeof url === "string" ? url : url.toString(), init ?? {}),
);

describe("exchangeCodeForTokens", () => {
  it("POSTs to the token endpoint with form body and parses tokens", async () => {
    const fetcher = makeFetch((url, init) => {
      expect(url).toBe(X_OAUTH_ENDPOINTS.token);
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({
        "content-type": "application/x-www-form-urlencoded",
      });
      const body = new URLSearchParams(init.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("AUTH_CODE");
      expect(body.get("code_verifier")).toBe("VERIFIER");
      expect(body.get("redirect_uri")).toBe("http://127.0.0.1:8989/callback");
      expect(body.get("client_id")).toBe("public-client");
      return new Response(
        JSON.stringify({
          token_type: "bearer",
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 7200,
          scope: "tweet.read tweet.write",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const tokens = await exchangeCodeForTokens({
      app: baseApp,
      code: "AUTH_CODE",
      codeVerifier: "VERIFIER",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(tokens.accessToken).toBe("AT");
    expect(tokens.refreshToken).toBe("RT");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(tokens.scope).toBe("tweet.read tweet.write");
  });

  it("uses Basic auth and omits client_id from body for confidential clients", async () => {
    const fetcher = makeFetch((_url, init) => {
      const auth = (init.headers as Record<string, string>).authorization;
      expect(auth).toMatch(/^Basic /);
      const body = new URLSearchParams(init.body as string);
      expect(body.get("client_id")).toBeNull();
      return new Response(
        JSON.stringify({
          token_type: "bearer",
          access_token: "AT",
          expires_in: 7200,
          scope: "tweet.read",
        }),
        { status: 200 },
      );
    });
    await exchangeCodeForTokens({
      app: confidentialApp,
      code: "C",
      codeVerifier: "V",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("maps HTTP 400 to XAuthError(BAD_RESPONSE)", async () => {
    const fetcher = makeFetch(() =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "bad code" }),
        { status: 400 },
      ),
    );
    await expect(
      exchangeCodeForTokens({
        app: baseApp,
        code: "x",
        codeVerifier: "y",
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "XAuthError", code: "BAD_RESPONSE" });
  });

  it("maps non-bearer token_type to BAD_RESPONSE", async () => {
    const fetcher = makeFetch(
      () =>
        new Response(
          JSON.stringify({
            token_type: "mac",
            access_token: "AT",
            expires_in: 7200,
            scope: "x",
          }),
          { status: 200 },
        ),
    );
    await expect(
      exchangeCodeForTokens({
        app: baseApp,
        code: "x",
        codeVerifier: "y",
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Unexpected token_type/);
  });

  it("maps fetcher rejection to XAuthError(NETWORK)", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      exchangeCodeForTokens({
        app: baseApp,
        code: "x",
        codeVerifier: "y",
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "XAuthError", code: "NETWORK" });
  });
});

describe("refreshTokens", () => {
  it("POSTs grant_type=refresh_token", async () => {
    const fetcher = makeFetch((_url, init) => {
      const body = new URLSearchParams(init.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("OLD_RT");
      return new Response(
        JSON.stringify({
          token_type: "bearer",
          access_token: "NEW_AT",
          refresh_token: "NEW_RT",
          expires_in: 7200,
          scope: "tweet.read",
        }),
        { status: 200 },
      );
    });
    const tokens = await refreshTokens({
      app: baseApp,
      refreshToken: "OLD_RT",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(tokens.accessToken).toBe("NEW_AT");
    expect(tokens.refreshToken).toBe("NEW_RT");
  });

  it("preserves previousScope when refresh response omits scope", async () => {
    const fetcher = makeFetch(() =>
      new Response(
        JSON.stringify({
          token_type: "bearer",
          access_token: "NEW_AT",
          expires_in: 7200,
        }),
        { status: 200 },
      ),
    );
    const tokens = await refreshTokens({
      app: baseApp,
      refreshToken: "OLD_RT",
      previousScope: "tweet.read tweet.write offline.access",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(tokens.scope).toBe("tweet.read tweet.write offline.access");
  });

  it("maps server error to REFRESH_FAILED (not BAD_RESPONSE)", async () => {
    const fetcher = makeFetch(
      () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
    );
    await expect(
      refreshTokens({
        app: baseApp,
        refreshToken: "BAD",
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "XAuthError", code: "REFRESH_FAILED" });
  });
});

describe("revokeToken", () => {
  it("POSTs to revoke endpoint with token_type_hint", async () => {
    const fetcher = makeFetch((url, init) => {
      expect(url).toBe(X_OAUTH_ENDPOINTS.revoke);
      const body = new URLSearchParams(init.body as string);
      expect(body.get("token")).toBe("TOK");
      expect(body.get("token_type_hint")).toBe("refresh_token");
      return new Response("{}", { status: 200 });
    });
    await revokeToken({
      app: baseApp,
      token: "TOK",
      tokenTypeHint: "refresh_token",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("fetchUsersMe", () => {
  it("returns parsed user on 200", async () => {
    const fetcher = makeFetch(
      () =>
        new Response(
          JSON.stringify({ data: { id: "1", username: "tester", name: "Test" } }),
          { status: 200 },
        ),
    );
    const user = await fetchUsersMe({
      accessToken: "AT",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(user).toEqual({ id: "1", username: "tester", name: "Test" });
  });

  it("maps 401 to TOKEN_EXPIRED", async () => {
    const fetcher = makeFetch(
      () => new Response(JSON.stringify({ errors: [{ detail: "Unauthorized" }] }), { status: 401 }),
    );
    await expect(
      fetchUsersMe({ accessToken: "AT", fetcher: fetcher as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "XAuthError", code: "TOKEN_EXPIRED" });
  });

  it("rejects body without data.id", async () => {
    const fetcher = makeFetch(
      () => new Response(JSON.stringify({ data: { username: "no-id" } }), { status: 200 }),
    );
    await expect(
      fetchUsersMe({ accessToken: "AT", fetcher: fetcher as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "XAuthError", code: "BAD_RESPONSE" });
  });
});
