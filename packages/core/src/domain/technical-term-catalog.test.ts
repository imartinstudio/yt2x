import { describe, expect, it } from "vitest";
import {
  TECHNICAL_TERM_CATALOG,
  TECHNICAL_TERM_CATALOG_FINGERPRINT,
  createTechnicalTermGuard,
  defineTechnicalTermCatalog,
} from "./technical-term-catalog.js";

describe("technical term catalog", () => {
  it("protects source terms through an immutable guard", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "Graph Engineering connects a Knowledge Graph to an Agent Graph.",
    });
    const prepared = guard.prepare("Graph Engineering connects a Knowledge Graph to an Agent Graph.");

    expect(prepared.value).not.toContain("Graph Engineering");
    expect(prepared.promptRule).toContain("Graph Engineering");

    const finalized = guard.finalize(
      "图工程连接知识图谱和代理图谱。",
      prepared.restoration,
    );
    expect(finalized.value).toBe(
      "Graph Engineering 连接 Knowledge Graph 和 Agent Graph。",
    );
    expect(finalized.violations).toEqual([]);
  });

  it("does not confuse ordinary image words with contextual Graph", () => {
    const imageGuard = createTechnicalTermGuard({ sourceText: "Add a screenshot and a flow chart." });
    const imagePrepared = imageGuard.prepare("Add a screenshot and a flow chart.");

    expect(
      imageGuard.finalize("添加一张截图和流程图。", imagePrepared.restoration).value,
    ).toBe("添加一张截图和流程图。");
  });

  it("includes high-confidence discovered terms in the source profile", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "Agentic RAG",
      discoveredTerms: [{ sourceText: "Agentic RAG", confidence: "high", category: "ai-agent" }],
    });

    expect(guard.profile.entries.some((entry) => entry.canonical === "Agentic RAG")).toBe(true);
  });

  it("contains unique canonical terms and the initial AI catalog entries", () => {
    const canonicals = TECHNICAL_TERM_CATALOG.map((entry) => entry.canonical);
    expect(new Set(canonicals).size).toBe(canonicals.length);
    expect(canonicals).toEqual(expect.arrayContaining([
      "Artificial Intelligence",
      "AI Coding",
      "AI Agent",
      "Prompt Engineering",
      "Context Engineering",
      "Graph Engineering",
      "Knowledge Graph",
      "Agent Graph",
    ]));
  });

  it("rejects alias conflicts and missing fixed Chinese preferences", () => {
    expect(() => defineTechnicalTermCatalog([
      {
        canonical: "Duplicate Term",
        aliases: [],
        categories: ["domain"],
        policy: "preserve",
      },
      {
        canonical: "Duplicate Term",
        aliases: [],
        categories: ["domain"],
        policy: "contextual-preserve",
      },
    ])).toThrow(/duplicate canonical/i);

    expect(() => defineTechnicalTermCatalog([
      {
        canonical: "First Term",
        aliases: ["shared alias"],
        categories: ["domain"],
        policy: "preserve",
      },
      {
        canonical: "Second Term",
        aliases: ["SHARED ALIAS"],
        categories: ["domain"],
        policy: "preserve",
      },
    ])).toThrow(/alias conflict/i);

    expect(() => defineTechnicalTermCatalog([{
      canonical: "Fixed Term",
      aliases: [],
      categories: ["domain"],
      policy: "fixed-zh",
    }])).toThrow(/preferredZh/i);
  });

  it("keeps source and title occurrences independent when their offsets overlap", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "Graph starts here.",
      sourceTitle: "Knowledge Graph",
    });

    expect(guard.profile.occurrences).toEqual(expect.arrayContaining([
      { canonical: "Graph", sourceText: "Graph", start: 0, end: 5 },
      { canonical: "Knowledge Graph", sourceText: "Knowledge Graph", start: 0, end: 15 },
    ]));
  });

  it("uses the actual source spelling for discovered terms", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "Agentic   RAG changes the workflow.",
      discoveredTerms: [{ sourceText: "agentic rag", confidence: "high", category: "ai-agent" }],
    });

    expect(guard.profile.entries).toContainEqual(expect.objectContaining({ canonical: "Agentic   RAG" }));
    expect(guard.profile.entries).not.toContainEqual(expect.objectContaining({ canonical: "agentic rag" }));
  });

  it("validates nested values against one aggregate output", () => {
    const guard = createTechnicalTermGuard({ sourceText: "Graph Engineering" });

    expect(guard.validate({ title: "Graph Engineering", body: "普通摘要" })).toEqual([]);
  });

  it("does not join separate fields into a discovered canonical term", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "AI Agent\nKnowledge\nGraph",
      discoveredTerms: [{ sourceText: "Knowledge Graph", confidence: "high", category: "ai-agent" }],
    });
    const violations = guard.validate({ title: "AI Agent", first: "Knowledge", second: "Graph" });

    expect(violations).toContainEqual(expect.objectContaining({
      code: "missing-canonical-term",
      canonical: "Knowledge\nGraph",
    }));
  });

  it("keeps 图文 image wording Chinese while restoring contextual Graph", () => {
    const guard = createTechnicalTermGuard({ sourceText: "Graph is useful." });
    const prepared = guard.prepare("图文说明和图的基本词汇");

    expect(guard.finalize(prepared.value, prepared.restoration).value).toBe(
      "图文说明和 Graph 的基本词汇",
    );
  });

  it("keeps the catalog fingerprint independent of entry order", () => {
    const reversed = defineTechnicalTermCatalog([...TECHNICAL_TERM_CATALOG].reverse());

    expect(reversed.fingerprint).toBe(TECHNICAL_TERM_CATALOG_FINGERPRINT);
  });
});
