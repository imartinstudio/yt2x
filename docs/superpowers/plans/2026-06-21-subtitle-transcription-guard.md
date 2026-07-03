# Subtitle transcription guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject repeated local Whisper hallucinations, translate with the detected source language, and regenerate derived subtitles on `--force`.

**Architecture:** Keep the safeguards in the acquire subtitle adapter. Add a pure repeated-cue detector next to SRT parsing, invoke it only for `local_transcription`, and rely on the manifest as the canonical actual source-language record. Force removes only derived target subtitles.

**Tech Stack:** TypeScript, Vitest, Node.js filesystem APIs.

---

### Task 1: Guard malformed local transcription

**Files:**

- Modify: `packages/adapters-node/src/acquire/video-subtitles.ts`
- Test: `packages/adapters-node/src/acquire/video-subtitles.test.ts`

- [ ] **Step 1: Write a failing test**

```ts
expect(() => assertNoRepeatedTranscriptionCues(repeatedSrt)).toThrow(/repeated subtitle cues/);
```

- [ ] **Step 2: Run it to verify failure**

Run: `pnpm test packages/adapters-node/src/acquire/video-subtitles.test.ts`

- [ ] **Step 3: Implement the pure guard and invoke it after local SRT cleanup**

```ts
if (longestRepeatedCueRun(cleanedSrt) >= 6) {
  throw new Error(
    "local transcription contains repeated subtitle cues; verify --subtitle-source-lang or use auto",
  );
}
```

- [ ] **Step 4: Verify the focused test passes**

Run: `pnpm test packages/adapters-node/src/acquire/video-subtitles.test.ts`

### Task 2: Use actual source language and honour force

**Files:**

- Modify: `packages/adapters-node/src/acquire/video-subtitles.ts`
- Test: `packages/adapters-node/src/acquire/video-subtitles.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
expect(chatRequest.messages[0]?.content).toContain("Translate from en to zh-CN");
await expect(readFile(zhSrtPath, "utf8")).resolves.not.toContain("stale subtitle");
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm test packages/adapters-node/src/acquire/video-subtitles.test.ts`

- [ ] **Step 3: Implement the smallest changes**

```ts
await rm(zhSrtPath).catch(() => {});
sourceLang: manifest.source_language,
```

- [ ] **Step 4: Run verification**

Run: `pnpm test packages/adapters-node/src/acquire/video-subtitles.test.ts && pnpm run typecheck`
