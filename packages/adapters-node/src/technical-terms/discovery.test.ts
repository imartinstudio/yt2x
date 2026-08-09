import { describe, expect, it, vi } from "vitest";
import type {
  ChatRequest,
  ChatResponse,
  LlmPort,
  TechnicalTermGuard,
} from "@yt2x/core";
import {
  discoverTechnicalTerms,
  repairTechnicalTermViolations,
} from "./discovery.js";

const response = (content: string): ChatResponse => ({
  content,
  model: "fake-model",
  finishReason: "stop",
});

const fakeLlm = (content: string): { llm: LlmPort; requests: ChatRequest[] } => {
  const requests: ChatRequest[] = [];
  const llm: LlmPort = {
    chat: vi.fn(async (request: ChatRequest) => {
      requests.push(request);
      return response(content);
    }),
  };
  return { llm, requests };
};

describe("source-level technical term discovery", () => {
  it("caches in-flight and completed discovery by source and model", async () => {
    const { llm, requests } = fakeLlm(JSON.stringify([
      { sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" },
    ]));
    const input = {
      llm,
      model: "fake-model",
      sourceText: "We built Latent Workspace Routing for agents.",
    };

    const [first, second] = await Promise.all([
      discoverTechnicalTerms(input),
      discoverTechnicalTerms(input),
    ]);

    expect(requests).toHaveLength(1);
    expect(second).toEqual(first);
    expect(requests[0]!.messages.map((message) => message.content).join("\n")).toMatch(
      /exact(?:ly)?[^\n]*source[^\n]*span/i,
    );
    expect(requests[0]).toMatchObject({ temperature: 0.1, jsonMode: true });
  });

  it("skips discovery when the source has no technical discovery signal", async () => {
    const { llm } = fakeLlm("[]");

    const result = await discoverTechnicalTerms({
      llm,
      model: "fake-model",
      sourceText: "这是一段中文内容，没有目录术语。",
    });

    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.accepted).toEqual([]);
    expect(result.reviewCandidates).toEqual([]);
  });

  it("converts provider failures into an unavailable warning", async () => {
    const llm: LlmPort = {
      chat: vi.fn(async () => { throw new Error("provider unavailable"); }),
    };

    const result = await discoverTechnicalTerms({
      llm,
      model: "fake-model",
      sourceText: "A source mentioning an unknown API protocol.",
    });

    expect(result.accepted).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "technical-term-discovery-unavailable" }),
    ]);
  });
});

describe("targeted technical term repair", () => {
  const guard = {
    profile: { entries: [] },
    finalize: vi.fn((value: unknown) => ({
      value,
      violations: typeof value === "string" && value.includes("Latent Workspace Routing")
        ? []
        : [{ code: "missing-canonical-term", canonical: "Latent Workspace Routing", message: "missing" }],
    })),
  } as unknown as TechnicalTermGuard;

  it("repairs a string once and finalizes the repaired value", async () => {
    const { llm } = fakeLlm("Latent Workspace Routing is retained.");

    const result = await repairTechnicalTermViolations({
      llm,
      model: "fake-model",
      guard,
      currentValue: "术语缺失。",
      restoration: { placeholders: [] },
      violations: [{ code: "missing-canonical-term", canonical: "Latent Workspace Routing", message: "missing" }],
      parseResponse: (content) => content,
    });

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(guard.finalize).toHaveBeenCalledWith("Latent Workspace Routing is retained.", { placeholders: [] });
    expect(result).toEqual({ value: "Latent Workspace Routing is retained.", violations: [] });
  });

  it("repairs a nested JSON value while preserving its outer shape", async () => {
    const { llm } = fakeLlm(JSON.stringify({ title: "Latent Workspace Routing", nested: { body: "保留" } }));
    const nestedGuard = {
      profile: { entries: [] },
      finalize: vi.fn((value: unknown) => ({ value, violations: [] })),
    } as unknown as TechnicalTermGuard;

    const result = await repairTechnicalTermViolations({
      llm,
      model: "fake-model",
      guard: nestedGuard,
      currentValue: { title: "术语缺失", nested: { body: "保留" } },
      restoration: { placeholders: [] },
      violations: [{ code: "missing-canonical-term", canonical: "Latent Workspace Routing", message: "missing" }],
      parseResponse: (content) => JSON.parse(content) as { title: string; nested: { body: string } },
    });

    expect(result.value).toEqual({ title: "Latent Workspace Routing", nested: { body: "保留" } });
    expect(nestedGuard.finalize).toHaveBeenCalledOnce();
  });

  it("returns remaining violations without a second repair", async () => {
    const { llm } = fakeLlm("仍然缺失");
    const result = await repairTechnicalTermViolations({
      llm,
      model: "fake-model",
      guard,
      currentValue: "术语缺失。",
      restoration: { placeholders: [] },
      violations: [{ code: "missing-canonical-term", canonical: "Latent Workspace Routing", message: "missing" }],
      parseResponse: (content) => content,
    });

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(result.violations).not.toEqual([]);
  });
});
