import { describe, expect, it, vi } from "vitest";
import { createAnthropicAdapter } from "./anthropic.js";

const makeFetcher = (handler: (url: string, init: RequestInit) => Response) =>
  vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(typeof url === "string" ? url : url.toString(), init ?? {}),
  );

const okResponse = (overrides: Record<string, unknown> = {}): Response =>
  new Response(
    JSON.stringify({
      id: "msg_test",
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("anthropic adapter", () => {
  it("POSTs to /messages with x-api-key + anthropic-version", async () => {
    const fetcher = makeFetcher((url, init) => {
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("ant-test");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers.authorization).toBeUndefined(); // 不应误用 Bearer
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.model).toBe("claude-sonnet-4-20250514");
      expect(body.max_tokens).toBeGreaterThan(0);
      return okResponse();
    });
    const adapter = createAnthropicAdapter({
      apiKey: "ant-test",
      baseUrl: "https://api.anthropic.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const resp = await adapter.chat({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(resp.content).toBe("ok");
    expect(resp.finishReason).toBe("stop");
    expect(resp.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
  });

  it("splits system messages into the system field (not messages[])", async () => {
    const fetcher = makeFetcher((_url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.system).toBe("You are concise.");
      const messages = body.messages as Array<{ role: string }>;
      expect(messages.every((m) => m.role !== "system")).toBe(true);
      return okResponse();
    });
    const adapter = createAnthropicAdapter({
      apiKey: "ant",
      baseUrl: "https://api.anthropic.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await adapter.chat({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "say ok" },
      ],
    });
  });

  it("concatenates multiple system messages with blank line", async () => {
    const fetcher = makeFetcher((_url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.system).toBe("A\n\nB");
      return okResponse();
    });
    const adapter = createAnthropicAdapter({
      apiKey: "ant",
      baseUrl: "https://api.anthropic.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await adapter.chat({
      model: "claude-sonnet-4",
      messages: [
        { role: "system", content: "A" },
        { role: "system", content: "B" },
        { role: "user", content: "go" },
      ],
    });
  });

  it("jsonMode appends '{' prefill and prepends it back to content", async () => {
    const fetcher = makeFetcher((_url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.system).toMatch(/JSON/i);
      const messages = body.messages as Array<{ role: string; content: string }>;
      const lastMessage = messages[messages.length - 1]!;
      expect(lastMessage.role).toBe("assistant");
      expect(lastMessage.content).toBe("{");
      // 模拟 Claude 接着 `{` 续写
      return okResponse({
        content: [{ type: "text", text: '"ok":true}' }],
      });
    });
    const adapter = createAnthropicAdapter({
      apiKey: "ant",
      baseUrl: "https://api.anthropic.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const resp = await adapter.chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "give json" }],
      jsonMode: true,
    });
    expect(resp.content).toBe('{"ok":true}');
  });

  it("aggregates multiple text blocks", async () => {
    const fetcher = makeFetcher(
      () =>
        okResponse({
          content: [
            { type: "text", text: "Hello, " },
            { type: "text", text: "world." },
          ],
        }),
    );
    const adapter = createAnthropicAdapter({
      apiKey: "ant",
      baseUrl: "https://api.anthropic.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const resp = await adapter.chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.content).toBe("Hello, world.");
  });

  it("max_tokens=length stop_reason maps to finishReason='length'", async () => {
    const fetcher = makeFetcher(() => okResponse({ stop_reason: "max_tokens" }));
    const adapter = createAnthropicAdapter({
      apiKey: "ant",
      baseUrl: "https://api.anthropic.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const resp = await adapter.chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "x" }],
    });
    expect(resp.finishReason).toBe("length");
  });

  it("maps 401 to LlmError(AUTH)", async () => {
    const fetcher = makeFetcher(
      () =>
        new Response(
          JSON.stringify({ error: { type: "authentication_error", message: "bad key" } }),
          { status: 401 },
        ),
    );
    const adapter = createAnthropicAdapter({
      apiKey: "bad",
      baseUrl: "https://api.anthropic.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(
      adapter.chat({ model: "claude-sonnet-4", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "AUTH" });
  });

  it("maps overloaded_error to SERVER (retriable)", async () => {
    const fetcher = makeFetcher(
      () =>
        new Response(JSON.stringify({ error: { type: "overloaded_error", message: "busy" } }), {
          status: 529,
        }),
    );
    const adapter = createAnthropicAdapter({
      apiKey: "ant",
      baseUrl: "https://api.anthropic.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(
      adapter.chat({ model: "claude-sonnet-4", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "SERVER", context: { retriable: true } });
  });

  it("rejects empty content blocks → BAD_RESPONSE", async () => {
    const fetcher = makeFetcher(() => okResponse({ content: [] }));
    const adapter = createAnthropicAdapter({
      apiKey: "ant",
      baseUrl: "https://api.anthropic.com/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(
      adapter.chat({ model: "claude-sonnet-4", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "BAD_RESPONSE" });
  });

  it("throws on empty apiKey at construction", () => {
    expect(() =>
      createAnthropicAdapter({ apiKey: "", baseUrl: "https://api.anthropic.com/v1" }),
    ).toThrow(/empty apiKey/);
  });
});
