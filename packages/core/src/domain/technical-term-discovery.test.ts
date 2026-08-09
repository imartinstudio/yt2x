import { describe, expect, it } from "vitest";
import {
  buildTechnicalTermDiscoveryPrompt,
  parseTechnicalTermDiscoveryResponse,
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
});
