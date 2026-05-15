import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentials } from "@yt2x/core";
import { createTokenStore } from "../x-auth/token-store.js";
import {
  NoCredentialsError,
  NoRefreshTokenError,
  createTokenSource,
} from "./token-source.js";

let dir: string;
let credsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yt2x-tokensrc-"));
  credsPath = path.join(dir, "credentials.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const seedCreds = async (overrides: Partial<StoredCredentials["tokens"]> = {}) => {
  const store = createTokenStore(credsPath);
  const tokens: StoredCredentials["tokens"] = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    tokenType: "bearer",
    expiresAt: Date.now() + 3600_000,
    scope: "tweet.read tweet.write users.read offline.access",
    ...overrides,
  };
  const creds: StoredCredentials = {
    provider: "x",
    clientId: "client-abc",
    tokens,
    user: { id: "u1", username: "alice" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.write(creds);
  return store;
};

const mockFetcher = (
  responder: (url: string, body: URLSearchParams) => Response | Promise<Response>,
) =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const body = new URLSearchParams((init?.body as string) ?? "");
    return responder(u, body);
  });

const tokenResponse = (overrides: Record<string, unknown> = {}): Response =>
  new Response(
    JSON.stringify({
      token_type: "bearer",
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 7200,
      scope: "tweet.read tweet.write users.read offline.access",
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("createTokenSource", () => {
  it("throws NoCredentialsError when profile missing", async () => {
    const store = createTokenStore(credsPath);
    const src = createTokenSource({ store });
    await expect(src.getAccessToken()).rejects.toBeInstanceOf(NoCredentialsError);
  });

  it("returns cached access token when not near expiry", async () => {
    const store = await seedCreds();
    const fetcher = mockFetcher(() => tokenResponse());
    const src = createTokenSource({ store, fetcher });
    expect(await src.getAccessToken()).toBe("old-access");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refreshes when expiresAt is within skew window", async () => {
    const store = await seedCreds({ expiresAt: Date.now() + 1000 }); // 1s left, skew 60s
    const fetcher = mockFetcher(() => tokenResponse());
    const src = createTokenSource({ store, fetcher });
    const token = await src.getAccessToken();
    expect(token).toBe("new-access");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("persists refreshed tokens back to store", async () => {
    const store = await seedCreds({ expiresAt: Date.now() + 1000 });
    const fetcher = mockFetcher(() => tokenResponse());
    const src = createTokenSource({ store, fetcher });
    await src.getAccessToken();
    const reread = await store.read();
    expect(reread?.tokens.accessToken).toBe("new-access");
    expect(reread?.tokens.refreshToken).toBe("new-refresh");
  });

  it("forceRefresh always hits the token endpoint", async () => {
    const store = await seedCreds(); // long-lived
    const fetcher = mockFetcher(() => tokenResponse());
    const src = createTokenSource({ store, fetcher });
    await src.getAccessToken(); // cached
    expect(fetcher).not.toHaveBeenCalled();
    const newer = await src.forceRefresh();
    expect(newer).toBe("new-access");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("dedupes concurrent refresh calls into one HTTP request", async () => {
    const store = await seedCreds({ expiresAt: Date.now() + 500 });
    let resolveFn: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((r) => {
      resolveFn = r;
    });
    const fetcher = vi.fn(() => pending);
    const src = createTokenSource({ store, fetcher });
    const a = src.getAccessToken();
    const b = src.getAccessToken();
    // 等 loadFromStore (真实 fs read) + microtasks 跑完
    for (let i = 0; i < 50 && fetcher.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fetcher).toHaveBeenCalledOnce();
    resolveFn(tokenResponse());
    expect(await a).toBe("new-access");
    expect(await b).toBe("new-access");
    expect(fetcher).toHaveBeenCalledOnce(); // 整个流程总共只一次
  });

  it("preserves old refresh_token when token endpoint omits it", async () => {
    const store = await seedCreds({ expiresAt: Date.now() + 500 });
    const fetcher = mockFetcher(() => tokenResponse({ refresh_token: undefined }));
    const src = createTokenSource({ store, fetcher });
    await src.getAccessToken();
    const reread = await store.read();
    expect(reread?.tokens.refreshToken).toBe("old-refresh");
  });

  it("throws NoRefreshTokenError when refresh required but none stored", async () => {
    const store = await seedCreds({
      expiresAt: Date.now() + 500,
      refreshToken: undefined,
    });
    const src = createTokenSource({ store });
    await expect(src.getAccessToken()).rejects.toBeInstanceOf(NoRefreshTokenError);
  });

  it("getScopes splits the stored scope string", async () => {
    const store = await seedCreds();
    const src = createTokenSource({ store });
    expect(await src.getScopes()).toEqual([
      "tweet.read",
      "tweet.write",
      "users.read",
      "offline.access",
    ]);
  });
});
