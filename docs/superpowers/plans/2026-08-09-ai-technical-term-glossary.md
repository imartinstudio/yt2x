# AI Technical Term Glossary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one source-aware AI terminology guard and make every generated or translated artifact preserve known and newly discovered technical terms consistently.

**Architecture:** `packages/core` owns a machine-readable catalog and a pure, deep terminology-guard module. `packages/adapters-node` owns one cached LLM discovery adapter and applies the same immutable term profile before and after every generation, translation, rewrite, compression, and repair pass. Existing helper exports remain compatibility facades while all current callers migrate to the guard.

**Tech Stack:** TypeScript, Vitest, existing `LlmPort`, Zod where persisted metadata is parsed, pnpm monorepo tooling.

## Global Constraints

- Follow `/Users/martin/Code/yt2x/docs/superpowers/specs/2026-08-09-ai-technical-term-glossary-design.md` exactly.
- All implementation work uses TDD: add the focused failing test, run it and record RED, then write production code and record GREEN.
- `packages/core` stays pure: no filesystem, network, process, browser, or provider calls.
- No real provider, transcription, TTS, ffmpeg burn, mixing, or full media job may run during implementation.
- `files/downloads/` remains untouched; run `pnpm check:downloads` before final completion.
- Never introduce a term absent from the source. Known aliases may canonicalize to catalog spelling; discovered terms preserve their actual source spelling.
- Matching is longest-first. Complete terms such as `Knowledge Graph` win over bare `Graph`.
- Ordinary image words such as `截图`, `图片`, `图表`, `流程图`, `封面图`, `配图`, `插图`, `地图`, and `示意图` must never become `Graph`.
- Every LLM rewrite or repair pass reuses the same immutable `TechnicalTermProfile` and restoration context as the initial pass.
- Existing product names, people names, and fixed Chinese dub translations migrate to the catalog without changing their current output behavior.
- Do not add a second terminology array in any prompt or adapter. New known terms enter only through the central catalog.
- Commit messages must follow repository format: English sentence-case subject, explanatory body, and an `Included:` bullet list; do not use Conventional Commit prefixes.

---

### Task 1: Build the central catalog and pure terminology guard

**Files:**
- Create: `packages/core/src/domain/technical-term-catalog.ts`
- Create: `packages/core/src/domain/technical-term-catalog.test.ts`
- Modify: `packages/core/src/domain/technical-terms.ts`
- Modify: `packages/core/src/domain/technical-terms.test.ts`
- Modify: `packages/core/src/domain/shared-rules.ts`
- Modify: `packages/core/src/domain/shared-rules.test.ts`
- Modify: `packages/core/src/domain/dub/glossary.ts`
- Modify: `packages/core/src/domain/dub/glossary.test.ts`

**Interfaces:**
- Produces `TECHNICAL_TERM_CATALOG`, `TECHNICAL_TERM_CATALOG_FINGERPRINT`, and the catalog types.
- Produces `createTechnicalTermGuard(args): TechnicalTermGuard` and compatibility wrappers for current callers.
- Later tasks consume the guard, catalog fingerprint, violations, discovery-candidate type, and prepared restoration context.

- [ ] **Step 1: Add catalog and guard contract tests that fail before implementation**

Add tests for these exact public shapes and outcomes:

```ts
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
```

Also assert:

```ts
expect(
  (() => {
    const imageGuard = createTechnicalTermGuard({ sourceText: "Add a screenshot and a flow chart." });
    const imagePrepared = imageGuard.prepare("Add a screenshot and a flow chart.");
    return imageGuard.finalize("添加一张截图和流程图。", imagePrepared.restoration).value;
  })(),
).toBe("添加一张截图和流程图。");

expect(
  createTechnicalTermGuard({
    sourceText: "Agentic RAG",
    discoveredTerms: [{ sourceText: "Agentic RAG", confidence: "high", category: "ai-agent" }],
  }).profile.entries.some((entry) => entry.canonical === "Agentic RAG"),
).toBe(true);
```

Catalog tests must assert canonical uniqueness, alias conflict rejection, required `preferredZh` for `fixed-zh`, stable order-independent fingerprinting, and initial AI/AI Coding/AI Agent entries from the design. Existing `PROTECTED_GLOSSARY_TERMS`, `PROTECTED_NAMES`, `PROTECTED_TERMS`, and `DUB_TERM_TRANSLATIONS` tests must continue to pass through catalog-derived compatibility exports.

- [ ] **Step 2: Run the focused tests and capture RED**

Run:

```bash
pnpm test packages/core/src/domain/technical-term-catalog.test.ts packages/core/src/domain/technical-terms.test.ts packages/core/src/domain/shared-rules.test.ts packages/core/src/domain/dub/glossary.test.ts
```

Expected: failure because the catalog exports and `createTechnicalTermGuard` do not exist.

- [ ] **Step 3: Implement the catalog and guard with a small interface**

Use these public types:

```ts
export type TechnicalTermPolicy = "preserve" | "fixed-zh" | "contextual-preserve";
export type TechnicalTermCategory = "ai" | "ai-coding" | "ai-agent" | "product" | "person" | "domain";
export type TechnicalTermEntry = {
  canonical: string;
  aliases: readonly string[];
  categories: readonly TechnicalTermCategory[];
  policy: TechnicalTermPolicy;
  preferredZh?: string;
  forbiddenZh?: readonly string[];
};
export type DiscoveredTechnicalTerm = {
  sourceText: string;
  confidence: "high" | "medium" | "low";
  category: TechnicalTermCategory;
};
export type TechnicalTermViolationCode =
  | "missing-canonical-term"
  | "forbidden-translation"
  | "unrestored-placeholder"
  | "invented-canonical-term"
  | "conflicting-term-policy";
export type TechnicalTermViolation = {
  code: TechnicalTermViolationCode;
  canonical?: string;
  message: string;
};
export type ResolvedTechnicalTerm = {
  canonical: string;
  sourceText: string;
  policy: TechnicalTermPolicy;
  preferredZh?: string;
  forbiddenZh: readonly string[];
};
export type TechnicalTermOccurrence = {
  canonical: string;
  sourceText: string;
  start: number;
  end: number;
};
export type TechnicalTermProfile = {
  sourceFingerprint: string;
  entries: readonly ResolvedTechnicalTerm[];
  occurrences: readonly TechnicalTermOccurrence[];
  profileFingerprint: string;
};
export type TechnicalTermRestoration = {
  placeholders: readonly { token: string; canonical: string }[];
};
export type PreparedTechnicalTermValue<T> = {
  value: T;
  promptRule: string;
  restoration: TechnicalTermRestoration;
  profileFingerprint: string;
};
export type FinalizedTechnicalTermValue<T> = {
  value: T;
  violations: readonly TechnicalTermViolation[];
};
export type TechnicalTermGuard = {
  readonly profile: TechnicalTermProfile;
  prepare<T>(value: T): PreparedTechnicalTermValue<T>;
  finalize<T>(value: T, restoration: TechnicalTermRestoration): FinalizedTechnicalTermValue<T>;
  validate<T>(value: T): readonly TechnicalTermViolation[];
};
export declare const hasHardTechnicalTermViolations: (
  violations: readonly TechnicalTermViolation[],
) => boolean;
export declare const appendTechnicalTermRuleToSystemPrompt: (
  systemPrompt: string,
  promptRule: string,
) => string;
```

`prepare<T>` recursively replaces active terms in string/array/object values with stable private-use placeholders and returns `{ value, promptRule, restoration, profileFingerprint }`. `finalize<T>` restores placeholders, applies source-scoped forbidden-translation recovery, and returns `{ value, violations }`. `validate<T>` performs the same read-only checks without changing the value. Restoration contexts are immutable and call-local so concurrent subtitle batches cannot share placeholder state.

The guard exposes its immutable `profile` as read-only data for persistence and audit; callers cannot mutate catalog entries or occurrences.

Generate `SHARED_TECHNICAL_TERMS` from generic policy language, not a hand-maintained five-term list. Generate dub compatibility arrays from catalog categories and policies.

- [ ] **Step 4: Run focused tests and capture GREEN**

Run the Step 2 command. Expected: all focused tests pass with pristine output.

- [ ] **Step 5: Run typecheck and commit Task 1**

Run:

```bash
pnpm run typecheck
```

Commit only Task 1 files with subject `Build the shared technical term guard` and a body describing the catalog, immutable guard, and compatibility exports.

---

### Task 2: Add cached source-level unknown-term discovery

**Files:**
- Create: `packages/core/src/domain/technical-term-discovery.ts`
- Create: `packages/core/src/domain/technical-term-discovery.test.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/adapters-node/src/technical-terms/discovery.ts`
- Create: `packages/adapters-node/src/technical-terms/discovery.test.ts`
- Create: `packages/adapters-node/src/technical-terms/index.ts`
- Modify: `packages/adapters-node/src/index.ts`

**Interfaces:**
- Consumes catalog fingerprint and `DiscoveredTechnicalTerm` from Task 1.
- Produces `discoverTechnicalTerms(input): Promise<TechnicalTermDiscoveryResult>` and `repairTechnicalTermViolations<T>(input): Promise<FinalizedTechnicalTermValue<T>>` for every later adapter task.

- [ ] **Step 1: Write failing pure-parser and adapter-cache tests**

Core parser tests must reject candidates not present in the source and divide results exactly as follows:

```ts
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
```

Adapter tests use a fake `LlmPort` and call discovery twice with the same source/model. Assert one LLM call, identical result, a prompt that requires exact source spans, and zero calls when the source has no Latin letters/digits/code markers and no catalog match.

Add repair tests for a string and nested JSON value. The initial value omits `Latent Workspace Routing`; the fake repair response returns the same shape with the exact source term. Assert exactly one repair call, guard finalization after repair, and no second repair when violations remain.

- [ ] **Step 2: Run discovery tests and capture RED**

Run:

```bash
pnpm test packages/core/src/domain/technical-term-discovery.test.ts packages/adapters-node/src/technical-terms/discovery.test.ts
```

Expected: failure because discovery modules do not exist.

- [ ] **Step 3: Implement pure validation and the adapter**

Core exports a versioned discovery prompt builder and strict parser. The parser accepts only source-locatable candidates, sends `high` to `accepted`, `medium` to `reviewCandidates`, drops `low`, and emits machine-readable warnings for malformed or hallucinated candidates.

The adapter reuses `LlmPort`, caches in-flight and completed promises by stable source fingerprint + model + discovery prompt version + catalog fingerprint, uses `temperature: 0.1` and JSON mode, and converts provider/parse failure to `technical-term-discovery-unavailable` while returning an empty accepted list. Do not write discovery artifacts to `files/downloads/`.

`repairTechnicalTermViolations` accepts the guard, current string or JSON value, its restoration context, current violations, and a caller-supplied response parser. It makes at most one low-temperature targeted repair call, requires the response to keep the same outer shape, then runs the same guard finalization and validation. If violations remain, return them to the caller; never loop or silently accept the result.

Implement the adapter interface with this shape:

```ts
export declare const discoverTechnicalTerms: (
  input: DiscoverTechnicalTermsInput,
  ) => Promise<TechnicalTermDiscoveryResult>;

export declare const repairTechnicalTermViolations: <T>(
  input: RepairTechnicalTermViolationsInput<T>,
  ) => Promise<FinalizedTechnicalTermValue<T>>;
```

- [ ] **Step 4: Run discovery tests and typecheck**

Run the Step 2 command, then `pnpm run typecheck`. Expected: all pass.

- [ ] **Step 5: Commit Task 2**

Commit only Task 2 files with subject `Discover source technical terms once per run` and a body describing exact-span validation, confidence routing, and cache keys.

---

### Task 3: Apply the guard to articles, notes, posts, and JSON outputs

**Files:**
- Modify: `packages/adapters-node/src/article/generator.ts`
- Modify: `packages/adapters-node/src/article/generator.test.ts`
- Modify: `packages/adapters-node/src/article/file-store.ts`
- Modify: `packages/adapters-node/src/article/file-store.test.ts`
- Modify: `packages/cli/src/orchestrator/native-article.ts`
- Modify: `packages/cli/src/orchestrator/native-article.test.ts`
- Modify: `packages/adapters-node/src/notes/generator.ts`
- Modify: `packages/adapters-node/src/notes/generator.test.ts`
- Modify: `packages/adapters-node/src/platform-article/generator.ts`
- Modify: `packages/adapters-node/src/platform-article/generator.test.ts`
- Modify: `packages/adapters-node/src/thread/generator.ts`
- Modify: `packages/adapters-node/src/thread/generator.test.ts`
- Modify: `packages/adapters-node/src/short/generator.ts`
- Modify: `packages/adapters-node/src/short/generator.test.ts`
- Modify: `packages/adapters-node/src/video-short/generator.ts`
- Modify: `packages/adapters-node/src/video-short/generator.test.ts`
- Modify: `packages/adapters-node/src/deconstruct/generator.ts`
- Modify: `packages/adapters-node/src/deconstruct/generator.test.ts`
- Modify: `packages/adapters-node/src/deconstruct/post-generator.ts`
- Modify: `packages/adapters-node/src/deconstruct/post-generator.test.ts`

**Interfaces:**
- Consumes `discoverTechnicalTerms` and `createTechnicalTermGuard`.
- Produces guarded Markdown and guarded nested JSON while preserving existing public generator result types.

- [ ] **Step 1: Add one shared behavior fixture to each generator family and observe RED**

Use source text containing catalog terms plus the discovered-only term `Latent Workspace Routing`. Fake discovery returns it as `high`. Fake generation responses deliberately translate catalog terms and omit/translate the unknown term; the one targeted repair response restores the exact term. Assert final title/body/tags/hooks/timeline/JSON fields contain canonical terms, source placeholders never escape, and a catalog term absent from the source is not invented.

For article title behavior, retain the existing rule that only terms present in the source title are forced into H1. For body and nested JSON, all active source terms are eligible.

- [ ] **Step 2: Run content-generator tests and capture RED**

Run:

```bash
pnpm test packages/adapters-node/src/article packages/adapters-node/src/notes packages/adapters-node/src/platform-article packages/adapters-node/src/thread packages/adapters-node/src/short packages/adapters-node/src/video-short packages/adapters-node/src/deconstruct
```

Expected: new assertions fail because current generators use static prompts and legacy post-process helpers only.

- [ ] **Step 3: Integrate discovery and the immutable guard in every generator**

For each generator:

1. Discover terms once from the complete source context.
2. Create one guard from source text/title + accepted discovered terms.
3. Call `prepare` on the source payload sent to the LLM.
4. Append only `prepared.promptRule` to the existing system prompt.
5. Finalize the generated string or parsed JSON with the matching restoration context.
6. If hard violations remain, call `repairTechnicalTermViolations` once and finalize again.
7. Reject remaining hard violations using the generator's existing error path; do not persist a target that fails terminology validation.

Add `technicalTermProfileFingerprint` to `GenerateXArticleResult` and `NativeArticleRunRecord`, pass it through `native-article.ts`, and assert `run.json` records it. Do not change article file naming or overwrite behavior.

Do not copy term arrays into prompt files. Keep prompt builders pure and pass the dynamic rule from the adapter.

Use one shared call sequence in every generator rather than reimplementing matching logic:

```ts
const discovery = await discoverTechnicalTerms({ llm, model, sourceText });
const guard = createTechnicalTermGuard({ sourceText, sourceTitle, discoveredTerms: discovery.accepted });
const prepared = guard.prepare(sourcePayload);
const response = await llm.chat({
  ...request,
  messages: [
    {
      role: "system",
      content: appendTechnicalTermRuleToSystemPrompt(systemPrompt, prepared.promptRule),
    },
    { role: "user", content: buildUserPrompt(prepared.value) },
  ],
});
let finalized = guard.finalize(parseResponse(response.content), prepared.restoration);
if (hasHardTechnicalTermViolations(finalized.violations)) {
  finalized = await repairTechnicalTermViolations({
    llm,
    model,
    guard,
    currentValue: finalized.value,
    restoration: prepared.restoration,
    violations: finalized.violations,
    parseResponse,
  });
}
if (hasHardTechnicalTermViolations(finalized.violations)) throw new Error("technical term validation failed");
```

- [ ] **Step 4: Run content tests and typecheck**

Run the Step 2 command, then `pnpm run typecheck`. Expected: all pass.

- [ ] **Step 5: Commit Task 3**

Commit only Task 3 files with subject `Guard technical terms in generated text` and a body listing Markdown, title, and nested JSON coverage.

---

### Task 4: Protect ordinary SRT translation and every repair phase

**Files:**
- Modify: `packages/adapters-node/src/acquire/srt-translator.ts`
- Modify: `packages/adapters-node/src/acquire/srt-translator.test.ts`
- Modify: `packages/adapters-node/src/acquire/video-subtitles.ts`
- Modify: `packages/adapters-node/src/acquire/video-subtitles.test.ts`

**Interfaces:**
- Consumes the discovery adapter and guard.
- Extends `SrtTranslatorOptions` with optional pre-resolved discovery/profile input so callers can reuse a full-source profile without repeating discovery.

- [ ] **Step 1: Write failing SRT regression tests**

Add a source SRT with:

```text
Graph Engineering connects Knowledge Graph and Agent Graph.
Latent Workspace Routing keeps the agent state.
Add a screenshot and a flow chart.
```

The fake model returns `图工程连接知识图谱和代理图谱。`, `潜在工作区路由保存代理状态。`, and `添加截图和流程图。`. Fake discovery accepts `Latent Workspace Routing`. Assert the final SRT contains all four English technical terms and still contains `截图` and `流程图`.

Add a repair-path test where the initial response omits one cue and the repair response again translates `Knowledge Graph`; assert both initial and repair system prompts contain the same active term rule and final output is canonical.

Add a cross-cue test where `Model Context` ends one cue and `Protocol` starts the next. Validate the concatenated output range contains `Model Context Protocol` exactly once.

- [ ] **Step 2: Run SRT tests and capture RED**

Run:

```bash
pnpm test packages/adapters-node/src/acquire/srt-translator.test.ts packages/adapters-node/src/acquire/video-subtitles.test.ts
```

Expected: new term assertions fail and repair prompts lack the active term profile.

- [ ] **Step 3: Implement full-source profile reuse**

Build or accept one profile for the complete SRT. Prepare each batch with call-local restoration data, append the same active rule to normal and repair prompts, finalize per complete term occurrence, then validate cross-cue occurrence ranges on concatenated output. If a complete or cross-cue term still violates the profile, make one range-level targeted repair call and validate again; never duplicate a cross-cue term into every cue.

Apply Simplified Chinese and homoglyph normalization before final guard validation, so those post-processors cannot alter canonical terms after the guard has passed. Retain existing fallback and warning behavior for non-term translation gaps.

The batch path must retain its restoration context beside the batch result:

```ts
const prepared = guard.prepare(payload);
const translated = await translateBatch(prepared.value, `${systemPrompt}\n${prepared.promptRule}`);
const finalized = guard.finalize(translated, prepared.restoration);
```

For cross-cue occurrences, validate the joined translated text for the recorded contiguous index range and pass only that range to the single targeted repair.

- [ ] **Step 4: Run SRT tests and typecheck**

Run the Step 2 command, then `pnpm run typecheck`. Expected: all pass.

- [ ] **Step 5: Commit Task 4**

Commit only Task 4 files with subject `Preserve technical terms in subtitle translation` and a body describing normal, repair, and cross-cue enforcement.

---

### Task 5: Preserve terms through semantic bilingual translation and compaction

**Files:**
- Modify: `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.ts`
- Modify: `packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts`
- Modify: `packages/adapters-node/src/acquire/audit-subtitles.ts`
- Modify: `packages/adapters-node/src/acquire/audit-subtitles.test.ts`
- Modify: `packages/adapters-node/src/acquire/video-subtitles.ts`
- Modify: `packages/adapters-node/src/acquire/video-subtitles.test.ts`

**Interfaces:**
- Consumes one full-source `TechnicalTermProfile` from Task 4.
- Adds `technicalTermProfileFingerprint` to the semantic subtitle manifest and cache check.

- [ ] **Step 1: Add failing semantic-path tests**

Add separate tests proving:

- Phase-1 translation restores `Graph Engineering`, `Knowledge Graph`, and a discovered-only term.
- `requestContentAlignedSplit` cannot replace a preserved term with Chinese.
- `requestCompactRewrite` and CPS compaction reject or restore a response that drops the term.
- Final `zhSrt` and `bilingualSrt` contain identical canonical terms.
- The audit emits `glossary-violation` or the new terminology violation when a required term is absent.
- Changing only `technicalTermProfileFingerprint` causes semantic translation cache miss.

- [ ] **Step 2: Run semantic tests and capture RED**

Run:

```bash
pnpm test packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts packages/adapters-node/src/acquire/audit-subtitles.test.ts packages/adapters-node/src/acquire/video-subtitles.test.ts
```

Expected: new assertions fail because only the legacy dub glossary is checked.

- [ ] **Step 3: Thread the immutable profile through every semantic LLM pass**

Replace direct `PROTECTED_TERMS` scans with guard/profile validation. Use the same profile for phase-1 translation, protected-term repair, content-aligned split, width rewrite, CPS rewrite, final blocks, and audit. Every accepted rewrite must pass guard finalization before replacing current text; one targeted repair is allowed for remaining hard violations. Add the profile fingerprint to manifest creation and cache matching without writing a new file under downloads.

Route each candidate text through one helper owned by this module:

```ts
const finalizeSemanticText = async (
  sourceText: string,
  candidate: string,
  restoration: TechnicalTermRestoration,
): Promise<string | null> => {
  const finalized = guard.finalize(candidate, restoration);
  const repaired = hasHardTechnicalTermViolations(finalized.violations)
    ? await repairTechnicalTermViolations({
        llm: opts.llm,
        model: opts.model,
        guard,
        currentValue: finalized.value,
        restoration,
        violations: finalized.violations,
        parseResponse: (content) => content.trim(),
      })
    : finalized;
  return hasHardTechnicalTermViolations(repaired.violations) ? null : repaired.value;
};
```

Existing fallback behavior keeps the previous valid text when this helper returns `null`; final delivery validation still fails if the source-required term is absent.

- [ ] **Step 4: Run semantic tests and typecheck**

Run the Step 2 command, then `pnpm run typecheck`. Expected: all pass.

- [ ] **Step 5: Commit Task 5**

Commit only Task 5 files with subject `Carry term profiles through bilingual subtitles` and a body describing translation, split, compaction, audit, and cache coverage.

---

### Task 6: Preserve terms through every dubbing translation pass

**Files:**
- Modify: `packages/core/src/domain/dub/translate-prompts.ts`
- Modify: `packages/core/src/domain/dub/translate-prompts.test.ts`
- Modify: `packages/core/src/domain/dub/types.ts`
- Modify: `packages/adapters-node/src/dub/translate.ts`
- Modify: `packages/adapters-node/src/dub/translate.test.ts`
- Modify: `packages/adapters-node/src/dub/script.ts`
- Modify: `packages/adapters-node/src/dub/script.test.ts`
- Modify: `packages/adapters-node/src/dub/file-store.ts`
- Modify: `packages/adapters-node/src/dub/file-store.test.ts`

**Interfaces:**
- Consumes discovery and guard modules.
- Adds `technicalTermProfileFingerprint: string` to `DubScript` version 3; old version 2 remains a cache miss and is regenerated.

- [ ] **Step 1: Write failing dubbing tests**

Use an utterance `Graph Engineering connects the Knowledge Graph and Agent Graph through Latent Workspace Routing.` Fake each pass independently so initial, repair, tighten, expand, glossary repair, or speakable repair returns a Chinese-only term. Assert the accepted final `DubTranslatedLine.text` contains all canonical terms and the discovered term.

Add prompt tests asserting active terms are injected into every prompt builder without a copied global list. Add file-store tests requiring DubScript version 3 and the profile fingerprint; version 2 must be rejected as a cache miss by the existing caller behavior.

- [ ] **Step 2: Run dubbing tests and capture RED**

Run:

```bash
pnpm test packages/core/src/domain/dub/translate-prompts.test.ts packages/adapters-node/src/dub/translate.test.ts packages/adapters-node/src/dub/script.test.ts packages/adapters-node/src/dub/file-store.test.ts
```

Expected: term-preservation and version-3 assertions fail.

- [ ] **Step 3: Integrate one profile across all dubbing passes**

Discover from the complete utterance transcript once. Build one guard, add the active prompt rule to initial/repair/tighten/expand/glossary/speakable prompts, finalize every candidate before acceptance checks, and use at most one targeted repair for remaining hard violations. Reject any still-invalid candidate. Store the profile fingerprint in the generated script and schema. Do not change timing-budget formulas, TTS behavior, synthesis, placement, or mixing.

Centralize candidate acceptance inside `translate.ts`:

```ts
const acceptDubCandidate = async (utterance: Utterance, text: string): Promise<string | null> => {
  const prepared = preparedByUtterance.get(utterance.index)!;
  const finalized = guard.finalize(text, prepared.restoration);
  const repaired = hasHardTechnicalTermViolations(finalized.violations)
    ? await repairTechnicalTermViolations({
        llm: input.llm,
        model: input.model,
        guard,
        currentValue: finalized.value,
        restoration: prepared.restoration,
        violations: finalized.violations,
        parseResponse: (content) => content.trim(),
      })
    : finalized;
  return hasHardTechnicalTermViolations(repaired.violations) ? null : repaired.value;
};
```

All six pass handlers call this helper before `translated.set(...)`.

- [ ] **Step 4: Run dubbing tests and typecheck**

Run the Step 2 command, then `pnpm run typecheck`. Expected: all pass.

- [ ] **Step 5: Commit Task 6**

Commit only Task 6 files with subject `Guard technical terms in dubbing scripts` and a body describing all rewrite passes and cache-version behavior.

---

### Task 7: Guard platform visual prompts and complete repository verification

**Files:**
- Modify: `packages/adapters-node/src/platform-format/prompt-orchestrator.ts`
- Modify: `packages/adapters-node/src/platform-format/prompt-orchestrator.test.ts`
- Modify: `packages/adapters-node/src/platform-format/xiaohongshu-layout.ts`
- Modify: `packages/adapters-node/src/platform-format/xiaohongshu-layout.test.ts`
- Modify: `docs/DATA-CONTRACTS.md`

**Interfaces:**
- Consumes discovery and guard modules.
- Produces guarded cover prompts, illustration prompts, image names, and in-image labels for X, WeChat, Xiaohongshu, and Bilibili.

- [ ] **Step 1: Add failing visual-prompt tests**

Use an article title/body containing `Graph Engineering`, `Knowledge Graph`, and discovered-only `Latent Workspace Routing`. Fake cover and illustration LLM outputs with Chinese-only replacements. Assert saved `prompts.json`, rendered preview data, `name`, and `prompt` fields contain canonical terms; assert normal `配图`, `插图`, and `流程图` labels remain Chinese.

- [ ] **Step 2: Run platform-format tests and capture RED**

Run:

```bash
pnpm test packages/adapters-node/src/platform-format/prompt-orchestrator.test.ts packages/adapters-node/src/platform-format/xiaohongshu-layout.test.ts
```

Expected: new visual terminology assertions fail.

- [ ] **Step 3: Integrate the guard and document persisted fingerprints**

Discover once from full article title/body, reuse one profile for cover and illustration calls, finalize prompt/name/text fields before writing `prompts.json`, allow one targeted repair for remaining hard violations, and fail only the affected platform target if repair still fails. Update `docs/DATA-CONTRACTS.md` to document article run metadata, semantic manifest, and DubScript terminology fingerprints/version changes without adding real video IDs or URLs.

Prepare and finalize the complete persisted prompt object so nested fields cannot bypass the guard:

```ts
const prepared = guard.prepare({ title, body });
// Use prepared.value in cover and illustration user prompts.
let finalized = guard.finalize({ coverPrompts, illustrationPrompts }, prepared.restoration);
if (hasHardTechnicalTermViolations(finalized.violations)) {
  finalized = await repairTechnicalTermViolations({
    llm: input.llm,
    model: input.llmModel,
    guard,
    currentValue: finalized.value,
    restoration: prepared.restoration,
    violations: finalized.violations,
    parseResponse: (content) => JSON.parse(content) as typeof finalized.value,
  });
}
if (hasHardTechnicalTermViolations(finalized.violations)) throw new Error("technical term validation failed");
await writeFile(promptsPath, JSON.stringify(finalized.value, null, 2), "utf8");
```

- [ ] **Step 4: Run focused and aggregate verification**

Run:

```bash
pnpm test packages/core/src/domain/technical-term-catalog.test.ts packages/core/src/domain/technical-terms.test.ts packages/core/src/domain/technical-term-discovery.test.ts packages/core/src/domain/shared-rules.test.ts packages/core/src/domain/dub/glossary.test.ts packages/core/src/domain/dub/translate-prompts.test.ts packages/adapters-node/src/technical-terms/discovery.test.ts packages/adapters-node/src/article packages/adapters-node/src/notes packages/adapters-node/src/platform-article packages/adapters-node/src/thread packages/adapters-node/src/short packages/adapters-node/src/video-short packages/adapters-node/src/deconstruct packages/adapters-node/src/acquire/srt-translator.test.ts packages/adapters-node/src/acquire/semantic-bilingual-subtitles.test.ts packages/adapters-node/src/acquire/audit-subtitles.test.ts packages/adapters-node/src/acquire/video-subtitles.test.ts packages/adapters-node/src/dub/translate.test.ts packages/adapters-node/src/dub/script.test.ts packages/adapters-node/src/dub/file-store.test.ts packages/adapters-node/src/platform-format/prompt-orchestrator.test.ts packages/adapters-node/src/platform-format/xiaohongshu-layout.test.ts
pnpm run typecheck
pnpm exec prettier --check packages/core/src packages/adapters-node/src docs/DATA-CONTRACTS.md
pnpm check:downloads
git diff --check
```

Expected: all tests and checks pass, no provider/media command runs, downloads check reports no writes.

- [ ] **Step 5: Commit Task 7**

Commit only Task 7 files with subject `Preserve terms in platform visual prompts` and a body describing visual fields, documentation, and final verification.

---

## Final Review Requirements

After all seven tasks are individually reviewed:

1. Generate a whole-branch diff from `git merge-base main HEAD` to `HEAD`.
2. Review spec compliance against the design and this plan, including deferred ledger findings.
3. Confirm the branch contains no real provider calls, media outputs, credentials, cookies, or changes under `files/`.
4. Run `pnpm run typecheck`, the aggregate focused test command, `pnpm check:downloads`, and `git diff --check` on the final reviewed commit.
5. Do not push, open a PR, or merge unless the user separately requests those delivery actions.
