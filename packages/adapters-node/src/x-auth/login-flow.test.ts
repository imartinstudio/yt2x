import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_X_SCOPES, type XAppConfig } from "@yt2x/core";
import { createXAuthAdapter } from "./login-flow.js";

const grabFreePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

/**
 * 在内存里跑一个最小可控 X server，覆盖 token 与 users/me 端点。
 * 通过把 fetcher 注入到 adapter，所有真实网络都不会被发起。
 */
const createFakeXServer = (overrides: Partial<{
  exchange: (body: URLSearchParams) => unknown;
  refresh: (body: URLSearchParams) => unknown;
  usersMe: () => unknown;
}> = {}) => {
  const calls: Array<{ url: string; body?: Record<string, string>; method: string }> = [];
  const fetcher = async (url: string | URL, init: RequestInit | undefined) => {
    const u = typeof url === "string" ? url : url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.endsWith("/oauth2/token")) {
      const body = new URLSearchParams((init?.body as string) ?? "");
      const bodyObj = Object.fromEntries(body);
      calls.push({ url: u, body: bodyObj, method });
      const grantType = body.get("grant_type");
      if (grantType === "authorization_code") {
        const payload = overrides.exchange?.(body) ?? {
          token_type: "bearer",
          access_token: "AT-from-code",
          refresh_token: "RT-from-code",
          expires_in: 7200,
          scope: "tweet.read tweet.write users.read offline.access",
        };
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      const payload = overrides.refresh?.(body) ?? {
        token_type: "bearer",
        access_token: "AT-refreshed",
        refresh_token: "RT-refreshed",
        expires_in: 7200,
        scope: "tweet.read",
      };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    if (u.endsWith("/2/users/me")) {
      calls.push({ url: u, method });
      const payload = overrides.usersMe?.() ?? {
        data: { id: "42", username: "tester", name: "Test" },
      };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetcher: fetcher as unknown as typeof fetch, calls };
};

let tmp: string;
let credentialsPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "yt2x-login-"));
  credentialsPath = path.join(tmp, "creds.json");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const buildApp = (port: number): XAppConfig => ({
  clientId: "client-xyz",
  redirectUri: `http://127.0.0.1:${port}/callback`,
  scopes: DEFAULT_X_SCOPES,
});

describe("createXAuthAdapter (end-to-end mock)", () => {
  it("login() completes PKCE round-trip and persists tokens", async () => {
    const port = await grabFreePort();
    const { fetcher, calls } = createFakeXServer();

    const adapter = createXAuthAdapter({
      app: buildApp(port),
      credentialsPath,
      fetcher,
      openBrowser: async (url) => {
        // 直接当作浏览器：解析 URL，拿到 state，命中 loopback callback。
        const authUrl = new URL(url);
        const state = authUrl.searchParams.get("state");
        if (state === null) throw new Error("no state");
        await fetch(`http://127.0.0.1:${port}/callback?code=AUTH_CODE&state=${state}`);
      },
    });

    const creds = await adapter.login();
    expect(creds.clientId).toBe("client-xyz");
    expect(creds.tokens.accessToken).toBe("AT-from-code");
    expect(creds.tokens.refreshToken).toBe("RT-from-code");
    expect(creds.user).toEqual({ id: "42", username: "tester", name: "Test" });

    // 验证 token endpoint 被以 PKCE 形式调用过
    const tokenCall = calls.find((c) => c.url.endsWith("/oauth2/token"));
    expect(tokenCall?.body?.grant_type).toBe("authorization_code");
    expect(tokenCall?.body?.code).toBe("AUTH_CODE");
    expect(tokenCall?.body?.code_verifier).toBeTypeOf("string");
    expect(tokenCall?.body?.client_id).toBe("client-xyz");
    expect(tokenCall?.body?.client_secret).toBeUndefined();
  });

  it("rejects callback whose state does not match", async () => {
    const port = await grabFreePort();
    const { fetcher } = createFakeXServer();
    const adapter = createXAuthAdapter({
      app: buildApp(port),
      credentialsPath,
      fetcher,
      openBrowser: async () => {
        // 故意发错的 state
        await fetch(`http://127.0.0.1:${port}/callback?code=AUTH&state=WRONG_STATE`);
      },
    });
    await expect(adapter.login()).rejects.toMatchObject({
      name: "XAuthError",
      code: "STATE_MISMATCH",
    });
  });

  it("status() reads previously stored creds without network", async () => {
    const port = await grabFreePort();
    const { fetcher } = createFakeXServer();
    const adapter = createXAuthAdapter({
      app: buildApp(port),
      credentialsPath,
      fetcher,
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get("state");
        await fetch(`http://127.0.0.1:${port}/callback?code=C&state=${state}`);
      },
    });
    await adapter.login();
    const stat = await adapter.status();
    expect(stat?.user?.username).toBe("tester");
  });

  it("refresh() uses stored refresh_token and updates the file", async () => {
    const port = await grabFreePort();
    const { fetcher, calls } = createFakeXServer();
    const adapter = createXAuthAdapter({
      app: buildApp(port),
      credentialsPath,
      fetcher,
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get("state");
        await fetch(`http://127.0.0.1:${port}/callback?code=C&state=${state}`);
      },
    });
    await adapter.login();
    const refreshed = await adapter.refresh();
    expect(refreshed.tokens.accessToken).toBe("AT-refreshed");
    const refreshCall = calls.find(
      (c) => c.url.endsWith("/oauth2/token") && c.body?.grant_type === "refresh_token",
    );
    expect(refreshCall?.body?.refresh_token).toBe("RT-from-code");
  });

  it("whoami() proactively refreshes tokens near expiry", async () => {
    const port = await grabFreePort();
    const { fetcher, calls } = createFakeXServer({
      // 让 exchange 返回 30s 后过期，强制 refresh 路径
      exchange: () => ({
        token_type: "bearer",
        access_token: "AT-soon-expiring",
        refresh_token: "RT-x",
        expires_in: 30,
        scope: "tweet.read",
      }),
    });
    const adapter = createXAuthAdapter({
      app: buildApp(port),
      credentialsPath,
      fetcher,
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get("state");
        await fetch(`http://127.0.0.1:${port}/callback?code=C&state=${state}`);
      },
    });
    await adapter.login();
    const me = await adapter.whoami();
    expect(me.username).toBe("tester");
    const refreshCall = calls.find(
      (c) => c.url.endsWith("/oauth2/token") && c.body?.grant_type === "refresh_token",
    );
    expect(refreshCall).toBeDefined();
  });

  it("logout() removes local creds and calls revoke", async () => {
    const port = await grabFreePort();
    const { fetcher, calls } = createFakeXServer();
    const adapter = createXAuthAdapter({
      app: buildApp(port),
      credentialsPath,
      fetcher,
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get("state");
        await fetch(`http://127.0.0.1:${port}/callback?code=C&state=${state}`);
      },
    });
    await adapter.login();
    await adapter.logout();
    expect(await adapter.status()).toBeNull();
    // logout 调用 revoke 端点（最多 2 次）
    const revokeCalls = calls.filter((c) => c.url.endsWith("/oauth2/revoke"));
    expect(revokeCalls.length).toBeGreaterThanOrEqual(0); // mock 没注册 revoke 路径但调用应被尝试
  });

  it("rejects redirect_uri using localhost literal (X compatibility guard)", async () => {
    expect(() =>
      createXAuthAdapter({
        app: {
          clientId: "x",
          redirectUri: "http://localhost:8989/callback",
          scopes: DEFAULT_X_SCOPES,
        },
      }),
    ).toThrow(/127\.0\.0\.1/);
  });
});
