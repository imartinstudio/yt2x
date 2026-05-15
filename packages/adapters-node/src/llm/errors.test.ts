import { describe, expect, it } from "vitest";
import { classifyHttpError, classifyNetworkError, llmBadResponse } from "./errors.js";

const baseCtx = { provider: "openai", model: "gpt-4o-mini", message: "boom" };

describe("classifyHttpError", () => {
  it("401 → AUTH (not retriable)", () => {
    const err = classifyHttpError({ ...baseCtx, status: 401 });
    expect(err.kind).toBe("AUTH");
    expect(err.context.retriable).toBe(false);
    expect(err.context.httpStatus).toBe(401);
  });

  it("403 → AUTH", () => {
    expect(classifyHttpError({ ...baseCtx, status: 403 }).kind).toBe("AUTH");
  });

  it("429 → RATE_LIMIT (retriable)", () => {
    const err = classifyHttpError({ ...baseCtx, status: 429 });
    expect(err.kind).toBe("RATE_LIMIT");
    expect(err.context.retriable).toBe(true);
  });

  it("500/502/503 → SERVER (retriable)", () => {
    for (const status of [500, 502, 503]) {
      const err = classifyHttpError({ ...baseCtx, status });
      expect(err.kind).toBe("SERVER");
      expect(err.context.retriable).toBe(true);
    }
  });

  it("413 → CONTEXT_LIMIT", () => {
    expect(classifyHttpError({ ...baseCtx, status: 413 }).kind).toBe("CONTEXT_LIMIT");
  });

  it("400 → BAD_REQUEST", () => {
    expect(classifyHttpError({ ...baseCtx, status: 400 }).kind).toBe("BAD_REQUEST");
  });

  it("provider code 'insufficient_quota' overrides status", () => {
    const err = classifyHttpError({
      ...baseCtx,
      status: 400,
      providerCode: "insufficient_quota",
    });
    expect(err.kind).toBe("QUOTA");
    expect(err.context.retriable).toBe(false);
  });

  it("provider code 'context_length_exceeded' → CONTEXT_LIMIT", () => {
    const err = classifyHttpError({
      ...baseCtx,
      status: 400,
      providerCode: "context_length_exceeded",
    });
    expect(err.kind).toBe("CONTEXT_LIMIT");
  });

  it("Anthropic 'overloaded_error' → SERVER (retriable)", () => {
    const err = classifyHttpError({
      ...baseCtx,
      provider: "anthropic",
      status: 529,
      providerCode: "overloaded_error",
    });
    expect(err.kind).toBe("SERVER");
    expect(err.context.retriable).toBe(true);
  });
});

describe("classifyNetworkError", () => {
  it("wraps native Error in LlmError(NETWORK, retriable)", () => {
    const err = classifyNetworkError({
      provider: "openai",
      model: "x",
      cause: new Error("ECONNRESET"),
    });
    expect(err.kind).toBe("NETWORK");
    expect(err.context.retriable).toBe(true);
    expect(err.message).toMatch(/ECONNRESET/);
  });
});

describe("llmBadResponse", () => {
  it("returns BAD_RESPONSE (not retriable)", () => {
    const err = llmBadResponse({ provider: "x", model: "m", reason: "missing field" });
    expect(err.kind).toBe("BAD_RESPONSE");
    expect(err.context.retriable).toBe(false);
  });
});
