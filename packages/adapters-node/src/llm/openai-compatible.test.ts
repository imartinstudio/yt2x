import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";

type FetchSpy = ReturnType<typeof vi.fn>;

const makeFetcher = (handler: (url: string, init: RequestInit) => Response): FetchSpy =>
  vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(typeof url === "string" ? url : url.toString(), init ?? {}),
  );

const okResponse = (overrides: Record<string, unknown> = {}): Response =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello, world." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("openai-compatible adapter", () => {
  it("POSTs to /chat/completions and parses content", async () => {
    const fetcher = makeFetcher((url, init) => {
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.temperature).toBe(0);
      expect(Array.isArray(body.messages)).toBe(true);
      return okResponse();
    });
    const adapter = createOpenAICompatibleAdapter({
      provider: "openai",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const resp = await adapter.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
    });
    expect(resp.content).toBe("Hello, world.");
    expect(resp.finishReason).toBe("stop");
    expect(resp.usage).toEqual({ promptTokens: 12, completionTokens: 5, totalTokens: 17 });
  });

  it("uses defaultModel when ChatRequest.model is empty", async () => {
    const fetcher = makeFetcher((_url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.model).toBe("deepseek-chat");
      return okResponse({ model: "deepseek-chat" });
    });
    const adapter = createOpenAICompatibleAdapter({
      provider: "deepseek",
      apiKey: "ds-test",
      baseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-chat",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await adapter.chat({ model: "", messages: [{ role: "user", content: "hi" }] });
  });

  it("trailing slash in baseUrl is normalised", async () => {
    const fetcher = makeFetcher((url, _init) => {
      expect(url).toBe("https://api.moonshot.cn/v1/chat/completions");
      return okResponse();
    });
    const adapter = createOpenAICompatibleAdapter({
      provider: "moonshot",
      apiKey: "ms",
      baseUrl: "https://api.moonshot.cn/v1/",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await adapter.chat({ model: "moonshot-v1-8k", messages: [{ role: "user", content: "x" }] });
  });

  it("maps 401 to LlmError(AUTH)", async () => {
    const fetcher = makeFetcher(
      () =>
        new Response(JSON.stringify({ error: { message: "Bad key", code: "invalid_api_key" } }), {
          status: 401,
        }),
    );
    const adapter = createOpenAICompatibleAdapter({
      provider: "openai",
      apiKey: "bad",
      baseUrl: "https://api.openai.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(
      adapter.chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ name: "LlmError", kind: "AUTH" });
  });

  it("maps 429 to LlmError(RATE_LIMIT, retriable)", async () => {
    const fetcher = makeFetcher(
      () =>
        new Response(JSON.stringify({ error: { message: "too many", code: "rate_limit_exceeded" } }), {
          status: 429,
        }),
    );
    const adapter = createOpenAICompatibleAdapter({
      provider: "openai",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const promise = adapter.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "x" }],
    });
    await expect(promise).rejects.toMatchObject({
      kind: "RATE_LIMIT",
      context: { retriable: true },
    });
  });

  it("maps insufficient_quota provider code to QUOTA", async () => {
    const fetcher = makeFetcher(
      () =>
        new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "x" } }), {
          status: 429,
        }),
    );
    const adapter = createOpenAICompatibleAdapter({
      provider: "openai",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(
      adapter.chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "QUOTA", context: { retriable: false } });
  });

  it("rejects response with no choices → BAD_RESPONSE", async () => {
    const fetcher = makeFetcher(() => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const adapter = createOpenAICompatibleAdapter({
      provider: "openai",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(
      adapter.chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "BAD_RESPONSE" });
  });

  it("jsonMode adds response_format and ensures 'json' word is present", async () => {
    const fetcher = makeFetcher((_url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.response_format).toEqual({ type: "json_object" });
      // 最后一条消息应该被自动加了 "Respond in valid JSON."
      const messages = body.messages as Array<{ content: string }>;
      const last = messages[messages.length - 1]!;
      expect(last.content).toMatch(/json/i);
      return okResponse({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"ok":true}' },
            finish_reason: "stop",
          },
        ],
      });
    });
    const adapter = createOpenAICompatibleAdapter({
      provider: "openai",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const resp = await adapter.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "tell me anything" }],
      jsonMode: true,
    });
    expect(resp.content).toBe('{"ok":true}');
  });

  it("never sends apiKey in URL", async () => {
    const fetcher = makeFetcher((url, _init) => {
      expect(url).not.toMatch(/sk-test/);
      return okResponse();
    });
    const adapter = createOpenAICompatibleAdapter({
      provider: "openai",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await adapter.chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }] });
  });

  it("throws on empty apiKey at construction (fail fast)", () => {
    expect(() =>
      createOpenAICompatibleAdapter({
        provider: "openai",
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toThrow(/empty apiKey/);
  });

  it("propagates AbortSignal to fetch (cancellation)", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      // signal 由内部 controller 包装，但应可在 abort 后触发 abort
      controller.abort();
      // 模拟 fetch 立即被取消
      throw new Error("aborted");
    });
    const adapter = createOpenAICompatibleAdapter({
      provider: "openai",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(
      adapter.chat({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "x" }],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "NETWORK" });
  });
});
