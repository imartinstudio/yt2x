import { describe, expect, it, vi } from "vitest";
import type {
  ChatRequest,
  ChatResponse,
  LlmPort,
  TechnicalTermGuard,
} from "@yt2x/core";
import {
  discoverTechnicalTerms,
  fingerprintTechnicalTermDiscoverySource,
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

  it("does not cache a provider failure and retries the same key", async () => {
    let attempts = 0;
    const llm: LlmPort = {
      chat: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary provider failure");
        return response(JSON.stringify([
          { sourceText: "Retryable Protocol", confidence: "high", category: "ai" },
        ]));
      }),
    };
    const input = {
      llm,
      model: "retry-model",
      sourceText: "A source about Retryable Protocol.",
    };

    const first = await discoverTechnicalTerms(input);
    const second = await discoverTechnicalTerms(input);

    expect(first.warnings).toEqual([
      expect.objectContaining({ code: "technical-term-discovery-unavailable" }),
    ]);
    expect(second.accepted).toEqual([
      { sourceText: "Retryable Protocol", confidence: "high", category: "ai" },
    ]);
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it("does not cache an aborted discovery and retries after cancellation", async () => {
    let attempts = 0;
    const llm: LlmPort = {
      chat: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("cancelled");
          error.name = "AbortError";
          throw error;
        }
        return response(JSON.stringify([
          { sourceText: "Abortable Protocol", confidence: "high", category: "ai" },
        ]));
      }),
    };
    const controller = new AbortController();
    controller.abort();
    const input = {
      llm,
      model: "abort-model",
      sourceText: "A source about Abortable Protocol.",
      signal: controller.signal,
    };

    await discoverTechnicalTerms(input);
    const retry = await discoverTechnicalTerms({ ...input, signal: undefined });

    expect(retry.accepted).toEqual([
      { sourceText: "Abortable Protocol", confidence: "high", category: "ai" },
    ]);
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it("reuses completed results for sequential calls", async () => {
    const { llm } = fakeLlm(JSON.stringify([
      { sourceText: "Sequential Protocol", confidence: "high", category: "ai" },
    ]));
    const input = {
      llm,
      model: "sequential-model",
      sourceText: "A source about Sequential Protocol.",
    };

    await discoverTechnicalTerms(input);
    await discoverTechnicalTerms(input);

    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it("uses a Node SHA-256 source fingerprint", () => {
    expect(fingerprintTechnicalTermDiscoverySource("hello")).toBe(
      "sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
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

  it.each([
    {
      name: "deleted object key",
      currentValue: { title: "缺失", nested: { body: "保留" }, metadata: { kind: "note" } },
      repairedValue: { title: "Latent Workspace Routing", nested: { body: "保留" } },
    },
    {
      name: "changed array length",
      currentValue: { title: "缺失", items: ["one", "two"] },
      repairedValue: { title: "Latent Workspace Routing", items: ["one"] },
    },
    {
      name: "changed nested non-string type",
      currentValue: { title: "缺失", nested: { count: 1, enabled: true } },
      repairedValue: { title: "Latent Workspace Routing", nested: { count: "1", enabled: true } },
    },
  ])("rejects structurally changed repair: $name", async ({ currentValue, repairedValue }) => {
    const { llm } = fakeLlm(JSON.stringify(repairedValue));
    const structuralGuard = {
      profile: { entries: [] },
      finalize: vi.fn((value: unknown) => ({ value, violations: [] })),
    } as unknown as TechnicalTermGuard;
    const violations = [{
      code: "missing-canonical-term" as const,
      canonical: "Latent Workspace Routing",
      message: "missing",
    }];

    const result = await repairTechnicalTermViolations({
      llm,
      model: "structural-model",
      guard: structuralGuard,
      currentValue,
      restoration: { placeholders: [] },
      violations,
      parseResponse: (content) => JSON.parse(content) as typeof currentValue,
    });

    expect(result).toEqual({ value: currentValue, violations });
    expect(structuralGuard.finalize).not.toHaveBeenCalled();
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
