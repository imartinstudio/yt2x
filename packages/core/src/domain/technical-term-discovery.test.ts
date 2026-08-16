import { describe, expect, it } from "vitest";
import {
  buildTechnicalTermDiscoveryPrompt,
  createTechnicalTermDiscoveryCacheRecord,
  parseTechnicalTermDiscoveryCacheRecord,
  parseTechnicalTermDiscoveryResponse,
  recognizeDeterministicTechnicalTerms,
} from "./technical-term-discovery.js";

describe("technical term discovery parser", () => {
  it("accepts only source-locatable candidates and routes confidence", () => {
    expect(parseTechnicalTermDiscoveryResponse({
      sourceText: "We built Latent Workspace Routing for agents.",
      response: JSON.stringify([
        { sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" },
        { sourceText: "Invented Protocol", confidence: "high", category: "ai" },
        { sourceText: "agents", confidence: "medium", category: "ai-agent" },
      ]),
    })).toEqual({
      accepted: [{ sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" }],
      warnings: expect.arrayContaining([expect.objectContaining({ code: "candidate-not-in-source" })]),
      reviewCandidates: [{ sourceText: "agents", confidence: "medium", category: "ai-agent" }],
    });
  });

  it("preserves the exact source spelling and drops low-confidence candidates", () => {
    const result = parseTechnicalTermDiscoveryResponse({
      sourceText: "We use LATENT Workspace Routing and Agentic Workflow.",
      response: JSON.stringify([
        { sourceText: "latent workspace routing", confidence: "high", category: "ai-agent" },
        { sourceText: "Agentic Workflow", confidence: "low", category: "ai-agent" },
        { sourceText: "broken", confidence: "medium", category: "unknown" },
      ]),
    });

    expect(result.accepted).toEqual([
      { sourceText: "LATENT Workspace Routing", confidence: "high", category: "ai-agent" },
    ]);
    expect(result.reviewCandidates).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "low-confidence-candidate" }),
      expect.objectContaining({ code: "invalid-candidate" }),
    ]));
  });

  it("accepts the array wrapped in an object, as JSON mode returns it", () => {
    // The request sets jsonMode, which for OpenAI-compatible providers becomes
    // response_format: json_object. Under that mode the provider is entitled to
    // wrap the array — and DeepSeek does exactly that once the payload is large
    // (a short probe returns a bare array; a real ~10k-char transcript comes
    // back as {"terms": [...]}). Rejecting the wrapper silently disabled term
    // discovery for full-length videos, which let the translator mangle
    // product names it should have preserved verbatim.
    const candidates = [
      { sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" },
    ];
    for (const key of ["terms", "candidates", "result", "data"]) {
      expect(
        parseTechnicalTermDiscoveryResponse({
          sourceText: "We built Latent Workspace Routing for agents.",
          response: JSON.stringify({ [key]: candidates }),
        }).accepted,
      ).toEqual(candidates);
    }
  });

  it("still rejects an object that carries no candidate array", () => {
    expect(
      parseTechnicalTermDiscoveryResponse({
        sourceText: "The source mentions an API.",
        response: JSON.stringify({ error: "no terms found" }),
      }),
    ).toEqual({
      accepted: [],
      reviewCandidates: [],
      warnings: [expect.objectContaining({ code: "malformed-response" })],
    });
  });

  it("refuses to guess when an object holds more than one array", () => {
    // Two arrays means the wrapper shape is ambiguous; picking one would be a
    // coin flip on which is the candidate list.
    expect(
      parseTechnicalTermDiscoveryResponse({
        sourceText: "The source mentions an API.",
        response: JSON.stringify({ a: [], b: [] }),
      }).warnings,
    ).toEqual([expect.objectContaining({ code: "malformed-response" })]);
  });

  it("reports malformed JSON as a machine-readable warning", () => {
    expect(parseTechnicalTermDiscoveryResponse({
      sourceText: "The source mentions an API.",
      response: "not-json",
    })).toEqual({
      accepted: [],
      reviewCandidates: [],
      warnings: [expect.objectContaining({ code: "malformed-response" })],
    });
  });

  it("requires exact source spans in the versioned prompt", () => {
    expect(buildTechnicalTermDiscoveryPrompt("A source about Graph Engineering.")).toMatch(
      /exact(?:ly)?[^\n]*source[^\n]*span/i,
    );
  });

  it("recognizes high-confidence structural terms without promoting ordinary English", () => {
    const result = recognizeDeterministicTechnicalTerms(
      "Run `pnpm yt2x`, pass --download-video, call getUserProfile(), and send the API request to GPT-5.\nThis is a normal sentence with no unusual identifiers.",
    );

    expect(result.accepted).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceText: "pnpm yt2x", confidence: "high" }),
      expect.objectContaining({ sourceText: "--download-video", confidence: "high" }),
      expect.objectContaining({ sourceText: "getUserProfile()", confidence: "high" }),
      expect.objectContaining({ sourceText: "API", confidence: "high" }),
      expect.objectContaining({ sourceText: "GPT-5", confidence: "high" }),
    ]));
    expect(result.accepted).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceText: "This" }),
      expect.objectContaining({ sourceText: "normal" }),
      expect.objectContaining({ sourceText: "sentence" }),
    ]));
  });

  it("round-trips a versioned discovery cache record and rejects incompatible schemas", () => {
    const record = createTechnicalTermDiscoveryCacheRecord({
      cacheKey: "cache-key",
      sourceIdentity: "sha256-source",
      model: "model",
      catalogFingerprint: "sha256-catalog",
      result: {
        accepted: [{ sourceText: "API", confidence: "high", category: "ai-coding" }],
        reviewCandidates: [],
        warnings: [],
      },
    });

    expect(parseTechnicalTermDiscoveryCacheRecord(JSON.parse(JSON.stringify(record))))
      .toEqual(record);
    expect(parseTechnicalTermDiscoveryCacheRecord({ ...record, schemaVersion: 999 }))
      .toBeUndefined();
    expect(parseTechnicalTermDiscoveryCacheRecord({ ...record, result: { accepted: [] } }))
      .toBeUndefined();
  });
});
