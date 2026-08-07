# Video/Text Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new, additive top-level commands — `yt2x video` (acquire → subtitle → dub, driven by
`--deliver`/`--from`) and `yt2x text` (notes → article) — without touching or removing `pipeline`,
`acquire`, or `subtitle`. This is Plan 2 of ADR-0005/0006's rollout; Plan 1
(`docs/superpowers/plans/2026-08-04-video-delivery-foundations.md`, merged) built the demucs/TTS
default-detection fixes and the standalone `--deliver`/`--from` validation core
(`packages/core/src/domain/pipeline/delivery.ts`) this plan wires in. **Plan 3 (not yet written)**
does the actual cutover: delete `pipeline`/`acquire`/`subtitle`, delete `single-stage-projection.ts`,
add hidden migration-error stubs, move `subtitle`'s `audit`/`repair`/`transcribe-local` into
`subtitle-tools`, update `docs/USAGE.md`'s old→new command table. Nothing in this plan is safe to skip
before Plan 3 — Plan 3 depends on `yt2x video`/`yt2x text` existing and being correct.

**Architecture:** Task 1 extracts the `--dub` preflight/auto-backfill logic already proven in
`native-pipeline.ts` into a standalone, directly-testable function, so both the old `pipeline --dub`
and the new `yt2x video --deliver dubbed` can call the same code without duplicating it. Task 2 extends
Plan 1's `delivery.ts` with the one piece deliberately deferred from Plan 1: a pure mapping from the
six `DeliverMode` values to the internal `subtitleZh`/`subtitleBilingual` flags the existing (untouched)
`executeNativeAcquire`/`runSubtitlePipeline` machinery already understands. Tasks 3 and 4 are new
orchestrator+command pairs, following the existing `commands/*.ts` (Commander registration) +
`orchestrator/native-*.ts` (`executeNativeX(flags): Promise<number>`) split used by every other command
in this codebase (`dub.ts`/`native-dub.ts`, `notes.ts`/`native-notes.ts`, etc.). Both reuse existing,
untouched adapters-node functions (`executeNativeAcquire`, `executeNativeDub`, `executeNativeNotes`,
`executeNativeArticle`) — no changes to `packages/adapters-node` in this plan.

## Global Constraints

- TDD: failing test first, then minimal implementation, for every task.
- Default to no comments; one line only when the WHY is non-obvious.
- No backwards-compat shims, no feature flags — these are pure additions; `pipeline`/`acquire`/
  `subtitle` are untouched and keep working exactly as before.
- New identifiers must match CONTEXT.md/ADR vocabulary: `--deliver`, `--from`, the six delivery-tier
  strings, the five channel strings — copy them verbatim from `packages/core/src/domain/pipeline/delivery.ts`
  (Plan 1), never re-type them by hand.
- `yt2x text` does **not** include a publish stage or a deconstruct stage (human partner's explicit
  decision when this plan was scoped) — `publish` and `deconstruct` remain separate commands, unaffected
  by this plan.
- Every task ends with `npx tsc -b`, `npx eslint <touched files>`, and a full `npx vitest run` clean.

---

### Task 1: Extract `ensureDubPreflight` from `native-pipeline.ts`

**Files:**

- Create: `packages/cli/src/orchestrator/dub-preflight.ts`
- Create: `packages/cli/src/orchestrator/dub-preflight.test.ts`
- Modify: `packages/cli/src/orchestrator/native-pipeline.ts`

**Interfaces:**

- Produces: `ensureDubPreflight(input: EnsureDubPreflightInput): Promise<EnsureDubPreflightResult>`,
  `allVideosAlreadyDubbed(articleOutRoot: string, ids: readonly string[]): Promise<boolean>` (both
  exported for Task 3 and for `native-pipeline.test.ts`'s existing black-box coverage to keep working
  unchanged).
- `EnsureDubPreflightResult = { ok: true } | { ok: false; exitCode: number }`.

This is a pure refactor: the exact same checks in the exact same order, just callable standalone. The
existing `packages/cli/src/orchestrator/native-pipeline.test.ts` suite exercises this logic today
end-to-end through `runNativePipeline` (search it for `"fails fast before notes/article/transcription
when demucs is unavailable"`, `"fails fast before notes/article when local transcription is
unavailable"`, `"exits 0 without running the demucs/TTS preflight when every target video is already
dubbed"`, and neighboring cases) — **do not change that file**; if this refactor is behavior-preserving,
those tests keep passing without modification, and that is your regression signal.

- [ ] **Step 1: Write the failing test for the new standalone function**

Create `packages/cli/src/orchestrator/dub-preflight.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeLocalMock = vi.hoisted(() =>
  vi.fn(async () => ({
    srtPath: "video/full.local.en.srt",
    wordsPath: "video/full.local.en.words.json",
    cueCount: 1,
  })),
);
const probeDemucsMock = vi.hoisted(() => vi.fn(async () => "/usr/bin/python3"));

vi.mock("@yt2x/adapters-node", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    transcribeLocal: transcribeLocalMock,
    probeDemucs: probeDemucsMock,
  };
});

import { allVideosAlreadyDubbed, ensureDubPreflight } from "./dub-preflight.js";

beforeEach(() => {
  transcribeLocalMock.mockClear();
  transcribeLocalMock.mockResolvedValue({
    srtPath: "video/full.local.en.srt",
    wordsPath: "video/full.local.en.words.json",
    cueCount: 1,
  });
  probeDemucsMock.mockClear();
  probeDemucsMock.mockResolvedValue("/usr/bin/python3");
});

describe("allVideosAlreadyDubbed", () => {
  it("returns false for an empty video list", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-empty-"));
    await expect(allVideosAlreadyDubbed(root, [])).resolves.toBe(false);
  });

  it("returns true only when every id has full.zh-dubbed.mp4", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-alldubbed-"));
    await mkdir(path.join(root, "vid1", "video"), { recursive: true });
    await writeFile(path.join(root, "vid1", "video", "full.zh-dubbed.mp4"), "x");
    await mkdir(path.join(root, "vid2", "video"), { recursive: true });
    await expect(allVideosAlreadyDubbed(root, ["vid1", "vid2"])).resolves.toBe(false);
    await writeFile(path.join(root, "vid2", "video", "full.zh-dubbed.mp4"), "x");
    await expect(allVideosAlreadyDubbed(root, ["vid1", "vid2"])).resolves.toBe(true);
  });
});

describe("ensureDubPreflight", () => {
  it("skips engine/TTS/demucs checks when every target video is already dubbed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-skip-"));
    const outRoot = path.join(root, "downloads");
    const articleOutRoot = path.join(root, "articles");
    await mkdir(path.join(articleOutRoot, "vid1", "video"), { recursive: true });
    await writeFile(path.join(articleOutRoot, "vid1", "video", "full.zh-dubbed.mp4"), "x");

    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot,
      articleOutRoot,
      dubEngineFlag: "edge-tts",
    });

    expect(result).toEqual({ ok: true });
    expect(probeDemucsMock).not.toHaveBeenCalled();
    expect(transcribeLocalMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid --dub-engine before touching demucs/transcription", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-bad-engine-"));
    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot: path.join(root, "downloads"),
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "not-a-real-engine",
    });
    expect(result).toEqual({ ok: false, exitCode: expect.any(Number) });
    expect(probeDemucsMock).not.toHaveBeenCalled();
  });

  it("returns ok:false with CONFIG_MISSING when demucs is unavailable", async () => {
    probeDemucsMock.mockRejectedValueOnce(
      Object.assign(new Error("demucs not found"), { name: "DemucsError" }),
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-no-demucs-"));
    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot: path.join(root, "downloads"),
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "edge-tts",
    });
    expect(result.ok).toBe(false);
    expect(transcribeLocalMock).not.toHaveBeenCalled();
  });

  it("transcribes videos that have no local word-level transcript yet", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-transcribe-"));
    const outRoot = path.join(root, "downloads");
    await mkdir(path.join(outRoot, "vid1"), { recursive: true });

    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot,
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "edge-tts",
    });

    expect(result).toEqual({ ok: true });
    expect(transcribeLocalMock).toHaveBeenCalledOnce();
    expect(transcribeLocalMock.mock.calls[0]![0]).toMatchObject({
      videoDir: path.join(outRoot, "vid1"),
      language: "en",
    });
  });

  it("skips transcription for videos that already have a local word-level transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-has-words-"));
    const outRoot = path.join(root, "downloads");
    await mkdir(path.join(outRoot, "vid1", "video"), { recursive: true });
    await writeFile(
      path.join(outRoot, "vid1", "video", "full.local.en.words.json"),
      JSON.stringify([{ word: "hi", start: 0, end: 0.2 }]),
    );

    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot,
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "edge-tts",
    });

    expect(result).toEqual({ ok: true });
    expect(transcribeLocalMock).not.toHaveBeenCalled();
  });

  it("returns ok:false with CONFIG_MISSING when local transcription is unavailable", async () => {
    transcribeLocalMock.mockResolvedValueOnce(undefined);
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-transcribe-fail-"));
    const outRoot = path.join(root, "downloads");
    await mkdir(path.join(outRoot, "vid1"), { recursive: true });

    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot,
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "edge-tts",
    });

    expect(result.ok).toBe(false);
  });

  it("passes an explicit pythonPath through to probeDemucs unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-python-path-"));
    await ensureDubPreflight({
      videoIds: [],
      outRoot: path.join(root, "downloads"),
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "edge-tts",
      pythonPath: "/explicit/python3",
    });
    expect(probeDemucsMock).toHaveBeenCalledWith(
      expect.objectContaining({ pythonPath: "/explicit/python3" }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/src/orchestrator/dub-preflight.test.ts`
Expected: FAIL — `./dub-preflight.js` does not exist.

- [ ] **Step 3: Create `dub-preflight.ts`, moving the logic verbatim**

The source of truth for every line below is `packages/cli/src/orchestrator/native-pipeline.ts`'s
current `hasDubbedVideo`/`allVideosAlreadyDubbed` helpers (top of file) and its `if (dubRequested) {...}`
preflight block inside `runNativePipeline` (the block that starts with the comment "配音只存在于本地
转录通道" and ends right before `const notesForId = ...`). Open that file and copy the logic exactly —
do not re-derive it from scratch, and do not change any log message wording (existing consumers may
grep for them).

```ts
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  defaultProcessRunner,
  dubbedVideoPathFor,
  probeDemucs,
  resolveDubWordsPath,
  transcribeLocal,
  type ProcessRunner,
} from "@yt2x/adapters-node";
import { logger } from "../logger.js";
import { resolveDubEngine, resolveDubTts, type DubFlags } from "./native-dub.js";
import { NATIVE_EXIT } from "./native-stage-common.js";

const hasDubbedVideo = async (articleOutRoot: string, id: string): Promise<boolean> =>
  access(dubbedVideoPathFor(articleOutRoot, id))
    .then(() => true)
    .catch(() => false);

/** 每个目标视频都已有 full.zh-dubbed.mp4 时，preflight（凭据/Demucs 探测）没有必要再跑。 */
export const allVideosAlreadyDubbed = async (
  articleOutRoot: string,
  ids: readonly string[],
): Promise<boolean> => {
  if (ids.length === 0) return false;
  for (const id of ids) {
    if (!(await hasDubbedVideo(articleOutRoot, id))) return false;
  }
  return true;
};

export type EnsureDubPreflightInput = {
  videoIds: readonly string[];
  outRoot: string;
  articleOutRoot: string;
  dubEngineFlag: string | undefined;
  force?: boolean;
  pythonPath?: string;
  runner?: ProcessRunner;
};

export type EnsureDubPreflightResult = { ok: true } | { ok: false; exitCode: number };

/**
 * 三件事按顺序 fail fast：dub 引擎/TTS 凭据校验、demucs 探测、逐视频本地词级转录自动补跑——
 * 全部放在调用方昂贵阶段（LLM notes/article）之前，理由见 native-pipeline.ts 里同一段逻辑
 * 原来的注释。抽出来是为了让 `yt2x video --deliver dubbed` 复用同一套检查，不必复制一遍。
 */
export const ensureDubPreflight = async (
  input: EnsureDubPreflightInput,
): Promise<EnsureDubPreflightResult> => {
  const skip =
    input.force !== true && (await allVideosAlreadyDubbed(input.articleOutRoot, input.videoIds));
  if (skip) {
    logger.info(
      { videos: input.videoIds.length },
      "yt2x dub preflight: all target videos already have a dubbed output — " +
        "skipping demucs/TTS preflight (use --force to redo)",
    );
    return { ok: true };
  }

  let dubEngine;
  try {
    dubEngine = resolveDubEngine(input.dubEngineFlag);
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "yt2x dub preflight: invalid --dub-engine",
    );
    return { ok: false, exitCode: NATIVE_EXIT.CONFIG_MISSING };
  }

  const resolvedTts = resolveDubTts(
    { dubEngine: input.dubEngineFlag } as DubFlags,
    dubEngine,
  );
  if (!resolvedTts.ok) {
    logger.error(
      { reason: resolvedTts.reason },
      "yt2x dub preflight: TTS credentials unavailable — checked before notes/article " +
        "so a missing ElevenLabs key doesn't waste an already-paid-for translation pass",
    );
    return { ok: false, exitCode: resolvedTts.exitCode };
  }

  try {
    const resolvedPythonPath = await probeDemucs({
      ...(input.pythonPath !== undefined ? { pythonPath: input.pythonPath } : {}),
    });
    logger.info(
      { pythonPath: resolvedPythonPath },
      "yt2x dub preflight: resolved python interpreter for demucs",
    );
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "yt2x dub preflight: demucs unavailable — install demucs, or pass --python-path " +
        "to a Python that has it (e.g. `--python-path .venv-demucs/bin/python3`); checked " +
        "before notes/article to avoid wasted LLM cost",
    );
    return { ok: false, exitCode: NATIVE_EXIT.CONFIG_MISSING };
  }

  for (const id of input.videoIds) {
    const alreadyTranscribed = await resolveDubWordsPath({ outRoot: input.outRoot, videoId: id })
      .then(() => true)
      .catch(() => false);
    if (alreadyTranscribed) continue;

    logger.info({ videoId: id }, "yt2x dub preflight: no local transcript found, transcribing now…");
    const result = await transcribeLocal({
      videoDir: path.join(input.outRoot, id),
      language: "en",
      runner: input.runner ?? defaultProcessRunner,
    });
    if (result === undefined) {
      logger.error(
        { videoId: id },
        "yt2x dub preflight: local transcription unavailable (faster-whisper not installed, " +
          "or no downloaded source video found). Install faster-whisper, or run " +
          "`yt2x subtitle transcribe-local <videoId>` manually, then retry.",
      );
      return { ok: false, exitCode: NATIVE_EXIT.CONFIG_MISSING };
    }
    logger.info(
      { videoId: id, wordsPath: result.wordsPath, cueCount: result.cueCount },
      "yt2x dub preflight: local transcript ready",
    );
  }

  return { ok: true };
};
```

`DubFlags` needs to be an exported type from `native-dub.ts` (check whether it already is — if not,
add `export` to its existing type declaration; do not duplicate the type).

Note the unused `mkdir` import above — remove it, it was left over from drafting; the real file needs
only `access` from `node:fs/promises`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/cli/src/orchestrator/dub-preflight.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Refactor `native-pipeline.ts` to call the extracted function**

Delete `hasDubbedVideo` and `allVideosAlreadyDubbed` from `native-pipeline.ts` (they now live in
`dub-preflight.ts`). Replace the entire `if (dubRequested) { ... }` preflight block (the one that
currently spans from the `skipDubPreflight` check through the per-video transcription loop, ending
right before `const notesForId = ...`) with:

```ts
    if (dubRequested) {
      const preflight = await ensureDubPreflight({
        videoIds,
        outRoot,
        articleOutRoot,
        dubEngineFlag: args.control.dubEngine,
        force: args.control.force,
        ...(args.control.pythonPath !== undefined ? { pythonPath: args.control.pythonPath } : {}),
        ...(runner !== undefined ? { runner } : {}),
      });
      if (!preflight.ok) {
        finalExitCode = preflight.exitCode;
        return finalExitCode;
      }
    }
```

Add `import { ensureDubPreflight } from "./dub-preflight.js";` near the other local orchestrator
imports. Remove `probeDemucs`, `dubbedVideoPathFor`, `resolveDubWordsPath`, `transcribeLocal` from the
`@yt2x/adapters-node` import block at the top of the file — after this refactor none of them are
referenced anywhere else in `native-pipeline.ts` (confirm with a grep before removing; if any is still
used elsewhere in the file, keep it). Remove `resolveDubEngine, resolveDubTts` from the
`./native-dub.js` import for the same reason.

- [ ] **Step 6: Run the full regression suite**

Run: `npx vitest run packages/cli/src/orchestrator/native-pipeline.test.ts packages/cli/src/orchestrator/dub-preflight.test.ts`
Expected: PASS — every existing `native-pipeline.test.ts` case (including the dub-preflight-specific
ones) still passes unchanged, proving the refactor preserved behavior.

- [ ] **Step 7: Run `npx tsc -b` and full suite**

Run: `npx tsc -b && npx vitest run`
Expected: clean, no regressions.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/orchestrator/dub-preflight.ts \
  packages/cli/src/orchestrator/dub-preflight.test.ts \
  packages/cli/src/orchestrator/native-pipeline.ts \
  packages/cli/src/orchestrator/native-dub.ts
git commit -m "Extract dub preflight/auto-backfill logic into a standalone, reusable function"
```

---

### Task 2: `internalSubtitleParamsFor` — map `DeliverMode` to the existing internal subtitle flags

**Files:**

- Modify: `packages/core/src/domain/pipeline/delivery.ts`
- Modify: `packages/core/src/domain/pipeline/delivery.test.ts`

**Interfaces:**

- Produces: `internalSubtitleParamsFor(deliver: DeliverMode): InternalSubtitleParams`,
  `type InternalSubtitleParams = { subtitleZh: "off" | "srt" | "burned"; subtitleBilingual: "off" | "srt" | "burned"; needsDub: boolean }`.
- Consumed by Task 3 to build `NativeAcquireOptions.acquire.subtitleZh`/`subtitleBilingual`.

**Design note (why each mapping is what it is — keep this as a comment above the function, it is the
non-obvious part):**

`zh-only` burn and `bilingual` burn must never both fire for the same run — a real bug found and fixed
earlier in this codebase's history (Plan 1's `CONTEXT.md` transcribe-channel work referenced it):
`prepareSourceSubtitle`/`runSubtitlePipeline`'s zh-only burn writes `full.zh-burned.mp4` and the
bilingual burn writes `full.bilingual-burned.mp4` as two *separate* files, and whichever runs second
silently overwrites the delivery-tracking `manifest.burned_video` field, orphaning the other's (real,
disk-consuming) encode. Every `bilingual-*` tier below therefore sets `subtitleZh: "off"` — this does
**not** skip Chinese subtitle generation (translation to `full.zh.srt` happens whenever bilingual mode
isn't `"off"`, independent of `subtitleZh`, per `video-subtitles.ts`'s `!hasZhSrt` guard), it only skips
the *zh-only burn side effect*. `dubbed` sets both to `"off"` because dub owns its own translation and
burn entirely (`executeNativeDub` never calls `runSubtitlePipeline`) — feeding it `subtitleZh`/
`subtitleBilingual` values would be pure waste (acquire would burn a video dub is about to overwrite).

```ts
export type InternalSubtitleParams = {
  subtitleZh: "off" | "srt" | "burned";
  subtitleBilingual: "off" | "srt" | "burned";
  needsDub: boolean;
};

export const internalSubtitleParamsFor = (deliver: DeliverMode): InternalSubtitleParams => {
  switch (deliver) {
    case "none":
      return { subtitleZh: "off", subtitleBilingual: "off", needsDub: false };
    case "zh-srt":
      return { subtitleZh: "srt", subtitleBilingual: "off", needsDub: false };
    case "zh-burned":
      return { subtitleZh: "burned", subtitleBilingual: "off", needsDub: false };
    case "bilingual-srt":
      return { subtitleZh: "off", subtitleBilingual: "srt", needsDub: false };
    case "bilingual-burned":
      return { subtitleZh: "off", subtitleBilingual: "burned", needsDub: false };
    case "dubbed":
      return { subtitleZh: "off", subtitleBilingual: "off", needsDub: true };
  }
};
```

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/domain/pipeline/delivery.test.ts`:

```ts
import { internalSubtitleParamsFor } from "./delivery.js"; // add to the existing top import

describe("internalSubtitleParamsFor", () => {
  it("maps none to no subtitle work and no dub", () => {
    expect(internalSubtitleParamsFor("none")).toEqual({
      subtitleZh: "off",
      subtitleBilingual: "off",
      needsDub: false,
    });
  });

  it("maps zh-srt to a plain zh srt, no burn, no bilingual", () => {
    expect(internalSubtitleParamsFor("zh-srt")).toEqual({
      subtitleZh: "srt",
      subtitleBilingual: "off",
      needsDub: false,
    });
  });

  it("maps zh-burned to a zh-only burn, no bilingual", () => {
    expect(internalSubtitleParamsFor("zh-burned")).toEqual({
      subtitleZh: "burned",
      subtitleBilingual: "off",
      needsDub: false,
    });
  });

  it("maps bilingual-srt to bilingual srt with subtitleZh off (avoids the zh-only burn side effect)", () => {
    expect(internalSubtitleParamsFor("bilingual-srt")).toEqual({
      subtitleZh: "off",
      subtitleBilingual: "srt",
      needsDub: false,
    });
  });

  it("maps bilingual-burned to bilingual burn with subtitleZh off", () => {
    expect(internalSubtitleParamsFor("bilingual-burned")).toEqual({
      subtitleZh: "off",
      subtitleBilingual: "burned",
      needsDub: false,
    });
  });

  it("maps dubbed to no acquire-side subtitle work at all, needsDub true", () => {
    expect(internalSubtitleParamsFor("dubbed")).toEqual({
      subtitleZh: "off",
      subtitleBilingual: "off",
      needsDub: true,
    });
  });

  it("covers all six DeliverMode values exhaustively (compile-time + runtime cross-check)", () => {
    const allModes: DeliverMode[] = ["none", "zh-srt", "zh-burned", "bilingual-srt", "bilingual-burned", "dubbed"];
    for (const mode of allModes) {
      expect(() => internalSubtitleParamsFor(mode)).not.toThrow();
    }
  });
});
```

(Add `DeliverMode` to the existing type-only import from `./delivery.js` at the top of the test file if
not already imported.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/domain/pipeline/delivery.test.ts`
Expected: FAIL — `internalSubtitleParamsFor` is not exported.

- [ ] **Step 3: Add the function and type to `delivery.ts`**

Append the `InternalSubtitleParams` type, the design-note comment, and the `internalSubtitleParamsFor`
function shown above to the end of `packages/core/src/domain/pipeline/delivery.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/domain/pipeline/delivery.test.ts`
Expected: PASS, 20 cases (13 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/domain/pipeline/delivery.ts packages/core/src/domain/pipeline/delivery.test.ts
git commit -m "Add internalSubtitleParamsFor: DeliverMode → existing acquire subtitle flags"
```

---

### Task 3: `yt2x video` command

**Files:**

- Create: `packages/cli/src/orchestrator/native-video.ts`
- Create: `packages/cli/src/orchestrator/native-video.test.ts`
- Create: `packages/cli/src/commands/video.ts`
- Modify: `packages/cli/src/index.ts`

**Interfaces:**

- Consumes: `DeliverModeSchema`, `FromModeSchema`, `resolveFrom`, `assertFromCompatibleWithDeliver`,
  `DeliveryConflictError`, `internalSubtitleParamsFor`, `type DeliverMode`, `type FromMode` (all from
  `@yt2x/core`, Plan 1 + Task 2); `ensureDubPreflight` (Task 1, `./dub-preflight.js`);
  `executeNativeAcquire`, `collectNativePipelineVideoIds`, `extractVideoId`, `defaultProcessRunner`,
  `type NativeAcquireOptions` (all existing, `@yt2x/adapters-node`); `executeNativeDub`
  (existing, `./native-dub.js`); `hasVideoSources`, `VideoSourcesFieldsSchema` (existing,
  `../args/pipeline.js`); `defaultMonorepoRoot` (existing, `../config/monorepo-root.js`);
  `resolveNativeLlm`, `NATIVE_EXIT` (existing, `./native-stage-common.js`).
- Produces: `type VideoFlags`, `executeNativeVideo(flags: VideoFlags): Promise<number>` (consumed by
  `commands/video.ts`'s action handler, and by Task 4 for the end-of-run `yt2x text` suggestion — no,
  Task 4 does not import this; the suggestion print lives entirely inside this task, see Step 5).

**Design reference:** `packages/cli/src/orchestrator/native-pipeline.ts`'s acquire stage (the block from
`nativeAcquireOptionsFromPipelineArgs` through the post-acquire `videoIds` re-derivation, roughly its
lines 390–465) is the proven reference for exactly which `NativeAcquireOptions` fields to populate and
how to re-derive `videoIds` after acquire succeeds. Read it before writing this task's Step 3 — the code
below already follows it, but if `executeNativeAcquire`'s input shape has changed since this plan was
written, that file is the authority, not this one.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/orchestrator/native-video.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeNativeAcquireMock = vi.hoisted(() =>
  vi.fn(async (opts: { outDir: string }) => {
    const videoId = "abc123def45";
    await mkdir(path.join(opts.outDir, videoId), { recursive: true });
    await writeFile(path.join(opts.outDir, videoId, "metadata.json"), JSON.stringify({ id: videoId }));
    return 0;
  }),
);
vi.mock("@yt2x/adapters-node", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, executeNativeAcquire: executeNativeAcquireMock };
});

const executeNativeDubMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./native-dub.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, executeNativeDub: executeNativeDubMock };
});

const ensureDubPreflightMock = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));
vi.mock("./dub-preflight.js", () => ({ ensureDubPreflight: ensureDubPreflightMock }));

import { executeNativeVideo } from "./native-video.js";

beforeEach(() => {
  executeNativeAcquireMock.mockClear();
  executeNativeDubMock.mockClear();
  ensureDubPreflightMock.mockClear();
  ensureDubPreflightMock.mockResolvedValue({ ok: true });
});

describe("executeNativeVideo — --deliver validation", () => {
  it("rejects a missing --deliver before doing any work", async () => {
    const code = await executeNativeVideo({ urls: ["https://www.youtube.com/watch?v=abc123def45"] });
    expect(code).not.toBe(0);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid --deliver value", async () => {
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "not-a-real-tier",
    });
    expect(code).not.toBe(0);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });

  it("rejects --deliver dubbed --from youtube with a descriptive error, before acquiring anything", async () => {
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "dubbed",
      from: "youtube",
    });
    expect(code).not.toBe(0);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });

  it("rejects when neither --urls/--url-file/--search nor --video-id is given", async () => {
    const code = await executeNativeVideo({ deliver: "none" });
    expect(code).not.toBe(0);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });
});

describe("executeNativeVideo — acquire wiring", () => {
  it("maps --deliver bilingual-burned to subtitleZh off / subtitleBilingual burned in the acquire call", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-bilingual-"));
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "bilingual-burned",
      outDir: outRoot,
      llmProvider: "openai",
    });
    expect(code).toBe(0);
    expect(executeNativeAcquireMock).toHaveBeenCalledOnce();
    const acquireOpts = executeNativeAcquireMock.mock.calls[0]![0] as {
      acquire: { subtitleZh?: string; subtitleBilingual?: string };
    };
    expect(acquireOpts.acquire.subtitleZh).toBe("off");
    expect(acquireOpts.acquire.subtitleBilingual).toBe("burned");
    expect(ensureDubPreflightMock).not.toHaveBeenCalled();
    expect(executeNativeDubMock).not.toHaveBeenCalled();
  });

  it("skips acquire entirely when --video-id is given without --urls", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-skip-acquire-"));
    await mkdir(path.join(outRoot, "existingVid1"), { recursive: true });
    await writeFile(path.join(outRoot, "existingVid1", "metadata.json"), JSON.stringify({ id: "existingVid1" }));

    const code = await executeNativeVideo({
      videoId: ["existingVid1"],
      deliver: "zh-srt",
      outDir: outRoot,
      llmProvider: "openai",
    });
    expect(code).toBe(0);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });
});

describe("executeNativeVideo — dub wiring", () => {
  it("runs the dub preflight and per-video dub for --deliver dubbed, resolving --from to local-words", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-dubbed-"));
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "dubbed",
      outDir: outRoot,
      llmProvider: "openai",
    });
    expect(code).toBe(0);
    expect(executeNativeAcquireMock).toHaveBeenCalledOnce();
    const acquireOpts = executeNativeAcquireMock.mock.calls[0]![0] as {
      acquire: { subtitleZh?: string; subtitleBilingual?: string };
    };
    expect(acquireOpts.acquire.subtitleZh).toBe("off");
    expect(acquireOpts.acquire.subtitleBilingual).toBe("off");
    expect(ensureDubPreflightMock).toHaveBeenCalledOnce();
    expect(executeNativeDubMock).toHaveBeenCalledOnce();
    expect(executeNativeDubMock.mock.calls[0]![0]).toMatchObject({ videoId: "abc123def45" });
  });

  it("returns the preflight's exit code and never calls executeNativeDub when preflight fails", async () => {
    ensureDubPreflightMock.mockResolvedValueOnce({ ok: false, exitCode: 4 });
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-dubbed-preflight-fail-"));
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "dubbed",
      outDir: outRoot,
      llmProvider: "openai",
    });
    expect(code).toBe(4);
    expect(executeNativeDubMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/src/orchestrator/native-video.test.ts`
Expected: FAIL — `./native-video.js` does not exist.

- [ ] **Step 3: Implement `native-video.ts`**

```ts
import { access } from "node:fs/promises";
import path from "node:path";
import {
  collectNativePipelineVideoIds,
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_OUT_DIR,
  defaultProcessRunner,
  executeNativeAcquire,
  extractVideoId,
  type ProcessRunner,
} from "@yt2x/adapters-node";
import {
  DeliverModeSchema,
  DeliveryConflictError,
  FromModeSchema,
  internalSubtitleParamsFor,
  resolveFrom,
  type DeliverMode,
  type FromMode,
} from "@yt2x/core";
import { hasVideoSources, VideoSourcesFieldsSchema } from "../args/pipeline.js";
import { defaultMonorepoRoot } from "../config/monorepo-root.js";
import { logger } from "../logger.js";
import { ensureDubPreflight } from "./dub-preflight.js";
import { executeNativeDub } from "./native-dub.js";
import { NATIVE_EXIT, resolveNativeLlm } from "./native-stage-common.js";

export type VideoFlags = {
  urls?: string[];
  urlFile?: string;
  search?: string;
  searchSort?: string;
  videoId?: string[];
  outDir?: string;
  articleOutDir?: string;
  deliver?: string;
  from?: string;
  subtitleFile?: string;
  keyframes?: string;
  jobs?: string;
  subLangs?: string;
  sceneThreshold?: string;
  sceneMinGap?: string;
  maxWords?: string;
  cookiesFromBrowser?: string;
  proxy?: string;
  downloadVideo?: boolean;
  videoOnly?: boolean;
  videoStart?: string;
  videoEnd?: string;
  videoDuration?: string;
  dubEngine?: string;
  pythonPath?: string;
  errorStrategy?: string;
  force?: boolean;
  llmProvider?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  verbose?: boolean;
  runner?: ProcessRunner;
};

const hasMetadata = async (outRoot: string, id: string): Promise<boolean> =>
  access(path.join(outRoot, id, "metadata.json"))
    .then(() => true)
    .catch(() => false);

const filterMaterializedVideoIds = async (
  outRoot: string,
  ids: readonly string[],
): Promise<string[]> => {
  const materialized: string[] = [];
  for (const id of ids) if (await hasMetadata(outRoot, id)) materialized.push(id);
  return materialized;
};

const sourceVideoIdsFromUrls = (urls: readonly string[]): string[] => {
  const ids = urls.map((url) => extractVideoId(url));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
};

export const executeNativeVideo = async (flags: VideoFlags): Promise<number> => {
  if (flags.deliver === undefined) {
    logger.error({}, "--deliver is required. See CONTEXT.md「交付物」for the six values.");
    return NATIVE_EXIT.CONFIG_MISSING;
  }
  let deliver: DeliverMode;
  try {
    deliver = DeliverModeSchema.parse(flags.deliver);
  } catch {
    logger.error(
      { deliver: flags.deliver },
      "Invalid --deliver value. See CONTEXT.md「交付物」for the six values.",
    );
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  let explicitFrom: FromMode | undefined;
  if (flags.from !== undefined) {
    try {
      explicitFrom = FromModeSchema.parse(flags.from);
    } catch {
      logger.error(
        { from: flags.from },
        "Invalid --from value. See CONTEXT.md「字幕通道」for the five values.",
      );
      return NATIVE_EXIT.CONFIG_MISSING;
    }
  }

  let resolvedFrom;
  try {
    resolvedFrom = resolveFrom(deliver, explicitFrom);
  } catch (err: unknown) {
    if (err instanceof DeliveryConflictError) {
      logger.error({ deliver, from: flags.from }, err.message);
      return NATIVE_EXIT.CONFIG_MISSING;
    }
    throw err;
  }

  const sourcesInput = {
    urls: flags.urls ?? [],
    urlFile: flags.urlFile,
    search: flags.search,
    searchSort: flags.searchSort,
  };
  const hasUrlSources = hasVideoSources(VideoSourcesFieldsSchema.parse(sourcesInput));
  const explicitVideoIds = flags.videoId ?? [];
  if (!hasUrlSources && explicitVideoIds.length === 0) {
    logger.error(
      {},
      "yt2x video needs --urls/--url-file/--search (to acquire), or --video-id " +
        "(to reuse already-acquired material).",
    );
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  const monorepoRoot = defaultMonorepoRoot();
  const outRoot =
    flags.outDir !== undefined ? path.resolve(flags.outDir) : path.resolve(monorepoRoot, DEFAULT_OUT_DIR);
  const articleOutRoot =
    flags.articleOutDir !== undefined
      ? path.resolve(flags.articleOutDir)
      : path.resolve(monorepoRoot, DEFAULT_ARTICLE_OUT_DIR);

  let videoIds: string[];
  if (hasUrlSources) {
    const internal = internalSubtitleParamsFor(deliver);
    const subtitleSource: "auto" | "youtube" | "transcribe" | "local" | "file" =
      resolvedFrom === "local-words" || resolvedFrom === "auto" ? "auto" : resolvedFrom;

    const needsTranslation = internal.subtitleZh !== "off" || internal.subtitleBilingual !== "off";
    let llmResult: ReturnType<typeof resolveNativeLlm> | undefined;
    if (needsTranslation) {
      llmResult = resolveNativeLlm({
        llmProvider: flags.llmProvider,
        ...(flags.llmModel !== undefined ? { llmModel: flags.llmModel } : {}),
        ...(flags.llmBaseUrl !== undefined ? { llmBaseUrl: flags.llmBaseUrl } : {}),
      } as Parameters<typeof resolveNativeLlm>[0]);
      if (!llmResult.ok) {
        logger.error({ reason: llmResult.reason }, "LLM config missing for subtitle translation");
        return llmResult.exitCode;
      }
    }

    const acquireCode = await executeNativeAcquire({
      monorepoRoot,
      outDir: outRoot,
      articleOutDir: articleOutRoot,
      sources: sourcesInput,
      acquire: {
        keyframes: Number(flags.keyframes ?? "0"),
        jobs: Number(flags.jobs ?? "3"),
        sceneThreshold: Number(flags.sceneThreshold ?? "0.35"),
        sceneMinGap: Number(flags.sceneMinGap ?? "12"),
        maxWords: Number(flags.maxWords ?? "900"),
        downloadVideo: flags.downloadVideo ?? true,
        videoOnly: flags.videoOnly ?? false,
        videoDuration: Number(flags.videoDuration ?? "30"),
        subtitleZh: internal.subtitleZh,
        subtitleSourceLang: "en",
        subtitleTargetLang: "zh-CN",
        subtitleSource,
        subtitleBilingual: internal.subtitleBilingual,
        ...(flags.subLangs !== undefined ? { subLangs: flags.subLangs } : {}),
        ...(flags.cookiesFromBrowser !== undefined ? { cookiesFromBrowser: flags.cookiesFromBrowser } : {}),
        ...(flags.proxy !== undefined ? { proxy: flags.proxy } : {}),
        ...(flags.videoStart !== undefined ? { videoStart: flags.videoStart } : {}),
        ...(flags.videoEnd !== undefined ? { videoEnd: flags.videoEnd } : {}),
        ...(flags.subtitleFile !== undefined ? { subtitleFile: flags.subtitleFile } : {}),
      },
      stages: { acquire: "auto", notes: "skip", article: "skip", publish: "skip" },
      control: {
        continueFlag: false,
        errorStrategy: (flags.errorStrategy as "stop" | "skip") ?? "stop",
        force: flags.force ?? false,
      },
      flags: { verbose: flags.verbose ?? false },
      ...(llmResult?.ok === true ? { llm: llmResult.adapter, llmModel: llmResult.model } : {}),
      ...(flags.runner !== undefined ? { runner: flags.runner } : {}),
    });
    if (acquireCode !== 0) {
      logger.error({ outRoot, exitCode: acquireCode }, "yt2x video: acquire failed");
      return acquireCode;
    }

    const allVideoIdsAfterAcquire = await collectNativePipelineVideoIds(outRoot);
    const sourceIds = sourceVideoIdsFromUrls(sourcesInput.urls);
    videoIds =
      sourceIds.length > 0
        ? allVideoIdsAfterAcquire.filter((id) => sourceIds.includes(id))
        : allVideoIdsAfterAcquire;
    videoIds = await filterMaterializedVideoIds(outRoot, videoIds);
    if (videoIds.length === 0) {
      logger.error({ outRoot }, "No videos with metadata.json found after acquire.");
      return 1;
    }
  } else {
    videoIds = await filterMaterializedVideoIds(outRoot, explicitVideoIds);
    if (videoIds.length !== explicitVideoIds.length) {
      logger.error(
        { outRoot, missing: explicitVideoIds.filter((id) => !videoIds.includes(id)) },
        "Some --video-id values have no metadata.json under --out-dir.",
      );
      return 1;
    }
  }

  const internalForDub = internalSubtitleParamsFor(deliver);
  if (internalForDub.needsDub) {
    const preflight = await ensureDubPreflight({
      videoIds,
      outRoot,
      articleOutRoot,
      dubEngineFlag: flags.dubEngine,
      force: flags.force,
      ...(flags.pythonPath !== undefined ? { pythonPath: flags.pythonPath } : {}),
      ...(flags.runner !== undefined ? { runner: flags.runner } : {}),
    });
    if (!preflight.ok) return preflight.exitCode;

    for (const id of videoIds) {
      const code = await executeNativeDub({
        videoId: id,
        outDir: outRoot,
        articleOutDir: articleOutRoot,
        ...(flags.dubEngine !== undefined ? { dubEngine: flags.dubEngine } : {}),
        force: flags.force ?? false,
        ...(flags.llmProvider !== undefined ? { llmProvider: flags.llmProvider } : {}),
        ...(flags.llmModel !== undefined ? { llmModel: flags.llmModel } : {}),
        ...(flags.llmBaseUrl !== undefined ? { llmBaseUrl: flags.llmBaseUrl } : {}),
        ...(flags.pythonPath !== undefined ? { pythonPath: flags.pythonPath } : {}),
      });
      if (code !== 0) {
        if ((flags.errorStrategy ?? "stop") === "stop") return code;
      }
    }
  }

  for (const id of videoIds) {
    logger.info(
      { videoId: id },
      `yt2x video: done — continue with: yt2x text --video-id ${id} --out-dir ${outRoot} --article-out-dir ${articleOutRoot}`,
    );
  }
  return 0;
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/cli/src/orchestrator/native-video.test.ts`
Expected: PASS. Fix any field-name mismatches against the real `NativeAcquireOptions` type
(`packages/adapters-node/src/acquire/execute-native-acquire.ts`) as they surface — the type checker will
catch drift from this plan's sketch.

- [ ] **Step 5: Register the command**

Create `packages/cli/src/commands/video.ts`:

```ts
import type { Command } from "commander";
import { defaultCliLlmProvider } from "../config/env.js";
import { executeNativeVideo, type VideoFlags } from "../orchestrator/native-video.js";

export const registerVideoCommand = (program: Command): void => {
  program
    .command("video")
    .description(
      "Deliver one video artifact: download → transcribe → subtitle → dub. " +
        "Choose exactly one --deliver tier.",
    )
    .option("--urls <url...>", "One or more YouTube URLs")
    .option("--url-file <path>", "Text file with one URL per line")
    .option("--search <query>", 'YouTube search, optionally "query:N"')
    .option("--search-sort <mode>", 'With --search: order before taking N (only "views")')
    .option("--video-id <id...>", "Skip download, operate on already-acquired video(s)")
    .option("--out-dir <path>", "Output root directory")
    .option("--article-out-dir <path>", "Article/burned-video output root directory")
    .requiredOption(
      "--deliver <tier>",
      "What to produce: none|zh-srt|zh-burned|bilingual-srt|bilingual-burned|dubbed",
    )
    .option(
      "--from <channel>",
      "Subtitle source channel override: youtube|transcribe|local|local-words|file " +
        "(default: auto-detect; dubbed defaults to local-words)",
    )
    .option("--subtitle-file <path>", "Existing SRT/VTT subtitle file when --from file")
    .option("--keyframes <n>", "Scene-detection keyframes (0 to skip)", "0")
    .option("--jobs <n>", "Parallel download jobs", "3")
    .option("--sub-langs <lang>", "Subtitle language override")
    .option("--scene-threshold <n>", "Scene detection threshold", "0.35")
    .option("--scene-min-gap <n>", "Scene minimum gap (seconds)", "12")
    .option("--max-words <n>", "Max words per transcript chunk", "900")
    .option("--cookies-from-browser <name>", "yt-dlp browser cookies")
    .option("--proxy <url>", "yt-dlp proxy")
    .option("--no-download-video", "Skip default video download")
    .option("--video-only", "Only download the video clip, skip subtitle/transcript work")
    .option("--video-start <time>", "Video clip start time (seconds, MM:SS, or HH:MM:SS)")
    .option("--video-end <time>", "Video clip end time")
    .option("--video-duration <seconds>", "Manual clip duration when --video-start omits --video-end", "30")
    .option("--dub-engine <id>", "With --deliver dubbed: TTS engine edge-tts (default) | elevenlabs")
    .option("--python-path <path>", "With --deliver dubbed: Python with demucs installed (auto-detected)")
    .option("--error-strategy <mode>", "On failure with multiple videos: stop|skip", "stop")
    .option("--force", "Overwrite existing output")
    .option("--llm-provider <id>", "LLM provider: openai|anthropic|deepseek|moonshot", defaultCliLlmProvider())
    .option("--llm-model <name>", "Override LLM model")
    .option("--llm-base-url <url>", "Override LLM base URL")
    .option("--verbose", "Detailed logging")
    .action(async (flags: VideoFlags) => {
      process.exitCode = await executeNativeVideo(flags);
    });
};
```

In `packages/cli/src/index.ts`, add `import { registerVideoCommand } from "./commands/video.js";` and
`registerVideoCommand(program);` — additive, alongside the existing `registerPipelineCommand`/
`registerAcquireCommand`/`registerSubtitleCommand` calls (do not remove or reorder those).

- [ ] **Step 6: Run `npx tsc -b`, lint, and full suite**

Run: `npx tsc -b && npx eslint packages/cli/src/orchestrator/native-video.ts packages/cli/src/orchestrator/native-video.test.ts packages/cli/src/commands/video.ts packages/cli/src/index.ts && npx vitest run`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/orchestrator/native-video.ts \
  packages/cli/src/orchestrator/native-video.test.ts \
  packages/cli/src/commands/video.ts \
  packages/cli/src/index.ts
git commit -m "Add yt2x video command (--deliver/--from, additive alongside pipeline/acquire/subtitle)"
```

---

### Task 4: `yt2x text` command

**Files:**

- Create: `packages/cli/src/orchestrator/native-text.ts`
- Create: `packages/cli/src/orchestrator/native-text.test.ts`
- Create: `packages/cli/src/commands/text.ts`
- Modify: `packages/cli/src/index.ts`

**Interfaces:**

- Consumes: `executeNativeNotes` (existing, `./native-notes.js`), `executeNativeArticle` (existing,
  `./native-article.js`), `NATIVE_EXIT` (existing, `./native-stage-common.js`).
- Produces: `type TextFlags`, `executeNativeText(flags: TextFlags): Promise<number>`.

No publish stage, no deconstruct stage — confirmed scope decision for this plan. `--video-id <id...>`
is required (no `--all`, no `--urls`; `yt2x video` is always the thing that acquires material — `yt2x
text` only ever operates on already-acquired video-ids, matching ADR-0005's "两条命令由 shell 串接").

**Design reference:** `native-pipeline.ts`'s `notesForId`/`articleForId` closures and its
`if (args.stages.notes !== "skip") {...}` / `if (args.stages.article !== "skip") {...}` blocks (its
lines roughly 579–651) are the proven reference for exactly which fields `executeNativeNotes`/
`executeNativeArticle` need and how failures propagate. Read them before writing Step 3.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/orchestrator/native-text.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeNativeNotesMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./native-notes.js", () => ({ executeNativeNotes: executeNativeNotesMock }));

const executeNativeArticleMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./native-article.js", () => ({ executeNativeArticle: executeNativeArticleMock }));

import { executeNativeText } from "./native-text.js";

beforeEach(() => {
  executeNativeNotesMock.mockClear();
  executeNativeArticleMock.mockClear();
});

describe("executeNativeText", () => {
  it("requires --video-id", async () => {
    const code = await executeNativeText({});
    expect(code).not.toBe(0);
    expect(executeNativeNotesMock).not.toHaveBeenCalled();
  });

  it("runs notes then article for each video id, in order", async () => {
    const code = await executeNativeText({ videoId: ["vidA", "vidB"], llmProvider: "openai" });
    expect(code).toBe(0);
    expect(executeNativeNotesMock).toHaveBeenCalledTimes(2);
    expect(executeNativeArticleMock).toHaveBeenCalledTimes(2);
    expect(executeNativeNotesMock.mock.invocationCallOrder[0]).toBeLessThan(
      executeNativeArticleMock.mock.invocationCallOrder[0]!,
    );
  });

  it("skips article when --article skip is passed", async () => {
    const code = await executeNativeText({ videoId: ["vidA"], article: "skip", llmProvider: "openai" });
    expect(code).toBe(0);
    expect(executeNativeNotesMock).toHaveBeenCalledOnce();
    expect(executeNativeArticleMock).not.toHaveBeenCalled();
  });

  it("skips notes when --notes skip is passed", async () => {
    const code = await executeNativeText({ videoId: ["vidA"], notes: "skip", llmProvider: "openai" });
    expect(code).toBe(0);
    expect(executeNativeNotesMock).not.toHaveBeenCalled();
    expect(executeNativeArticleMock).toHaveBeenCalledOnce();
  });

  it("stops at the first non-zero exit code and does not run article", async () => {
    executeNativeNotesMock.mockResolvedValueOnce(3);
    const code = await executeNativeText({ videoId: ["vidA"], llmProvider: "openai" });
    expect(code).toBe(3);
    expect(executeNativeArticleMock).not.toHaveBeenCalled();
  });

  it("passes --platform-targets through to the article stage", async () => {
    await executeNativeText({
      videoId: ["vidA"],
      llmProvider: "openai",
      platformTargets: "xiaohongshu,wechat",
    });
    expect(executeNativeArticleMock.mock.calls[0]![0]).toMatchObject({
      platformTargets: "xiaohongshu,wechat",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/src/orchestrator/native-text.test.ts`
Expected: FAIL — `./native-text.js` does not exist.

- [ ] **Step 3: Implement `native-text.ts`**

```ts
import { logger } from "../logger.js";
import { executeNativeArticle } from "./native-article.js";
import { executeNativeNotes } from "./native-notes.js";
import { NATIVE_EXIT } from "./native-stage-common.js";

export type TextFlags = {
  videoId?: string[];
  outDir?: string;
  articleOutDir?: string;
  notes?: string;
  article?: string;
  platform?: string;
  maxChars?: string;
  rewriteMode?: string;
  targets?: string;
  platformTargets?: string;
  errorStrategy?: string;
  force?: boolean;
  llmProvider?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  verbose?: boolean;
};

export const executeNativeText = async (flags: TextFlags): Promise<number> => {
  const videoIds = flags.videoId ?? [];
  if (videoIds.length === 0) {
    logger.error({}, "--video-id is required. Usage: yt2x text --video-id <id...>");
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  const notesMode = flags.notes ?? "auto";
  const articleMode = flags.article ?? "auto";
  const errorStrategy = (flags.errorStrategy as "stop" | "skip" | undefined) ?? "stop";

  const notesForId = (id: string) =>
    ({
      outDir: flags.outDir,
      llmProvider: flags.llmProvider,
      ...(flags.llmModel !== undefined ? { llmModel: flags.llmModel } : {}),
      ...(flags.llmBaseUrl !== undefined ? { llmBaseUrl: flags.llmBaseUrl } : {}),
      errorStrategy,
      verbose: flags.verbose ?? false,
      force: flags.force ?? false,
      showProgress: false,
      videoId: [id],
    }) as Parameters<typeof executeNativeNotes>[0];

  const articleForId = (id: string) =>
    ({
      ...notesForId(id),
      articleOutDir: flags.articleOutDir,
      platform: flags.platform ?? "x",
      maxChars: flags.maxChars ?? "280",
      rewriteMode: flags.rewriteMode ?? "rules",
      targets: flags.targets,
      platformTargets: flags.platformTargets,
    }) as Parameters<typeof executeNativeArticle>[0];

  if (notesMode !== "skip") {
    for (const id of videoIds) {
      const code = await executeNativeNotes(notesForId(id));
      if (code !== 0 && errorStrategy === "stop") return code;
    }
  }

  if (articleMode !== "skip") {
    for (const id of videoIds) {
      const code = await executeNativeArticle(articleForId(id));
      if (code !== 0 && errorStrategy === "stop") return code;
    }
  }

  return 0;
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/cli/src/orchestrator/native-text.test.ts`
Expected: PASS. Reconcile any field mismatches against `NotesFlags`/`ArticleFlags`
(`native-notes.ts`/`native-article.ts`) — those types are the authority for exact field names.

- [ ] **Step 5: Register the command**

Create `packages/cli/src/commands/text.ts`:

```ts
import type { Command } from "commander";
import { defaultCliLlmProvider } from "../config/env.js";
import { executeNativeText, type TextFlags } from "../orchestrator/native-text.js";

export const registerTextCommand = (program: Command): void => {
  program
    .command("text")
    .description("Deliver one text artifact from an already-acquired video: notes → article.")
    .requiredOption("--video-id <id...>", "Already-acquired video id(s) — run `yt2x video` first")
    .option("--out-dir <path>", "Downloaded source root")
    .option("--article-out-dir <path>", "Article output root directory")
    .option("--notes <mode>", "Stage mode: auto|review|skip", "auto")
    .option("--article <mode>", "Stage mode: auto|review|skip", "auto")
    .option("--platform <name>", "Target platform (x|wechat|newsletter|...)", "x")
    .option("--max-chars <n>", "Article stage: hint max chars (legacy)", "280")
    .option("--targets <targets>", "Article output targets: article,x-thread,x-short,all")
    .option("--platform-targets <targets>", "Platform adaptations: xiaohongshu,wechat,bilibili,all-platforms")
    .option("--rewrite-mode <mode>", "Article rewrite strategy: rules|llm", "rules")
    .option("--error-strategy <mode>", "On failure with multiple videos: stop|skip", "stop")
    .option("--force", "Overwrite existing structured-notes.md")
    .option("--llm-provider <id>", "LLM provider: openai|anthropic|deepseek|moonshot", defaultCliLlmProvider())
    .option("--llm-model <name>", "Override LLM model")
    .option("--llm-base-url <url>", "Override LLM base URL")
    .option("--verbose", "Detailed logging")
    .action(async (flags: TextFlags) => {
      process.exitCode = await executeNativeText(flags);
    });
};
```

In `packages/cli/src/index.ts`, add `import { registerTextCommand } from "./commands/text.js";` and
`registerTextCommand(program);` — additive, alongside every existing registration.

- [ ] **Step 6: Run `npx tsc -b`, lint, and full suite**

Run: `npx tsc -b && npx eslint packages/cli/src/orchestrator/native-text.ts packages/cli/src/orchestrator/native-text.test.ts packages/cli/src/commands/text.ts packages/cli/src/index.ts && npx vitest run`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/orchestrator/native-text.ts \
  packages/cli/src/orchestrator/native-text.test.ts \
  packages/cli/src/commands/text.ts \
  packages/cli/src/index.ts
git commit -m "Add yt2x text command (notes → article, additive alongside notes/article)"
```

---

## Completion check

```bash
npx tsc -b
npx eslint packages/cli/src packages/core/src/domain/pipeline
npx vitest run
```

All green, no new warnings. At this point `yt2x video --deliver <tier> --urls <url>` and
`yt2x text --video-id <id>` both work end-to-end alongside the still-fully-functional `pipeline`/
`acquire`/`subtitle`/`notes`/`article` — nothing old was removed. That removal, plus the
`docs/USAGE.md` migration table, is Plan 3.

## What's next (Plan 3, not written)

- Delete `pipeline`, `acquire`, the main `subtitle` command; replace with hidden `--help`-suppressed
  stubs that print a migration error pointing at `yt2x video`/`yt2x text` (ADR-0005 Decision #2).
- Delete `single-stage-projection.ts` and its test (only `_shared.ts`'s `runAcquireStage` + `acquire.ts`
  depend on it — confirmed in this plan's research phase).
- Move `subtitle`'s `audit`/`repair`/`transcribe-local` subcommands into a new `subtitle-tools` command
  (ADR-0005 Decision #4) — `yt2x video`'s error messages already reference
  `yt2x subtitle-tools transcribe-local`... no, they reference the *current* `yt2x subtitle
  transcribe-local` (see Plan 1's Task 4 fix) — Plan 3 must update those strings once the rename lands.
- `docs/USAGE.md`: full old→new command migration table (ADR-0005 Consequence: "现有命令行模板全部
  失效，需要一次性迁移").
- Decide whether `command-flags.ts`'s `SingleStageFlags` type survives as a shared base for
  `NotesFlags`/`ArticleFlags`/`PublishFlags`, or gets split now that `acquire` (its original reason for
  existing) is gone.
- **Precondition surfaced by Plan 2's final review:** `yt2x video --deliver <non-dubbed tier>
  --video-id <already-acquired id>` is currently a silent no-op — the skip-acquire path only does real
  work for `--deliver dubbed`; every other tier just validates the video exists and returns 0 without
  generating or re-burning any subtitles. This is fine today because `yt2x subtitle` still exists as the
  way to (re)generate subtitles for an already-acquired video. Once Plan 3 deletes `yt2x subtitle`,
  this becomes a real functionality gap — `yt2x video` must gain a real "generate/burn subtitles for an
  already-acquired video" path before (or as part of) that deletion, not after.
