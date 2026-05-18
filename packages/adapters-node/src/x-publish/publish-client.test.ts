import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isXPublishError } from "@yt2x/core";
import { createXPublishAdapter } from "./publish-client.js";
import type { TokenSource } from "./token-source.js";

const makeTokenSource = (tokenSeq: string[] = ["tok1"]): TokenSource & {
  forceRefreshCount: () => number;
  getAccessCount: () => number;
} => {
  let getIdx = 0;
  let refreshIdx = 0;
  const tokens = tokenSeq.length > 0 ? tokenSeq : ["tok"];
  return {
    async getAccessToken() {
      const t = tokens[Math.min(getIdx, tokens.length - 1)]!;
      getIdx += 1;
      return t;
    },
    async forceRefresh() {
      refreshIdx += 1;
      return tokens[Math.min(getIdx + refreshIdx, tokens.length - 1)]!;
    },
    async getScopes() {
      return ["tweet.read", "tweet.write"];
    },
    async getStored() {
      return {
        provider: "x",
        clientId: "c",
        tokens: {
          accessToken: tokens[0]!,
          tokenType: "bearer",
          expiresAt: Date.now() + 3600_000,
          scope: "tweet.read tweet.write",
        },
        createdAt: 0,
        updatedAt: 0,
      };
    },
    forceRefreshCount: () => refreshIdx,
    getAccessCount: () => getIdx,
  };
};

const okTweet = (id: string, text: string): Response =>
  new Response(JSON.stringify({ data: { id, text } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const errResp = (status: number, body: object, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("createXPublishAdapter.postTweet", () => {
  it("POSTs /2/tweets with Bearer and returns Tweet", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url, init) => {
      calls.push({ url: url.toString(), init });
      return okTweet("1234", "hello");
    });
    const ts = makeTokenSource(["tokA"]);
    const adapter = createXPublishAdapter({ tokenSource: ts, fetcher });
    const t = await adapter.postTweet({ text: "hello" });
    expect(t).toEqual({ id: "1234", text: "hello" });
    expect(calls[0]?.url).toContain("/2/tweets");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tokA");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ text: "hello" });
  });

  it("includes reply.in_reply_to_tweet_id when replyToTweetId set", async () => {
    const fetcher = vi.fn(async () => okTweet("2", "x"));
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    await adapter.postTweet({ text: "x", replyToTweetId: "1" });
    const body = JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.reply).toEqual({ in_reply_to_tweet_id: "1" });
  });

  it("auto-refreshes and retries on 401 (succeeds on second try)", async () => {
    const responses = [errResp(401, { detail: "expired" }), okTweet("9", "ok")];
    const fetcher = vi.fn(async () => responses.shift()!);
    const ts = makeTokenSource(["expired", "fresh"]);
    const adapter = createXPublishAdapter({ tokenSource: ts, fetcher });
    const t = await adapter.postTweet({ text: "x" });
    expect(t.id).toBe("9");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ts.forceRefreshCount()).toBe(1);
  });

  it("does NOT retry on second 401 (avoids infinite loop)", async () => {
    const fetcher = vi.fn(async () => errResp(401, { detail: "still bad" }));
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    await expect(adapter.postTweet({ text: "x" })).rejects.toMatchObject({
      kind: "AUTH",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("classifies 429 with retryAfterMs from x-rate-limit-reset", async () => {
    const future = Math.floor(Date.now() / 1000) + 30;
    const fetcher = vi.fn(async () =>
      errResp(429, { detail: "slow down" }, { "x-rate-limit-reset": String(future) }),
    );
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    try {
      await adapter.postTweet({ text: "x" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(isXPublishError(err)).toBe(true);
      const e = err as Error & { kind: string; context: { retryAfterMs?: number } };
      expect(e.kind).toBe("RATE_LIMITED");
      expect(e.context.retryAfterMs).toBeGreaterThan(20_000);
      expect(e.context.retryAfterMs).toBeLessThanOrEqual(30_000);
    }
  });

  it("classifies 187 duplicate", async () => {
    const fetcher = vi.fn(async () =>
      errResp(400, { errors: [{ code: 187, message: "Status is a duplicate." }] }),
    );
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    await expect(adapter.postTweet({ text: "x" })).rejects.toMatchObject({ kind: "DUPLICATE" });
  });

  it("classifies 500 as SERVER", async () => {
    const fetcher = vi.fn(async () => errResp(503, { detail: "Service Unavailable" }));
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    await expect(adapter.postTweet({ text: "x" })).rejects.toMatchObject({ kind: "SERVER" });
  });

  it("wraps fetch network errors as NETWORK", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    await expect(adapter.postTweet({ text: "x" })).rejects.toMatchObject({ kind: "NETWORK" });
  });
});

describe("createXPublishAdapter.postThread", () => {
  it("chains replyToTweetId across all tweets", async () => {
    const ids = ["a", "b", "c"];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const id = ids.shift()!;
      return okTweet(id, body.text);
    });
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    const result = await adapter.postThread({
      tweets: ["one", "two", "three"],
    });
    expect(result.tweets.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(result.threadUrl).toBe("https://x.com/i/status/a");
    const bodies = fetcher.mock.calls.map((c) =>
      JSON.parse((c[1] as RequestInit).body as string),
    );
    expect(bodies[0].reply).toBeUndefined();
    expect(bodies[1].reply).toEqual({ in_reply_to_tweet_id: "a" });
    expect(bodies[2].reply).toEqual({ in_reply_to_tweet_id: "b" });
  });

  it("attaches firstTweetMediaIds only to tweet[0]", async () => {
    let i = 0;
    const fetcher = vi.fn(async (_u, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      i += 1;
      return okTweet(String(i), body.text);
    });
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    await adapter.postThread({
      tweets: ["one", "two"],
      firstTweetMediaIds: ["m1"],
    });
    const bodies = fetcher.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies[0].media).toEqual({ media_ids: ["m1"] });
    expect(bodies[1].media).toBeUndefined();
  });

  it("attaches tweetMediaIds to their matching thread replies", async () => {
    let i = 0;
    const fetcher = vi.fn(async (_u, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      i += 1;
      return okTweet(String(i), body.text);
    });
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    await adapter.postThread({
      tweets: ["one", "two", "three"],
      firstTweetMediaIds: ["cover"],
      tweetMediaIds: { 1: ["reply-image"], 2: ["last-image"] },
    });
    const bodies = fetcher.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies[0].media).toEqual({ media_ids: ["cover"] });
    expect(bodies[1].media).toEqual({ media_ids: ["reply-image"] });
    expect(bodies[2].media).toEqual({ media_ids: ["last-image"] });
  });

  it("waits between thread replies when replyDelayMs is provided", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const ids = ["a", "b", "c"];
    try {
      const fetcher = vi.fn(async (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string);
        return okTweet(ids.shift()!, body.text);
      });
      const adapter = createXPublishAdapter({
        tokenSource: makeTokenSource(),
        fetcher,
      });

      const pending = adapter.postThread({
        tweets: ["one", "two", "three"],
        replyDelayMs: { min: 20_000, max: 20_000 },
      });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      await vi.runOnlyPendingTimersAsync();
      const result = await pending;
      expect(result.tweets.map((t) => t.id)).toEqual(["a", "b", "c"]);
      expect(fetcher).toHaveBeenCalledTimes(3);
      const threadDelayCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === 20_000);
      expect(threadDelayCalls).toHaveLength(2);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("throws when the very first tweet fails (no partial)", async () => {
    const fetcher = vi.fn(async () => errResp(400, { detail: "bad" }));
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    await expect(adapter.postThread({ tweets: ["x"] })).rejects.toMatchObject({
      kind: "BAD_REQUEST",
    });
  });

  it("continues posting when continueOnFailure is true", async () => {
    let n = 0;
    const fetcher = vi.fn(async (_u, init) => {
      n += 1;
      const body = JSON.parse((init as RequestInit).body as string);
      if (n === 2) return errResp(429, { detail: "slow" });
      return okTweet(String(n), body.text);
    });
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    const result = await adapter.postThread({
      tweets: ["a", "b", "c"],
      continueOnFailure: true,
    });
    expect(result.tweets.map((t) => t.id)).toEqual(["1", "3"]);
    expect(result.partialFailure?.atIndex).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const bodies = fetcher.mock.calls.map((c) =>
      JSON.parse((c[1] as RequestInit).body as string),
    );
    expect(bodies[2].reply).toEqual({ in_reply_to_tweet_id: "1" });
  });

  it("returns partialFailure when middle tweet fails (default stops)", async () => {
    let n = 0;
    const fetcher = vi.fn(async (_u, init) => {
      n += 1;
      const body = JSON.parse((init as RequestInit).body as string);
      if (n === 2) return errResp(429, { detail: "slow" });
      return okTweet(String(n), body.text);
    });
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    const result = await adapter.postThread({ tweets: ["a", "b", "c"] });
    expect(result.tweets).toHaveLength(1);
    expect(result.partialFailure?.atIndex).toBe(1);
    expect(result.threadUrl).toBe("https://x.com/i/status/1");
  });

  it("returns empty result for empty input", async () => {
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher: vi.fn(),
    });
    const result = await adapter.postThread({ tweets: [] });
    expect(result.tweets).toEqual([]);
    expect(result.threadUrl).toBeUndefined();
  });
});

describe("createXPublishAdapter.whoami", () => {
  it("returns id+username from /2/users/me", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: "u1", username: "alice", name: "Alice" } }), {
        status: 200,
      }),
    );
    const adapter = createXPublishAdapter({
      tokenSource: makeTokenSource(),
      fetcher,
    });
    const me = await adapter.whoami();
    expect(me).toEqual({ id: "u1", username: "alice", name: "Alice" });
    expect((fetcher.mock.calls[0]![0] as string).toString()).toContain("/2/users/me");
  });
});

describe("createXPublishAdapter.uploadTweetImage", () => {
  const mediaOk = (id: string): Response =>
    new Response(JSON.stringify({ data: { id }, meta: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("uploads a small PNG via one-shot without STATUS when no processing is reported", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yt2x-pub-img-"));
    const imgPath = path.join(dir, "cover.png");
    await writeFile(imgPath, Buffer.alloc(64, 2));
    try {
      const responses = [mediaOk("777000111222333444"), mediaOk("777000111222333444")];
      const fetcher = vi.fn(async () => responses.shift()!);
      const adapter = createXPublishAdapter({
        tokenSource: makeTokenSource(),
        fetcher,
      });
      const id = await adapter.uploadTweetImage({
        bytes: await readFile(imgPath),
        contentType: "image/png",
      });
      expect(id).toBe("777000111222333444");
      expect(fetcher.mock.calls[0]![0].toString()).toContain("/2/media/upload");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
