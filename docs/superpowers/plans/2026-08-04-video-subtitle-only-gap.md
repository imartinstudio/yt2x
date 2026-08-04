# Video Subtitle-Only Gap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the one functional gap Plan 2's final review surfaced and recorded as a Plan 3
precondition: `yt2x video --video-id <already-acquired> --deliver <non-dubbed tier>` currently does
nothing — it validates the video exists and exits 0 without generating or burning any subtitles. This
plan is "Plan 3a" of the ADR-0005/0006 rollout (Plan 1 and Plan 2 already merged into
`worktree-video-delivery-foundations` / PR #153); Plan 3b (delete `pipeline`/`acquire`/`subtitle`,
migrate docs) depends on this landing first — deleting `yt2x subtitle` while this gap exists would
remove the only way to (re)generate subtitles for an already-downloaded video.

**Architecture:** One targeted addition to `packages/cli/src/orchestrator/native-video.ts`: for the
`--video-id`-only path (no fresh acquire), when the chosen `--deliver` tier needs subtitle work but not
dubbing, call the existing, already-tested `executeNativeSubtitle` (`./native-subtitle.js` — the same
function the standalone `yt2x subtitle` command calls) once per video id. No changes to
`packages/adapters-node`, `native-subtitle.ts` itself, or the fresh-acquire path (which already gets
subtitle work "for free" as part of `prepareYoutubeVideo`, called via `executeNativeAcquire`).

## Global Constraints

- TDD: failing test first, then minimal implementation.
- Default to no comments; one line only when the WHY is non-obvious.
- No backwards-compat shims, no feature flags — this is additive behavior on a command that only Plan 2
  introduced (not yet in a stable release), fixing a real gap before it ships more broadly.
- Must not touch the fresh-acquire path's behavior (`hasUrlSources` branch) — it already generates
  subtitles correctly via `prepareYoutubeVideo`; calling `executeNativeSubtitle` there too would
  duplicate work and could double-burn.
- Must not touch `--deliver dubbed`'s behavior — dubbing generates and burns its own bilingual subtitles
  internally (`executeNativeDub` never calls `runSubtitlePipeline`/`executeNativeSubtitle`); this gap-fix
  must not run for that tier.
- `--deliver none --video-id <id>` must remain a true no-op (nothing to generate).
- Every task ends with `npx tsc -b`, `npx eslint <touched files>`, and a full `npx vitest run` clean.

---

### Task 1: Wire `--video-id`-only delivery to `executeNativeSubtitle` for non-dubbed tiers

**Files:**

- Modify: `packages/cli/src/orchestrator/native-video.ts`
- Modify: `packages/cli/src/orchestrator/native-video.test.ts`

**Interfaces:**

- Consumes: `executeNativeSubtitle(flags: SubtitleFlags): Promise<number>` (existing, unchanged,
  `./native-subtitle.js` — same package, same directory as `native-video.ts`).
- No new exports from `native-video.ts` — `VideoFlags`/`executeNativeVideo`'s public shape is unchanged;
  this only adds internal behavior for inputs that previously silently did nothing.

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/src/orchestrator/native-video.test.ts`. First, register a mock for
`executeNativeSubtitle` alongside the file's existing mocks (`executeNativeAcquireMock`,
`executeNativeDubMock`, `ensureDubPreflightMock`) — add near the top, following the same
`vi.hoisted`/`vi.mock` pattern already used for `./native-dub.js` and `./dub-preflight.js` in this file:

```ts
const executeNativeSubtitleMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./native-subtitle.js", () => ({ executeNativeSubtitle: executeNativeSubtitleMock }));
```

Add to the `beforeEach` block (alongside the existing mock resets):

```ts
  executeNativeSubtitleMock.mockClear();
  executeNativeSubtitleMock.mockResolvedValue(0);
```

Then add a new `describe` block (place it near the existing `describe("executeNativeVideo — dub
wiring", ...)` block, which already has a working `--video-id`-only fixture to model from — that
existing fixture creates `outRoot`, `mkdir`s a video dir, and writes `metadata.json` before calling
`executeNativeVideo` with `videoId: [...]`; reuse that exact fixture shape):

```ts
describe("executeNativeVideo — --video-id-only subtitle generation for non-dubbed tiers", () => {
  it("calls executeNativeSubtitle once per video for a non-dubbed --deliver tier on the --video-id-only path", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-"));
    await mkdir(path.join(outRoot, "existingVid1"), { recursive: true });
    await writeFile(path.join(outRoot, "existingVid1", "metadata.json"), JSON.stringify({ id: "existingVid1" }));

    const code = await executeNativeVideo({
      videoId: ["existingVid1"],
      deliver: "zh-burned",
      outDir: outRoot,
      llmProvider: "openai",
    });

    expect(code).toBe(0);
    expect(executeNativeSubtitleMock).toHaveBeenCalledOnce();
    expect(executeNativeSubtitleMock.mock.calls[0]![0]).toMatchObject({
      videoId: "existingVid1",
      outDir: outRoot,
      subtitleZh: "burned",
      subtitleBilingual: "off",
    });
    expect(executeNativeDubMock).not.toHaveBeenCalled();
  });

  it("maps bilingual-burned correctly on the --video-id-only path", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-bilingual-"));
    await mkdir(path.join(outRoot, "existingVid1"), { recursive: true });
    await writeFile(path.join(outRoot, "existingVid1", "metadata.json"), JSON.stringify({ id: "existingVid1" }));

    await executeNativeVideo({
      videoId: ["existingVid1"],
      deliver: "bilingual-burned",
      outDir: outRoot,
      llmProvider: "openai",
    });

    expect(executeNativeSubtitleMock.mock.calls[0]![0]).toMatchObject({
      subtitleZh: "off",
      subtitleBilingual: "burned",
    });
  });

  it("does not call executeNativeSubtitle for --deliver none (true no-op)", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-none-"));
    await mkdir(path.join(outRoot, "existingVid1"), { recursive: true });
    await writeFile(path.join(outRoot, "existingVid1", "metadata.json"), JSON.stringify({ id: "existingVid1" }));

    const code = await executeNativeVideo({
      videoId: ["existingVid1"],
      deliver: "none",
      outDir: outRoot,
    });

    expect(code).toBe(0);
    expect(executeNativeSubtitleMock).not.toHaveBeenCalled();
  });

  it("does not call executeNativeSubtitle for --deliver dubbed (dub burns its own subtitles)", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-dubbed-"));
    await mkdir(path.join(outRoot, "existingVid1", "video"), { recursive: true });
    await writeFile(path.join(outRoot, "existingVid1", "metadata.json"), JSON.stringify({ id: "existingVid1" }));

    await executeNativeVideo({
      videoId: ["existingVid1"],
      deliver: "dubbed",
      outDir: outRoot,
      llmProvider: "openai",
    });

    expect(executeNativeSubtitleMock).not.toHaveBeenCalled();
    expect(executeNativeDubMock).toHaveBeenCalledOnce();
  });

  it("does not call executeNativeSubtitle on the fresh-acquire (--urls) path — prepareYoutubeVideo already handles it", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-freshacquire-"));
    await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "zh-burned",
      outDir: outRoot,
      llmProvider: "openai",
    });
    expect(executeNativeSubtitleMock).not.toHaveBeenCalled();
    expect(executeNativeAcquireMock).toHaveBeenCalledOnce();
  });

  it("continues past a failed subtitle call under --error-strategy skip and returns a non-zero code", async () => {
    executeNativeSubtitleMock.mockResolvedValueOnce(9).mockResolvedValueOnce(0);
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-skip-"));
    for (const id of ["vidA", "vidB"]) {
      await mkdir(path.join(outRoot, id), { recursive: true });
      await writeFile(path.join(outRoot, id, "metadata.json"), JSON.stringify({ id }));
    }

    const code = await executeNativeVideo({
      videoId: ["vidA", "vidB"],
      deliver: "zh-srt",
      outDir: outRoot,
      llmProvider: "openai",
      errorStrategy: "skip",
    });

    expect(executeNativeSubtitleMock).toHaveBeenCalledTimes(2);
    expect(code).toBe(9);
  });

  it("stops at the first failure under the default --error-strategy stop", async () => {
    executeNativeSubtitleMock.mockResolvedValueOnce(9);
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-stop-"));
    for (const id of ["vidA", "vidB"]) {
      await mkdir(path.join(outRoot, id), { recursive: true });
      await writeFile(path.join(outRoot, id, "metadata.json"), JSON.stringify({ id }));
    }

    const code = await executeNativeVideo({
      videoId: ["vidA", "vidB"],
      deliver: "zh-srt",
      outDir: outRoot,
      llmProvider: "openai",
    });

    expect(code).toBe(9);
    expect(executeNativeSubtitleMock).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/src/orchestrator/native-video.test.ts`
Expected: FAIL — `executeNativeSubtitleMock` is registered but nothing in `native-video.ts` imports or
calls `executeNativeSubtitle` yet, so every `toHaveBeenCalled*` assertion fails.

- [ ] **Step 3: Implement the gap-fix in `native-video.ts`**

Add this import (alongside the existing `./native-dub.js`/`./dub-preflight.js` imports):

```ts
import { executeNativeSubtitle } from "./native-subtitle.js";
```

Replace this exact block (currently right after the `if (hasUrlSources) {...} else {...}` that computes
`videoIds`, and right before the existing `if (internalForDub.needsDub) {...}` dub block):

```ts
  let videoExitCode = 0;
  const internalForDub = internalSubtitleParamsFor(deliver);
  if (internalForDub.needsDub) {
```

with:

```ts
  let videoExitCode = 0;
  const internalForDub = internalSubtitleParamsFor(deliver);

  // --video-id 复用已有素材时，字幕生成/烧录不会像新采集那样搭在 prepareYoutubeVideo 里
  // 自动发生——必须自己触发一遍，否则非 dubbed 档位在这条路径下什么都不产出。dubbed 不需要：
  // dub 自己生成并烧录双语字幕，从不经过 executeNativeSubtitle/runSubtitlePipeline。
  if (!hasUrlSources && deliver !== "none" && !internalForDub.needsDub) {
    const subtitleSource: "auto" | "youtube" | "transcribe" | "local" | "file" =
      resolvedFrom === "local-words" || resolvedFrom === "auto" ? "auto" : resolvedFrom;
    for (const id of videoIds) {
      const code = await executeNativeSubtitle({
        outDir: outRoot,
        articleOutDir: articleOutRoot,
        videoId: id,
        subtitleZh: internalForDub.subtitleZh,
        subtitleBilingual: internalForDub.subtitleBilingual,
        subtitleSourceLang: "en",
        subtitleTargetLang: "zh-CN",
        subtitleSource,
        force: flags.force ?? false,
        ...(flags.subtitleFile !== undefined ? { subtitleFile: flags.subtitleFile } : {}),
        ...(flags.llmProvider !== undefined ? { llmProvider: flags.llmProvider } : {}),
        ...(flags.llmModel !== undefined ? { llmModel: flags.llmModel } : {}),
        ...(flags.llmBaseUrl !== undefined ? { llmBaseUrl: flags.llmBaseUrl } : {}),
      });
      if (code !== 0) {
        if ((flags.errorStrategy ?? "stop") === "stop") return code;
        videoExitCode = mergePipelineExitCode(videoExitCode, code);
      }
    }
  }

  if (internalForDub.needsDub) {
```

(Everything after this — the existing `needsDub` dub block and the final "done — continue with"
logging/return — stays exactly as-is; only the new block is inserted between the `videoIds`
computation and the existing dub block.)

`resolvedFrom` is already in scope at this point (computed near the top of the function, before the
`hasUrlSources`/`videoIds` branching) — this new block reuses it rather than recomputing anything.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/cli/src/orchestrator/native-video.test.ts`
Expected: PASS — all prior tests (from Plan 2) still pass unchanged, plus the 7 new cases from Step 1.

- [ ] **Step 5: Run `npx tsc -b`, lint, and full suite**

Run: `npx tsc -b && npx eslint packages/cli/src/orchestrator/native-video.ts packages/cli/src/orchestrator/native-video.test.ts && npx vitest run`
Expected: clean, no regressions (baseline going in: 1529 tests; expect 1536 after this task's 7 new
cases).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/orchestrator/native-video.ts packages/cli/src/orchestrator/native-video.test.ts
git commit -m "yt2x video: generate subtitles for --video-id-only non-dubbed deliveries"
```

---

## Completion check

```bash
npx tsc -b
npx eslint packages/cli/src/orchestrator/native-video.ts packages/cli/src/orchestrator/native-video.test.ts
npx vitest run
```

All green. At this point `yt2x video --video-id <id> --deliver zh-burned` (and every other non-dubbed
tier) actually generates/burns subtitles for an already-acquired video, closing the gap Plan 2's final
review recorded. `yt2x subtitle` can now be safely deleted in Plan 3b without losing this capability —
update Plan 3b's own precondition note (in
`docs/superpowers/plans/2026-08-04-video-text-commands.md`'s "What's next" section) to point at this
plan once both are done.
