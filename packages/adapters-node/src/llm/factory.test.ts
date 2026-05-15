import { describe, expect, it, vi } from "vitest";
import { createLlmAdapter } from "./factory.js";

describe("createLlmAdapter (provider routing)", () => {
  it("routes 'openai' to OpenAI-compatible adapter (Bearer auth)", async () => {
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
        { status: 200 },
      );
    });
    const adapter = createLlmAdapter({
      provider: "openai",
      apiKey: "sk",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-mini",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await adapter.chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }] });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("routes 'deepseek' to OpenAI-compatible adapter with deepseek base", async () => {
    const fetcher = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      expect(String(url)).toMatch(/api\.deepseek\.com/);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200 },
      );
    });
    const adapter = createLlmAdapter({
      provider: "deepseek",
      apiKey: "ds",
      baseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-chat",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await adapter.chat({ model: "deepseek-chat", messages: [{ role: "user", content: "x" }] });
  });

  it("routes 'moonshot' to OpenAI-compatible adapter with moonshot base", async () => {
    const fetcher = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      expect(String(url)).toMatch(/api\.moonshot\.cn/);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200 },
      );
    });
    const adapter = createLlmAdapter({
      provider: "moonshot",
      apiKey: "ms",
      baseUrl: "https://api.moonshot.cn/v1",
      defaultModel: "moonshot-v1-8k",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await adapter.chat({ model: "moonshot-v1-8k", messages: [{ role: "user", content: "x" }] });
  });

  it("routes 'anthropic' to Anthropic adapter (x-api-key header)", async () => {
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toMatch(/messages$/);
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("ant");
      expect(headers.authorization).toBeUndefined();
      return new Response(
        JSON.stringify({
          model: "claude-sonnet-4",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      );
    });
    const adapter = createLlmAdapter({
      provider: "anthropic",
      apiKey: "ant",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-sonnet-4",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await adapter.chat({ model: "claude-sonnet-4", messages: [{ role: "user", content: "x" }] });
  });

  it("rejects empty apiKey early", () => {
    expect(() =>
      createLlmAdapter({
        provider: "openai",
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toThrow(/empty apiKey/);
  });

  it("rejects empty baseUrl early", () => {
    expect(() =>
      createLlmAdapter({
        provider: "openai",
        apiKey: "sk",
        baseUrl: "",
      }),
    ).toThrow(/empty baseUrl/);
  });
});
