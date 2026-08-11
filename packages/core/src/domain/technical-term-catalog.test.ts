import { describe, expect, it } from "vitest";
import {
  TECHNICAL_TERM_CATALOG,
  TECHNICAL_TERM_CATALOG_FINGERPRINT,
  buildTechnicalTermPromptRule,
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

  it("does not activate a bare Graph without technical context", () => {
    const guard = createTechnicalTermGuard({ sourceText: "Graph" });

    expect(guard.profile.entries.map((term) => term.canonical)).not.toContain("Graph");
    expect(guard.finalize("图", { placeholders: [] }).violations).toEqual([]);
  });

  it("recognizes mixed Chinese technical context without activating a visual Graph", () => {
    const technical = createTechnicalTermGuard({ sourceText: "Graph 能让 agent 看见依赖关系。" });
    const visual = createTechnicalTermGuard({ sourceText: "Graph 是一张图片。" });

    expect(technical.profile.entries.map((term) => term.canonical)).toContain("Graph");
    expect(visual.profile.entries.map((term) => term.canonical)).not.toContain("Graph");
  });

  it("allows natural graph vocabulary without activating or inventing contextual Graph", () => {
    const sourceText = "Graph Engineering helps teams explain the Knowledge Graph workflow.";
    const strictGuard = createTechnicalTermGuard({ sourceText });
    const strictPrepared = strictGuard.prepare("A graph diagram image explains the workflow.");
    expect(strictGuard.finalize(strictPrepared.value, strictPrepared.restoration).violations)
      .not.toContainEqual(expect.objectContaining({ code: "invented-canonical-term", canonical: "Graph" }));

    const visualGuard = createTechnicalTermGuard({ sourceText, artifact: "visual-prompt" });
    const visualPrepared = visualGuard.prepare("Graph Engineering uses a graph diagram image to explain the Knowledge Graph workflow.");
    expect(visualGuard.finalize(visualPrepared.value, visualPrepared.restoration).violations).toEqual([]);

    const protectedVisual = visualGuard.prepare("Graph Engineering connects a Knowledge Graph.");
    const finalized = visualGuard.finalize("图工程连接知识图谱。", protectedVisual.restoration);
    expect(finalized.value).toContain("Graph Engineering");
    expect(finalized.value).toContain("Knowledge Graph");
  });

  it("keeps future non-Graph contextual terms strict in visual prompts", () => {
    const testCatalog = defineTechnicalTermCatalog([
      { canonical: "Graph", aliases: ["graph"], categories: ["ai-agent"], policy: "contextual-preserve", forbiddenZh: ["图"] },
      { canonical: "Future Context", aliases: ["future context"], categories: ["domain"], policy: "contextual-preserve", forbiddenZh: ["未来上下文"] },
    ]);
    const createGuardWithCatalog = createTechnicalTermGuard as unknown as (input: {
      sourceText: string;
      artifact: "visual-prompt";
      catalog: typeof testCatalog;
    }) => ReturnType<typeof createTechnicalTermGuard>;
    const guard = createGuardWithCatalog({ sourceText: "Graph", artifact: "visual-prompt", catalog: testCatalog });

    expect(guard.finalize("A graph diagram", { placeholders: [] }).violations).toEqual([]);
    expect(guard.finalize("Future Context diagram", { placeholders: [] }).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invented-canonical-term", canonical: "Future Context" })]),
    );
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
      { canonical: "Graph", sourceText: "Graph", start: 0, end: 5, source: "sourceText" },
      { canonical: "Knowledge Graph", sourceText: "Knowledge Graph", start: 0, end: 15, source: "sourceTitle" },
    ]));
  });

  it("activates a discovered term found only in the source title and keeps its range", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "The workflow is practical.",
      sourceTitle: "Why Latent Workspace Routing matters",
      discoveredTerms: [{
        sourceText: "Latent Workspace Routing",
        confidence: "high",
        category: "ai-agent",
      }],
    });

    expect(guard.profile.entries).toContainEqual(expect.objectContaining({
      canonical: "Latent Workspace Routing",
      sourceText: "Latent Workspace Routing",
    }));
    expect(guard.profile.occurrences).toContainEqual({
      canonical: "Latent Workspace Routing",
      sourceText: "Latent Workspace Routing",
      start: 4,
      end: 28,
      source: "sourceTitle",
    });
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

  it("uses full-source knowledge while requiring only the selected summary scope", () => {
    const fullGuard = createTechnicalTermGuard({
      sourceText: [
        "## Executive Summary",
        "Graph Engineering is the main idea.",
        "## Detailed Notes",
        "Context Engineering is discussed later.",
      ].join("\n"),
    });
    const summaryGuard = fullGuard.scope(
      "## Executive Summary\nGraph Engineering is the main idea.",
    );

    expect(summaryGuard.validate("Graph Engineering 摘要")).toEqual([]);
    expect(summaryGuard.validate("Graph Engineering 与上下文工程")).toContainEqual(
      expect.objectContaining({
        code: "forbidden-translation",
        canonical: "Context Engineering",
      }),
    );
    expect(summaryGuard.validate("Graph Engineering 与 Context Engineering")).toEqual([]);
  });

  it("treats a term inside a URL as a citation, not as invented usage", () => {
    const guard = createTechnicalTermGuard({ sourceText: "Graph Engineering explained." });

    expect(guard.validate(
      "Graph Engineering 讲解\nSource: https://www.youtube.com/watch?v=b8SV4U6fEIc",
    )).toEqual([]);
    expect(guard.validate(
      "Graph Engineering 讲解，见[原视频](https://www.youtube.com/watch?v=b8SV4U6fEIc)。",
    )).toEqual([]);
  });

  it("does not require a term that only appears inside a source URL", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "Graph Engineering 讲解见 https://www.youtube.com/watch?v=b8SV4U6fEIc 。",
    });

    expect(guard.profile.entries.map((term) => term.canonical)).not.toContain("YouTube");
    expect(guard.validate("Graph Engineering 的要点。")).toEqual([]);
  });

  it("allows a shorter catalog term covered by a longer active term", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "Claude Code 会在 auto mode 下继续工作。",
      discoveredTerms: [{ sourceText: "Claude Code", confidence: "high", category: "product" }],
    });
    const active = guard.profile.entries.map((term) => term.canonical);

    expect(active).toContain("Claude Code");
    expect(active).not.toContain("Claude");
    expect(guard.validate("Claude Code 很好用，Claude 这个品牌也一样。")).toEqual([]);
  });

  it("recovers transliterated product names back to the brand spelling", () => {
    const guard = createTechnicalTermGuard({ sourceText: "Claude 和 YouTube 都在源材料里出现。" });

    const finalized = guard.finalize("克劳德的视频发在油管上。", { placeholders: [] });

    expect(finalized.value).toBe("Claude 的视频发在 YouTube 上。");
    expect(finalized.violations).toEqual([]);
  });

  it("leaves ordinary Chinese words alone even when the same-named product is active", () => {
    // Cursor→光标、Agents→代理 这类词在中文里另有日常含义，故意不设为禁译词：
    // 一旦设了，正文里合法的"光标/代理"会被静默改写成产品名。
    const guard = createTechnicalTermGuard({ sourceText: "Cursor 和 Agents 都在源材料里出现。" });

    const finalized = guard.finalize("把光标移到行尾，再让代理接手。", { placeholders: [] });

    expect(finalized.value).toBe("把光标移到行尾，再让代理接手。");
    expect(finalized.violations).toEqual([]);
  });

  it("requires full term coverage only from a 1:1 unit scope", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "Graph Engineering 依赖 approval fatigue 这种日常说法。",
      discoveredTerms: [{ sourceText: "approval fatigue", confidence: "high", category: "domain" }],
    });

    // 术语用到了就必须保持原文——prepare 用占位符挡住翻译
    const prepared = guard.prepare("approval fatigue 是核心问题。");
    expect(prepared.value).not.toContain("approval fatigue");
    // 重写类产物漏讲术语是编辑取舍，不是术语错误
    expect(guard.validate("这期讲的是审批负担。")).toEqual([]);
    // 但用了被禁的中文译法仍然要报
    expect(guard.validate("这期讲的是图工程。")).toContainEqual(
      expect.objectContaining({ code: "forbidden-translation", canonical: "Graph Engineering" }),
    );
    // 逐句翻译是 1:1 映射：源单元里的术语必须落进译文
    expect(guard.scopeUnit({ sourceText: "approval fatigue 很常见。", unitId: "cue:1" })
      .validate("审批负担很常见。")).toContainEqual(
      expect.objectContaining({ code: "missing-canonical-term", canonical: "approval fatigue" }),
    );
  });

  it("still rejects an invented term used outside a URL", () => {
    const guard = createTechnicalTermGuard({ sourceText: "Graph Engineering explained." });

    expect(guard.validate("Graph Engineering 这期 YouTube 视频很好。")).toContainEqual(
      expect.objectContaining({ code: "invented-canonical-term", canonical: "YouTube" }),
    );
  });

  it("does not join separate fields into a discovered canonical term", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "AI Agent\nKnowledge\nGraph",
      // unit 作用域下发现词必须落地，缺失才会暴露"跨字段拼接"这个问题
      sourceUnitId: "unit-1",
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

  it("does not globally replace a natural 图 when only Graph Engineering is source-active", () => {
    const guard = createTechnicalTermGuard({ sourceText: "Graph Engineering is useful." });
    const finalized = guard.finalize(
      "图工程很有用。\n什么时候值得用图",
      { placeholders: [] },
    );

    expect(finalized.value).toBe("Graph Engineering 很有用。\n什么时候值得用图");
    expect(finalized.violations).toEqual([]);
  });

  it("keeps the catalog fingerprint independent of entry order", () => {
    const reversed = defineTechnicalTermCatalog([...TECHNICAL_TERM_CATALOG].reverse());

    expect(reversed.fingerprint).toBe(TECHNICAL_TERM_CATALOG_FINGERPRINT);
  });

  it("changes profile and catalog fingerprints when source, artifact, or catalog changes", () => {
    const source = "Graph Engineering";
    const content = createTechnicalTermGuard({ sourceText: source }).profile.profileFingerprint;
    const visual = createTechnicalTermGuard({ sourceText: source, artifact: "visual-prompt" }).profile.profileFingerprint;
    const changedSource = createTechnicalTermGuard({ sourceText: source + " workflow" }).profile.profileFingerprint;
    const baseCatalog = defineTechnicalTermCatalog([{
      canonical: "Base Term",
      aliases: [],
      categories: ["domain"],
      policy: "preserve",
    }]);
    const extendedCatalog = defineTechnicalTermCatalog([
      {
        canonical: "Base Term",
        aliases: [],
        categories: ["domain"],
        policy: "preserve",
      },
      {
        canonical: "Future Term",
        aliases: [],
        categories: ["domain"],
        policy: "preserve",
      },
    ]);

    const activeBase = createTechnicalTermGuard({
      sourceText: "Base Term is active.",
      catalog: baseCatalog,
    }).profile.profileFingerprint;
    const activeWithUnrelatedEntry = createTechnicalTermGuard({
      sourceText: "Base Term is active.",
      catalog: extendedCatalog,
    }).profile.profileFingerprint;

    expect(visual).not.toBe(content);
    expect(changedSource).not.toBe(content);
    expect(extendedCatalog.fingerprint).not.toBe(baseCatalog.fingerprint);
    expect(activeWithUnrelatedEntry).toBe(activeBase);
  });

  it("exposes an explicit unit scope and counts repeated occurrences inside that unit", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "Graph Engineering appears twice: Graph Engineering.",
    });
    const unit = guard.scopeUnit({
      sourceText: "Graph Engineering appears twice: Graph Engineering.",
      unitId: "cue-1",
    });

    expect(unit.profile.occurrences.filter((occurrence) => occurrence.canonical === "Graph Engineering"))
      .toHaveLength(2);
    expect(unit.validate("Graph Engineering appears once.")).toEqual([
      expect.objectContaining({
        code: "missing-canonical-term",
        canonical: "Graph Engineering",
      }),
    ]);
  });

  it("scopes contextual Graph recovery to the source translation unit", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "Graph is a technical concept.\nThis graph diagram shows latency.",
    });
    const technicalUnit = guard.scope({ sourceText: "Graph is a technical concept.", unitId: "cue-1" });
    const visualUnit = guard.scope({ sourceText: "This graph diagram shows latency.", unitId: "cue-2" });

    expect(technicalUnit.profile.entries.map((term) => term.canonical)).toContain("Graph");
    expect(visualUnit.profile.entries.map((term) => term.canonical)).not.toContain("Graph");
    expect(technicalUnit.finalize("图是一个技术概念。", { placeholders: [] }).value)
      .toBe("Graph 是一个技术概念。");
    expect(visualUnit.finalize("这张图表显示延迟。", { placeholders: [] }).value)
      .toBe("这张图表显示延迟。");
  });

  it("requires every source occurrence while allowing independent unit validation", () => {
    const guard = createTechnicalTermGuard({
      sourceText: "Graph Engineering appears here.\nGraph Engineering appears again.",
    });

    expect(guard.profile.occurrences.filter((occurrence) => occurrence.canonical === "Graph Engineering"))
      .toHaveLength(2);
    const firstUnit = guard.scope({
      sourceText: "Graph Engineering appears here.",
      unitId: "unit-1",
    });
    const secondUnit = guard.scope({
      sourceText: "Graph Engineering appears again.",
      unitId: "unit-2",
    });

    expect(firstUnit.validate("Graph Engineering")).toEqual([]);
    expect(secondUnit.validate("普通文本")).toContainEqual(expect.objectContaining({
      code: "missing-canonical-term",
      canonical: "Graph Engineering",
      message: expect.stringMatching(/1/),
    }));
  });

  it("stores discovery audit metadata and changes SHA-256 profile fingerprints", () => {
    const accepted = [{ sourceText: "Latent Workspace Routing", confidence: "high" as const, category: "ai-agent" as const }];
    const base = createTechnicalTermGuard({
      sourceText: "Latent Workspace Routing",
      discovery: {
        promptVersion: "discovery-v1",
        acceptedCandidates: accepted,
        reviewCandidates: [],
        warnings: [],
      },
    }).profile;
    const changedVersion = createTechnicalTermGuard({
      sourceText: "Latent Workspace Routing",
      discovery: {
        promptVersion: "discovery-v2",
        acceptedCandidates: accepted,
        reviewCandidates: [],
        warnings: [],
      },
    }).profile;
    const changedCandidate = createTechnicalTermGuard({
      sourceText: "Latent Workspace Routing",
      discovery: {
        promptVersion: "discovery-v1",
        acceptedCandidates: [{ ...accepted[0]!, confidence: "medium" }],
        reviewCandidates: [],
        warnings: [],
      },
    }).profile;

    expect(base.profileFingerprint).toMatch(/^sha256-[0-9a-f]{64}$/u);
    expect(base.discovery).toEqual(expect.objectContaining({
      promptVersion: "discovery-v1",
      acceptedCandidates: accepted,
      reviewCandidates: [],
      warnings: [],
    }));
    expect(JSON.parse(JSON.stringify(base))).toEqual(base);
    expect(changedVersion.profileFingerprint).not.toBe(base.profileFingerprint);
    expect(changedCandidate.profileFingerprint).not.toBe(base.profileFingerprint);
    expect(TECHNICAL_TERM_CATALOG_FINGERPRINT).toMatch(/^sha256-[0-9a-f]{64}$/u);
  });

  it("only injects active terms into the technical-term prompt rule", () => {
    const inactiveRule = buildTechnicalTermPromptRule("zh");
    const activeGuard = createTechnicalTermGuard({ sourceText: "Graph Engineering" });
    const activeRule = buildTechnicalTermPromptRule("zh", activeGuard.profile.entries);

    expect(inactiveRule).not.toContain("Graph Engineering");
    expect(inactiveRule).not.toContain("Knowledge Graph");
    expect(activeRule).toContain("Graph Engineering");
    expect(activeRule).not.toContain("Knowledge Graph");
  });

  it("rejects a preserve entry that also declares a Chinese translation", () => {
    expect(() => defineTechnicalTermCatalog([{
      canonical: "Conflicting Preserve Term",
      aliases: [],
      categories: ["domain"],
      policy: "preserve",
      preferredZh: "冲突译法",
    }])).toThrow(/conflicting-term-policy|preserve.*preferredZh/i);
  });
});
