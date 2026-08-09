# Final Remediation B Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make content cache identity, technical-term validation, deconstruct persistence, and bundle locking match the reviewer contracts without touching real media or providers.

**Architecture:** Keep pure two-layer technical-term semantics in core. Put source/media fingerprinting, canonical bundle locks, and versioned directory transactions in adapters-node. Keep the CLI responsible only for pre-provider cache orchestration and final staged readiness.

**Tech Stack:** TypeScript, Vitest, Node filesystem APIs, pnpm workspace builds.

## Global Constraints

- Strict TDD: every production behavior starts with a focused failing test.
- Tests use temporary fixtures and fake LLMs only.
- Do not read or write real files under files/downloads or files/articles.
- Do not touch subtitles, Dashboard, or XHS.
- Run focused tests, typecheck, and diff checks; leave the full suite to the controller.

---

### Task 1: Deconstruct cache identity

**Files:**
- Modify: packages/adapters-node/src/deconstruct/generator.ts
- Modify: packages/adapters-node/src/content-cache.ts
- Modify: packages/cli/src/commands/deconstruct.ts
- Test: packages/cli/src/commands/deconstruct.test.ts
- Test: packages/adapters-node/src/deconstruct/generator.test.ts

**Interfaces:**
- Produce: deconstructSourceIdentityFor({ articleMd, srtContent, videoPath, durationSec, requestedModel })
- Persist separate candidateTechnicalTerms and clipPostTechnicalTerms metadata records.

- [ ] Add failing tests proving identical source skips all providers while SRT, video bytes/stat, or duration changes force candidate regeneration.
- [ ] Add failing tests proving candidate discovery audit is not replaced by clip-post discovery audit.
- [ ] Implement normalized video path plus content/stat fingerprint and include article, SRT SHA, duration, model, prompt versions, catalog fingerprint, and discovery prompt identity.
- [ ] Run the two focused test files to GREEN.

### Task 2: Two-layer technical-term guard

**Files:**
- Modify: packages/core/src/domain/technical-term-catalog.ts
- Modify: packages/core/src/domain/technical-term-catalog.test.ts
- Modify: packages/adapters-node/src/article/generator.ts
- Modify: packages/adapters-node/src/thread/generator.ts
- Modify: packages/adapters-node/src/short/generator.ts
- Modify: packages/adapters-node/src/video-short/generator.ts
- Test: matching generator test files.

**Interfaces:**
- TechnicalTermGuard.scope keeps the parent full profile as known terms while deriving required occurrences from the selected scope.
- Article required scope uses the long-form source contract rather than the fixed summary extractor.

- [ ] Add three-state tests: omitted detail-only Context Engineering passes; output 上下文工程 fails; output Context Engineering is allowed and not invented.
- [ ] Add article long-form coverage requiring a term from detailed notes.
- [ ] Implement separate known and required profiles for recovery, forbidden/invented checks, missing checks, prompt preparation, and combined fingerprinting.
- [ ] Run core and generator tests to GREEN.

### Task 3: Shared deconstruct bundle transaction

**Files:**
- Modify: packages/adapters-node/src/content-transaction.ts
- Modify: packages/adapters-node/src/deconstruct/post-generator.ts
- Test: packages/adapters-node/src/content-transaction.test.ts
- Test: packages/adapters-node/src/deconstruct/post-generator.test.ts

**Interfaces:**
- Produce: stageDirectoryBundle(targetDir, writeGeneration) or equivalent helper used by both CLI and persist=true direct paths.
- The active clips path remains readable through the version pointer and legacy fallback.

- [ ] Add failing direct-path tests injecting post, manifest, and metadata commit interruption and asserting old bytes remain readable.
- [ ] Add failing legacy migration observation test proving the old path never disappears.
- [ ] Move direct persistence into a sibling unique staging directory and commit through the shared versioned pointer helper.
- [ ] Run transaction and post-generator tests to GREEN.

### Task 4: Canonical bundle lock identity

**Files:**
- Modify: packages/adapters-node/src/content-transaction.ts
- Modify: all changed content file stores and native orchestrators.
- Test: packages/adapters-node/src/content-transaction.test.ts
- Test: packages/cli/src/orchestrator/native-article.test.ts

**Interfaces:**
- Produce: contentBundleLockIdentity(targetRoot) and lock APIs keyed only by canonical bundle root.
- Caller labels remain diagnostic only and cannot create distinct lock paths.

- [ ] Add failing tests showing native-content and direct article/x-short calls resolve to the same lock and serialize.
- [ ] Implement canonical root-derived lock paths and update all callers.
- [ ] Replace remaining Date.now staging suffixes with randomUUID.
- [ ] Run focused concurrency tests to GREEN.

### Task 5: Verification and delivery

**Files:**
- Modify: .superpowers/sdd/2026-08-09-ai-technical-term-glossary/final-remediation-b-report.md

- [ ] Run reviewer-focused Vitest files.
- [ ] Run pnpm typecheck and git diff --check.
- [ ] Append Round 2 evidence and limitations to the report.
- [ ] Stage an explicit allowlist and create a full-format commit.
