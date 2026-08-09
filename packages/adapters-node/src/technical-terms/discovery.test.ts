import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatRequest,
  ChatResponse,
  LlmPort,
  TechnicalTermDiscoveryAudit,
  TechnicalTermGuard,
} from "@yt2x/core";
import { createTechnicalTermGuard, TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION } from "@yt2x/core";
import {
  discoverTechnicalTerms,
  clearTechnicalTermDiscoveryCaches,
  createFileTechnicalTermDiscoveryCacheStore,
  fingerprintTechnicalTermDiscoverySource,
  getCachedTechnicalTermDiscovery,
  repairTechnicalTermViolations,
  technicalTermDiscoveryAuditFor,
  technicalTermDiscoveryCacheFilePath,
  technicalTermDiscoveryCacheKeyFor,
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
  it("projects discovery results into a serializable profile audit", () => {
    const result = {
      accepted: [{ sourceText: "Graph Engineering", confidence: "high" as const, category: "ai-agent" as const }],
      reviewCandidates: [{ sourceText: "Latent Workspace Routing", confidence: "medium" as const, category: "ai-agent" as const }],
      warnings: [{ code: "provider-warning", message: "review the candidate" }],
    };

    const audit: TechnicalTermDiscoveryAudit = technicalTermDiscoveryAuditFor(result);

    expect(audit).toEqual({
      promptVersion: TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION,
      acceptedCandidates: result.accepted,
      reviewCandidates: result.reviewCandidates,
      warnings: result.warnings,
    });
    expect(JSON.parse(JSON.stringify(audit))).toEqual(audit);
  });

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
    expect(getCachedTechnicalTermDiscovery({
      model: input.model,
      sourceText: input.sourceText,
    })).toEqual(first);
    expect(llm.chat).toHaveBeenCalledTimes(1);
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

    expect(result.accepted).toEqual([
      { sourceText: "API", confidence: "high", category: "ai-coding" },
    ]);
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

  it("reads a persisted cache record after the in-memory cache is cleared", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-term-cache-"));
    try {
      const cache = createFileTechnicalTermDiscoveryCacheStore(cacheDir);
      const firstLlm = fakeLlm(JSON.stringify([
        { sourceText: "Cold Read Protocol", confidence: "high", category: "ai" },
      ])).llm;
      const input = {
        llm: firstLlm,
        model: "persistent-model",
        sourceText: "A source about Cold Read Protocol.",
        cache,
      };
      const first = await discoverTechnicalTerms(input);
      clearTechnicalTermDiscoveryCaches();

      const secondLlm: LlmPort = {
        chat: vi.fn(async () => { throw new Error("cold read must not call provider"); }),
      };
      const second = await discoverTechnicalTerms({ ...input, llm: secondLlm });

      expect(second).toEqual(first);
      expect(secondLlm.chat).not.toHaveBeenCalled();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
      clearTechnicalTermDiscoveryCaches();
    }
  });

  it("does not persist provider failures and invalidates incompatible records", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-term-cache-"));
    try {
      const cache = createFileTechnicalTermDiscoveryCacheStore(cacheDir);
      const sourceText = "A source about Cache Schema Protocol.";
      const cacheKey = technicalTermDiscoveryCacheKeyFor({ model: "schema-model", sourceText });
      const cachePath = technicalTermDiscoveryCacheFilePath(cacheDir, cacheKey);
      await writeFile(cachePath, JSON.stringify({ schemaVersion: 999 }), "utf8");

      let attempts = 0;
      const llm: LlmPort = {
        chat: vi.fn(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary provider failure");
          return response(JSON.stringify([
            { sourceText: "Cache Schema Protocol", confidence: "high", category: "ai" },
          ]));
        }),
      };
      const input = { llm, model: "schema-model", sourceText, cache };

      const first = await discoverTechnicalTerms(input);
      expect(first.warnings).toEqual([
        expect.objectContaining({ code: "technical-term-discovery-unavailable" }),
      ]);
      expect(await readFile(cachePath, "utf8")).toContain("schemaVersion");

      clearTechnicalTermDiscoveryCaches();
      const second = await discoverTechnicalTerms(input);
      expect(second.accepted).toEqual([
        { sourceText: "Cache Schema Protocol", confidence: "high", category: "ai" },
      ]);
      expect(llm.chat).toHaveBeenCalledTimes(2);
      expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ schemaVersion: 1 });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
      clearTechnicalTermDiscoveryCaches();
    }
  });
});

describe("targeted technical term repair", () => {
  const guard = {
    profile: { entries: [{ canonical: "Latent Workspace Routing" }] },
    finalize: vi.fn((value: unknown) => ({
      value,
      violations: typeof value === "string" && value.includes("Latent Workspace Routing")
        ? []
        : [{ code: "missing-canonical-term", canonical: "Latent Workspace Routing", message: "missing" }],
    })),
  } as unknown as TechnicalTermGuard;

  it("repairs a string once and finalizes the repaired value", async () => {
    const { llm } = fakeLlm("术语：Latent Workspace Routing");

    const result = await repairTechnicalTermViolations({
      llm,
      model: "fake-model",
      guard,
      currentValue: "术语：",
      restoration: { placeholders: [] },
      violations: [{ code: "missing-canonical-term", canonical: "Latent Workspace Routing", message: "missing" }],
      parseResponse: (content) => content,
    });

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(guard.finalize).toHaveBeenCalledWith("术语：Latent Workspace Routing", { placeholders: [] });
    expect(result).toEqual({ value: "术语：Latent Workspace Routing", violations: [] });
  });

  it("repairs a nested JSON value while preserving its outer shape", async () => {
    const { llm } = fakeLlm(JSON.stringify({ title: "术语：Latent Workspace Routing", nested: { body: "保留" } }));
    const nestedGuard = {
      profile: { entries: [{ canonical: "Latent Workspace Routing" }] },
      finalize: vi.fn((value: unknown) => ({ value, violations: [] })),
    } as unknown as TechnicalTermGuard;

    const result = await repairTechnicalTermViolations({
      llm,
      model: "fake-model",
      guard: nestedGuard,
      currentValue: { title: "术语：", nested: { body: "保留" } },
      restoration: { placeholders: [] },
      violations: [{ code: "missing-canonical-term", canonical: "Latent Workspace Routing", message: "missing" }],
      parseResponse: (content) => JSON.parse(content) as { title: string; nested: { body: string } },
    });

    expect(result.value).toEqual({ title: "术语：Latent Workspace Routing", nested: { body: "保留" } });
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

  it.each([
    {
      name: "plain text",
      currentValue: "正文：",
      repairedValue: "正文：Latent Workspace Routing",
      parseResponse: (content: string) => content,
    },
    {
      name: "object",
      currentValue: { title: "正文：", body: "保留" },
      repairedValue: { title: "正文：Latent Workspace Routing", body: "保留" },
      parseResponse: (content: string) => JSON.parse(content) as { title: string; body: string },
    },
    {
      name: "array",
      currentValue: ["正文：", "保留"],
      repairedValue: ["正文：Latent Workspace Routing", "保留"],
      parseResponse: (content: string) => JSON.parse(content) as string[],
    },
  ])("accepts a $name repair when only the missing term changes", async ({ currentValue, repairedValue, parseResponse }) => {
    const { llm } = fakeLlm(typeof repairedValue === "string" ? repairedValue : JSON.stringify(repairedValue));
    const termGuard = createTechnicalTermGuard({
      sourceText: "Latent Workspace Routing",
      discoveredTerms: [{ sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" }],
    });
    const violations = termGuard.validate(currentValue);

    const result = await repairTechnicalTermViolations({
      llm,
      model: "term-only-model",
      guard: termGuard,
      currentValue,
      restoration: { placeholders: [] },
      violations,
      parseResponse,
    });

    expect(result.violations).toEqual([]);
    expect(result.value).toEqual(repairedValue);
  });

  it("accepts replacing a translated term without treating adjacent text as rewritten", async () => {
    const { llm } = fakeLlm("Graph Engineering 很重要");
    const termGuard = createTechnicalTermGuard({ sourceText: "Graph Engineering" });
    const violations = [{
      code: "forbidden-translation" as const,
      canonical: "Graph Engineering",
      message: "replace translated term",
    }];

    const result = await repairTechnicalTermViolations({
      llm,
      model: "term-replacement-model",
      guard: termGuard,
      currentValue: "图工程很重要",
      restoration: { placeholders: [] },
      violations,
      parseResponse: (content) => content,
    });

    expect(result).toEqual({ value: "Graph Engineering 很重要", violations: [] });
  });

  it.each([
    {
      name: "plain text",
      currentValue: "原始正文",
      repairedValue: "被重写的正文 Latent Workspace Routing",
      parseResponse: (content: string) => content,
    },
    {
      name: "object",
      currentValue: { title: "正文：", body: "原始内容" },
      repairedValue: { title: "正文：Latent Workspace Routing", body: "被重写" },
      parseResponse: (content: string) => JSON.parse(content) as { title: string; body: string },
    },
    {
      name: "array",
      currentValue: ["正文：", "原始内容"],
      repairedValue: ["正文：Latent Workspace Routing", "被重写"],
      parseResponse: (content: string) => JSON.parse(content) as string[],
    },
  ])("rejects a $name repair when non-term text changes", async ({ currentValue, repairedValue, parseResponse }) => {
    const { llm } = fakeLlm(typeof repairedValue === "string" ? repairedValue : JSON.stringify(repairedValue));
    const termGuard = createTechnicalTermGuard({
      sourceText: "Latent Workspace Routing",
      discoveredTerms: [{ sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" }],
    });
    const violations = termGuard.validate(currentValue);

    const result = await repairTechnicalTermViolations({
      llm,
      model: "term-only-model",
      guard: termGuard,
      currentValue,
      restoration: { placeholders: [] },
      violations,
      parseResponse,
    });

    expect(result).toEqual({ value: currentValue, violations });
  });
});
