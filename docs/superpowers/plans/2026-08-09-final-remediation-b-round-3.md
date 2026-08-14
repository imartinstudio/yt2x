# Final Remediation B Round 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make content cache reconstruction exact and make versioned content bundles, locks, readers, selectors, and generation cleanup safe across processes and filesystem aliases.

**Architecture:** Content metadata will persist separate known-source and required-source identities so cache checks can deterministically rebuild the same two-layer guard. Deconstruct will persist a run identity independent of selected clip-post metadata. Versioned bundles will keep a stable public root containing immutable generations and an atomically replaced active-generation pointer; all consumers resolve through one adapter helper under a canonical root lock.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, pnpm workspaces.

## Global Constraints

- Strict TDD: observe each focused test fail before production changes.
- Do not call real providers or process real media; use temporary fixtures and fakes only.
- Do not touch subtitles, Dashboard, XHS, or generated `files/` outputs.
- Run focused tests, `pnpm typecheck`, and `git diff --check`; leave the full suite to the controller.
- Commit with the repository's complete subject/body format and append the Final Remediation B report.

---

### Task 1: Reconstructible two-layer content metadata

**Files:**
- Modify: `packages/adapters-node/src/content-cache.ts`
- Modify: `packages/adapters-node/src/content-cache.test.ts`
- Modify: `packages/adapters-node/src/thread/generator.ts`
- Modify: `packages/adapters-node/src/short/generator.ts`
- Modify: `packages/adapters-node/src/video-short/generator.ts`
- Test: target generator and file-store tests beside those files

**Interfaces:**
- Produces metadata fields `knownSourceIdentity`, `requiredSourceIdentity`, and a reproducible two-layer profile fingerprint.
- Freshness consumes both source texts/titles and reconstructs the same scoped guard used during generation.

- [ ] Add real generate-to-metadata-to-freshness tests for thread, short, and video-short; verify a second run has zero provider calls.
- [ ] Run the tests and confirm failure because current metadata stores only a combined profile hash.
- [ ] Add the dual-source metadata contract and update all three generators/writers/readers to use identical reconstruction inputs.
- [ ] Re-run focused tests until green without weakening terminology validation.

### Task 2: Independent deconstruct run cache identity

**Files:**
- Modify: `packages/adapters-node/src/deconstruct/generator.ts`
- Modify: `packages/adapters-node/src/deconstruct/generator.test.ts`
- Modify: `packages/cli/src/commands/deconstruct.ts`
- Modify: `packages/cli/src/commands/deconstruct.test.ts`

**Interfaces:**
- Produces a persisted `deconstruct-run` metadata record based only on candidate input identity and candidate discovery audit.
- Clip-post metadata remains based only on selected clips and selected post source scope.

- [ ] Add a production-style CLI test using real metadata freshness and fake LLM ports only; run the command twice and assert the second run makes zero provider calls.
- [ ] Confirm RED because current cache rebuilds clip-post source from all manifest candidates or mocks freshness.
- [ ] Persist and compare deconstruct-run identity before creating either provider, then independently validate selected clip-post metadata.
- [ ] Re-run deconstruct tests and confirm SRT/video/duration/article/model/version changes stale only the appropriate run identity.

### Task 3: Stable-root version bundles and selector transaction

**Files:**
- Modify: `packages/adapters-node/src/content-transaction.ts`
- Modify: `packages/adapters-node/src/content-transaction.test.ts`
- Modify: `packages/adapters-node/src/deconstruct/post-generator.ts`
- Modify: `packages/adapters-node/src/deconstruct/publish-readiness.ts`
- Modify: `packages/adapters-node/src/deconstruct/publisher.ts`
- Modify: `packages/adapters-node/src/deconstruct/selector.ts`
- Modify: matching deconstruct tests
- Modify: `packages/cli/src/commands/deconstruct.ts`

**Interfaces:**
- `replaceDirectoryAtomically(stagedDir, rootDir)` keeps `rootDir` as a stable entity and publishes `.active-generation` atomically.
- `resolveContentBundleDir(rootDir)` returns the immutable active generation, with a legacy-root fallback before first publication.
- `selectClips` acquires the same canonical target lock and commits a copied generation instead of mutating an active manifest.

- [ ] Add tests that continuously resolve/read the root during first migration and selection, proving no root ENOENT and no lost selected state.
- [ ] Confirm RED against the root-as-symlink implementation and unlocked selector.
- [ ] Implement stable root, immutable `.generations`, atomic pointer publishing, legacy snapshot migration, and pointer-aware readers/writers.
- [ ] Re-run transaction, post, readiness, publisher, selector, and CLI tests until green.

### Task 4: Canonical alias locks and bounded generation GC

**Files:**
- Modify: `packages/adapters-node/src/content-transaction.ts`
- Modify: `packages/adapters-node/src/content-transaction.test.ts`

**Interfaces:**
- Lock acquisition canonicalizes an existing root with `realpath`; for a missing root it canonicalizes the nearest existing ancestor and appends the unresolved suffix.
- Successful bundle commit retains the active generation plus at least one previous generation and removes older inactive generations while holding the root lock.

- [ ] Add alias-lock tests using a real directory and symlink, including a not-yet-created suffix; confirm concurrent critical sections currently overlap.
- [ ] Add repeated-commit tests proving generation count remains bounded and active/previous generations stay readable; confirm current implementation grows without bound.
- [ ] Implement canonical lock identity and bounded inactive-generation GC without deleting active or previous generations.
- [ ] Re-run focused transaction and real-writer concurrency tests until green.

### Task 5: Verification, report, and commit

**Files:**
- Modify: `.superpowers/sdd/2026-08-09-ai-technical-term-glossary/final-remediation-b-report.md`

- [ ] Run all reviewer-focused tests and `pnpm typecheck`.
- [ ] Run `git diff --check` and inspect only the scoped diff/status.
- [ ] Append Round 3 RED/GREEN evidence, test counts, compatibility notes, and explicit exclusions to the report.
- [ ] Stage the exact allowlist and create one complete-format commit.
