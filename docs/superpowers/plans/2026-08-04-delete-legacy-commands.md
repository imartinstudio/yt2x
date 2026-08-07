# Delete Legacy Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete ADR-0005's cutover — delete `pipeline`, `acquire`, and the main `subtitle` command
(replacing each with a hidden `--help`-suppressed stub that prints a migration error), move `subtitle`'s
`audit`/`repair`/`transcribe-local` subcommands to a new `subtitle-tools` command, and migrate
`docs/USAGE.md` to the new `yt2x video`/`yt2x text` commands. This is "Plan 3b" of the ADR-0005/0006
rollout; Plans 1, 2, and 3a are already merged into this branch's history / PR #153. Plan 3a's
`--video-id`-only subtitle generation closed the one functional gap that made this deletion safe.

**Architecture:** A dependency-graph research pass (see the summary below) found that several files not
originally scoped for deletion secretly depend on files that ARE being deleted, and vice versa — the new
`yt2x video`/`yt2x text` commands quietly reuse two pieces of "pipeline" code (`hasVideoSources` and
`createCommandProgress`) that must survive. The plan is ordered to extract/prune those survivors FIRST
(Tasks 1-2, low-risk, additive-feeling even though they edit existing files), then do the actual
deletions (Tasks 3-4, the real cutover), then the docs migration (Task 5) last, once the command surface
it documents has actually landed.

**Research findings this plan is built on** (do not re-derive, trust these — verified by a dedicated
research pass against the actual current code):

- `orchestrator/native-video.ts` imports `hasVideoSources`/`VideoSourcesFieldsSchema` from
  `../args/pipeline.js` (deletion candidate) — must move to a surviving file first.
- `progress/pipeline-progress.ts` is NOT fully dead: `createCommandProgress` (plus the generic
  `formatProgressBar`, `PipelineProgressHandle` type, `buildPipelineTimingsPayload`,
  `PipelineTimingsPayload` type) is imported by `native-notes.ts`, `native-article.ts`,
  `native-publish.ts` — none of which are being deleted. Only the pipeline/acquire-specific exports
  (`estimatePipelineVideoCount`, `countPipelineProgressUnits`, `createPipelineProgress`,
  `createAcquireOnlyProgress`, `countAcquireSubSteps`, `acquireSubStepProgressFromHandle`, and the
  `"pipeline"`/`"acquire"` members of whatever `ProgressCommand` union type gates them) actually die.
- `commands/_shared.ts` is NOT on the deletion list (it's used by `article.ts`/`publish.ts`/`notes.ts`/
  `dub.ts`/the surviving half of `subtitle.ts` for `addCommonSourceOptions`/`addLlmOptions`), but its
  `runAcquireStage` function (and the acquire-only imports it alone needs — `PipelineArgs` type,
  `createAcquireOnlyProgress`, `acquireSubStepProgressFromHandle`, `estimatePipelineVideoCount`,
  `createAcquireReviewPrompt`, `nativeAcquireOptionsFromPipelineArgs`, `projectSingleStage`) must be
  surgically removed.
- Two files not originally on anyone's radar are already fully dead code today and should be deleted
  alongside this work: `args/single-stage.ts` (four Zod schemas, zero consumers anywhere) and
  `orchestrator/acquire-review-prompt.ts` (used only by `runAcquireStage`, which Task 2 removes).
- `orchestrator/index.ts` and `args/index.ts` are both orphaned barrel files with zero importers
  anywhere in the repo today — clean these up too, they're trivial and directly adjacent.
- `commands/subtitle.ts` needs a precise split, not a delete: `runSubtitle` + the main
  `program.command("subtitle")` registration dies; `executeSubtitleAudit`/`executeSubtitleRepair`/
  `executeSubtitleTranscribeLocal` + their Flags types + shared helpers (`firstExistingPath`,
  `sourceSrtCandidates`, `atomicWriteFile`, `summarizeIssues`) + the three subcommand registrations
  survive, moving into a new `subtitle-tools.ts`. The existing `subtitle.test.ts` only tests the
  surviving half (confirmed: zero test coverage of `runSubtitle`/main-command logic in that file today)
  — it moves wholesale to `subtitle-tools.test.ts`, not deleted.
- `command-flags.ts` (`SingleStageFlags`/`SingleStageTarget`) survives completely untouched —
  `NotesFlags`/`ArticleFlags`/`PublishFlags` all genuinely depend on it; `VideoFlags`/`TextFlags` never
  touched it in the first place (independently declared types).

## Global Constraints

- No backwards-compat shims beyond exactly what ADR-0005 specifies: a hidden (`{ hidden: true }`)
  stub command per deleted command, printing a migration error — nothing more elaborate.
- Run the full test suite after EVERY task, not just at the end — deletion tasks are exactly the kind
  of change where "tests still pass" is the only reliable signal that a hidden dependency wasn't missed,
  and catching a break early (one task back) is much cheaper than catching it after Task 4.
- Default to no comments; one line only when the WHY is non-obvious.
- Every task ends with `npx tsc -b`, `npx eslint <touched files>`, and a full `npx vitest run` clean.
- This plan intentionally does NOT touch `dub`/`dub-replay`/`clips`/`dashboard`/`llm`/`auth`/
  `watermark`/`wechat-format`/`deconstruct`/`info` — none of them are on ADR-0005's deletion list and
  none showed up as depending on anything this plan deletes (confirmed by the research pass).

---

### Task 1: Extract survivors from `args/pipeline.ts` and prune `progress/pipeline-progress.ts`

**Files:**

- Create: `packages/cli/src/args/video-sources.ts`
- Create: `packages/cli/src/args/video-sources.test.ts`
- Modify: `packages/cli/src/orchestrator/native-video.ts`
- Modify: `packages/cli/src/progress/pipeline-progress.ts`
- Modify: `packages/cli/src/progress/pipeline-progress.test.ts`

**Interfaces:**

- Produces: `VideoSourcesFieldsSchema`, `type VideoSourcesFields`, `hasVideoSources` (moved verbatim
  from `args/pipeline.ts`, same implementation, new home) from `args/video-sources.ts`.
- `progress/pipeline-progress.ts` keeps exporting `createCommandProgress`, `formatProgressBar`,
  `type PipelineProgressHandle`, `buildPipelineTimingsPayload`, `type PipelineTimingsPayload` — these
  are NOT new, just confirmed-surviving exports that must not be accidentally deleted in Task 4's
  broader cleanup.

- [ ] **Step 1: Write the failing test for the new file**

Create `packages/cli/src/args/video-sources.test.ts`. Read `packages/cli/src/args/pipeline.ts`'s
existing tests for `VideoSourcesFieldsSchema`/`hasVideoSources` in `packages/cli/src/args/pipeline.test.ts`
first (search that file for `hasVideoSources`/`VideoSourcesFieldsSchema`) — copy those exact test cases
verbatim into the new file (same assertions, same inputs), just pointing the import at `./video-sources.js`
instead of `./pipeline.js`. Do not invent new test cases; this is a pure relocation and the existing
tests are the correct, already-verified spec for this schema's behavior.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/src/args/video-sources.test.ts`
Expected: FAIL — `./video-sources.js` does not exist yet.

- [ ] **Step 3: Create `video-sources.ts`, moving the code verbatim**

Open `packages/cli/src/args/pipeline.ts` and find `VideoSourcesFieldsSchema`, `VideoSourcesFields`
(type), and `hasVideoSources` (they're defined together, near the top of the file, right after the
`SearchSortSchema` export). Copy them — the zod schema definition and the `hasVideoSources` function —
byte-for-byte into a new file `packages/cli/src/args/video-sources.ts` with only the imports it actually
needs (just `zod`). Do NOT move `VideoSourcesSchema` (the `.refine()`'d version) — the research pass
confirmed its only consumer (`args/single-stage.ts`) is itself dead code being deleted in Task 4, so it
has no reason to survive.

Do NOT delete these three from `args/pipeline.ts` yet in this task — Task 4 deletes the whole file at
once; leaving a temporary duplicate for one task's duration is fine and lower-risk than trying to
partially edit a file that's about to be deleted wholesale anyway.

- [ ] **Step 4: Update `native-video.ts`'s import**

Change:
```ts
import { hasVideoSources, VideoSourcesFieldsSchema } from "../args/pipeline.js";
```
to:
```ts
import { hasVideoSources, VideoSourcesFieldsSchema } from "../args/video-sources.js";
```
This is the only line in `native-video.ts` that needs to change.

- [ ] **Step 5: Run tests to verify the new file passes and native-video.ts still works**

Run: `npx vitest run packages/cli/src/args/video-sources.test.ts packages/cli/src/orchestrator/native-video.test.ts`
Expected: PASS — both green, `native-video.test.ts`'s existing cases unaffected since the schema's
behavior is byte-for-byte identical, just imported from a new path.

- [ ] **Step 6: Confirm `progress/pipeline-progress.ts`'s surviving exports (no code change, verification only)**

This step makes no edits — it's a checkpoint to confirm Task 1's premise before Task 4 relies on it.
Run:
```bash
grep -n "^export" packages/cli/src/progress/pipeline-progress.ts
```
Confirm `createCommandProgress`, `formatProgressBar`, `PipelineProgressHandle` (type),
`buildPipelineTimingsPayload`, `PipelineTimingsPayload` (type) are present among the exports. If the
actual file's exports differ meaningfully from this plan's description (e.g. different names), STOP and
report — Task 4's deletion instructions for the pipeline/acquire-only half of this file depend on this
list being accurate.

- [ ] **Step 7: Run `npx tsc -b`, lint, and full suite**

Run: `npx tsc -b && npx eslint packages/cli/src/args/video-sources.ts packages/cli/src/orchestrator/native-video.ts && npx vitest run`
Expected: clean, no regressions.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/args/video-sources.ts packages/cli/src/args/video-sources.test.ts packages/cli/src/orchestrator/native-video.ts
git commit -m "Extract hasVideoSources/VideoSourcesFieldsSchema out of args/pipeline.ts ahead of its deletion"
```

---

### Task 2: Prune `runAcquireStage` and its acquire-only imports out of `commands/_shared.ts`

**Files:**

- Modify: `packages/cli/src/commands/_shared.ts`
- Modify: `packages/cli/src/commands/acquire.ts` (still calls `runAcquireStage` until Task 4 deletes
  this file — no functional change in this task, `acquire` command keeps working exactly as before)

**Interfaces:** No public interface change — `runAcquireStage` keeps its exact current signature and
behavior in this task. This task only prepares `_shared.ts` for Task 4 by isolating what's acquire-only
so Task 4 can delete `_shared.ts`'s acquire-only content cleanly without touching the parts `article.ts`/
`publish.ts`/`notes.ts`/`dub.ts`/`subtitle-tools.ts` (Task 3) depend on.

This task has no code changes — it exists purely as a verification checkpoint, because the actual
removal of `runAcquireStage` happens in Task 4 (at the same time `acquire.ts` itself is deleted, since
`runAcquireStage` has no purpose once nothing calls it). Splitting the removal into its own task would
require either leaving `acquire.ts` calling a half-removed function (broken) or duplicating
`runAcquireStage`'s body temporarily — both worse than just verifying the boundary now and doing the
actual removal atomically in Task 4.

- [ ] **Step 1: Read `commands/_shared.ts` in full and confirm the exact boundary**

Read the file. Confirm: `addCommonSourceOptions` and `addLlmOptions` (the two Commander-option-adding
helper functions) do NOT reference `runAcquireStage` or any of its acquire-only imports
(`PipelineArgs` type, `createAcquireOnlyProgress`, `acquireSubStepProgressFromHandle`,
`estimatePipelineVideoCount`, `createAcquireReviewPrompt`, `nativeAcquireOptionsFromPipelineArgs`,
`projectSingleStage`) — they should be completely independent functions in the same file. If they are
NOT independent (e.g. `addCommonSourceOptions` internally calls something acquire-specific), STOP and
report — that would mean Task 4's planned deletion needs to change.

- [ ] **Step 2: Run the full suite as a baseline**

Run: `npx vitest run`
Expected: PASS, same count as the branch's current baseline (should be 1536, per Plan 3a's final
count — confirm via the test summary line, don't hardcode trust in this number if it's drifted).

- [ ] **Step 3: Commit nothing new (verification-only task) — but log the confirmed boundary**

No files change in this task. Append a note to this plan's execution ledger (the SDD workspace's
`progress.md`, not this file) confirming the boundary was verified as expected, or documenting what was
actually found if it differed. Mark this task complete without a commit.

---

### Task 3: Split `subtitle.ts` into a hidden stub + new `subtitle-tools` command

**Files:**

- Create: `packages/cli/src/commands/subtitle-tools.ts`
- Create: `packages/cli/src/commands/subtitle-tools.test.ts`
- Modify: `packages/cli/src/commands/subtitle.ts` (shrinks to just the hidden stub)
- Delete: `packages/cli/src/commands/subtitle.test.ts` (content moves wholesale to
  `subtitle-tools.test.ts` — confirmed by the research pass to only test the surviving half already)
- Modify: `packages/cli/src/index.ts`

**Interfaces:**

- Produces: `registerSubtitleToolsCommand(program: Command): void` (new, `subtitle-tools.ts`),
  `executeSubtitleAudit`, `executeSubtitleRepair`, `executeSubtitleTranscribeLocal` and their Flags
  types (moved verbatim from `subtitle.ts`, same implementations, new home).
- `registerSubtitleCommand(program: Command): void` (kept in `subtitle.ts`, but now registers only the
  hidden migration-error stub).

- [ ] **Step 1: Read `commands/subtitle.ts` and `commands/subtitle.test.ts` in full**

Confirm the exact line ranges for what moves (per this plan's "Architecture" section's research
summary): `SubtitleAuditFlags` type, `firstExistingPath`, `sourceSrtCandidates`, `atomicWriteFile`,
`summarizeIssues`, `executeSubtitleAudit`, `SubtitleRepairFlags` type, `executeSubtitleRepair`,
`SubtitleTranscribeLocalFlags` type, `executeSubtitleTranscribeLocal`, and the three
`cmd.command("audit"/"repair"/"transcribe-local")` registration blocks. If the actual current file
differs meaningfully from this description (new functions added since the research pass, etc.), work
from the real file — this plan's list is a checklist to verify against, not a substitute for reading the
actual code.

- [ ] **Step 2: Write the failing test — move `subtitle.test.ts` to `subtitle-tools.test.ts`**

`git mv packages/cli/src/commands/subtitle.test.ts packages/cli/src/commands/subtitle-tools.test.ts`,
then edit only its import line(s) to point at `./subtitle-tools.js` instead of `./subtitle.js` (the
function names being imported — `executeSubtitleAudit`, `executeSubtitleRepair`, etc. — don't change).
No other content in the test file should change; this is a pure relocation of already-passing tests.

- [ ] **Step 3: Run the moved test to verify it fails**

Run: `npx vitest run packages/cli/src/commands/subtitle-tools.test.ts`
Expected: FAIL — `./subtitle-tools.js` does not exist yet, so the import fails.

- [ ] **Step 4: Create `subtitle-tools.ts`**

Create `packages/cli/src/commands/subtitle-tools.ts` containing everything identified in Step 1 as
"survives" — copy each function/type/helper verbatim (same implementation, same logic, no behavior
change). Its imports should include everything those functions actually need (check each one — likely
`createHash` from `node:crypto`, `access`/`mkdir`/`readFile`/`rename`/`writeFile` from
`node:fs/promises`, `path`, the various `@yt2x/adapters-node` exports the research pass listed
(`auditSubtitleArtifacts`, `DEFAULT_OUT_DIR`, `defaultProcessRunner`, `isSubtitleAuditReadyForDelivery`,
`measureBilingualSubtitleLayout`, `repairSubtitleArtifacts`, `sanitizeVideoId`, `transcribeLocal`, plus
the `SubtitleAuditIssue`/`SubtitleAuditMeasurement` types), `type Command` from `commander`,
`addCommonSourceOptions`/`addLlmOptions` from `./_shared.js`, `resolveNativeLlm`/`type
NativeLlmCliFlags` from `../orchestrator/native-stage-common.js`, `logger` from `../logger.js`). Do NOT
import `DEFAULT_WATERMARK_SUBTITLER` — the research pass confirmed that constant is used only by the
dying main-command registration, not by audit/repair/transcribe-local.

At the bottom, add:
```ts
export const registerSubtitleToolsCommand = (program: Command): void => {
  const cmd = program
    .command("subtitle-tools")
    .description(
      "Diagnostic/single-step subtitle utilities: audit, repair, and local transcription. " +
        "For normal delivery use `yt2x video`.",
    );

  cmd
    .command("audit <videoId>")
    // ...exactly the same .option()/.action() chain currently attached to subtitle.ts's `cmd`,
    // unchanged in every detail...

  // ...same for "repair" and "transcribe-local"...
};
```
Copy each of the three subcommand registration blocks from `subtitle.ts` verbatim — same option
strings, same descriptions, same defaults, same action handlers — just re-parented onto this new `cmd`
(the `subtitle-tools` command object) instead of the old `subtitle` command object.

- [ ] **Step 5: Run the moved test to verify it passes**

Run: `npx vitest run packages/cli/src/commands/subtitle-tools.test.ts`
Expected: PASS — every case that passed before the move still passes, since nothing about the
functions' behavior changed, only their file location.

- [ ] **Step 6: Shrink `subtitle.ts` to a hidden migration stub**

Replace the ENTIRE contents of `packages/cli/src/commands/subtitle.ts` with:

```ts
import type { Command } from "commander";
import { logger } from "../logger.js";

/**
 * `subtitle` is retired (ADR-0005) — subtitle generation lives in `yt2x video`'s `--deliver`/`--from`
 * flags now; `audit`/`repair`/`transcribe-local` moved to `subtitle-tools`. Hidden from `--help`,
 * kept only so anyone still typing `yt2x subtitle` gets pointed at the replacement instead of
 * Commander's raw "unknown command" error.
 */
export const registerSubtitleCommand = (program: Command): void => {
  program
    .command("subtitle", { hidden: true })
    .description("Retired — see `yt2x video --help` and `yt2x subtitle-tools --help`.")
    .allowUnknownOption()
    .action(() => {
      logger.error(
        {},
        "`yt2x subtitle` has been replaced. Use `yt2x video --deliver <tier> --video-id <id>` " +
          "for subtitle generation/burning, or `yt2x subtitle-tools audit|repair|transcribe-local` " +
          "for the diagnostic subcommands.",
      );
      process.exitCode = 1;
    });
};
```

`.allowUnknownOption()` matters here: without it, Commander would reject any of the old
`--subtitle-zh`/`--video-id`/etc. flags a user might still be typing out of habit with an "unknown
option" parse error before the action handler ever runs, which would show a confusing Commander error
instead of this plan's intended migration message.

- [ ] **Step 7: Register `subtitle-tools` in `index.ts`**

In `packages/cli/src/index.ts`, add `import { registerSubtitleToolsCommand } from
"./commands/subtitle-tools.js";` and `registerSubtitleToolsCommand(program);` — additive, alongside the
existing (now-stubbed) `registerSubtitleCommand(program);` call, which stays exactly where it is.

- [ ] **Step 8: Write a small test confirming the stub behaves as intended**

Add a new, small test file `packages/cli/src/commands/subtitle.test.ts` (this is a fresh file — the old
one was renamed away in Step 2) covering just the stub:

```ts
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerSubtitleCommand } from "./subtitle.js";

describe("registerSubtitleCommand (retired stub)", () => {
  it("is hidden from --help", () => {
    const program = new Command();
    registerSubtitleCommand(program);
    const helpText = program.helpInformation();
    expect(helpText).not.toContain("subtitle ");
  });

  it("sets a non-zero exit code and logs a migration message when invoked", async () => {
    const program = new Command();
    program.exitOverride();
    registerSubtitleCommand(program);
    await program.parseAsync(["node", "yt2x", "subtitle"]);
    expect(process.exitCode).not.toBe(0);
    process.exitCode = 0; // reset for subsequent tests in the same process
  });
});
```

(If `program.parseAsync` with `exitOverride()` behaves differently than expected in this codebase's
existing Commander version/usage — check how any other command's test in this package invokes a command
end-to-end, if one exists, and follow that pattern instead of guessing.)

- [ ] **Step 9: Run `npx tsc -b`, lint, and full suite**

Run: `npx tsc -b && npx eslint packages/cli/src/commands/subtitle.ts packages/cli/src/commands/subtitle.test.ts packages/cli/src/commands/subtitle-tools.ts packages/cli/src/commands/subtitle-tools.test.ts packages/cli/src/index.ts && npx vitest run`
Expected: clean, no regressions.

- [ ] **Step 10: Commit**

```bash
git add packages/cli/src/commands/subtitle.ts packages/cli/src/commands/subtitle.test.ts \
  packages/cli/src/commands/subtitle-tools.ts packages/cli/src/commands/subtitle-tools.test.ts \
  packages/cli/src/index.ts
git commit -m "Split subtitle command: hidden migration stub + new subtitle-tools command"
```

---

### Task 4: Delete `pipeline`/`acquire` and all now-fully-dead supporting code

**Files:**

- Delete: `packages/cli/src/commands/pipeline.ts`, `packages/cli/src/commands/pipeline-run.ts`,
  `packages/cli/src/commands/pipeline-run.test.ts`
- Delete: `packages/cli/src/commands/acquire.ts`
- Delete: `packages/cli/src/commands/single-stage-projection.ts`,
  `packages/cli/src/commands/single-stage-projection.test.ts`
- Delete: `packages/cli/src/args/pipeline.ts`, `packages/cli/src/args/pipeline.test.ts`
- Delete: `packages/cli/src/args/commander-pipeline-flags.ts`,
  `packages/cli/src/args/commander-pipeline-flags.test.ts`
- Delete: `packages/cli/src/args/single-stage.ts` (confirmed dead code today, zero consumers)
- Delete: `packages/cli/src/orchestrator/native-pipeline.ts`,
  `packages/cli/src/orchestrator/native-pipeline.test.ts`
- Delete: `packages/cli/src/orchestrator/native-acquire-from-pipeline-args.ts`
- Delete: `packages/cli/src/orchestrator/acquire-review-prompt.ts` (dead once `runAcquireStage` is gone)
- Delete: `packages/cli/src/orchestrator/index.ts`, `packages/cli/src/args/index.ts` (confirmed orphaned
  barrels, zero importers anywhere, unrelated cleanup bundled in since they're directly adjacent)
- Modify: `packages/cli/src/commands/_shared.ts` (remove `runAcquireStage` + its acquire-only imports)
- Modify: `packages/cli/src/progress/pipeline-progress.ts`,
  `packages/cli/src/progress/pipeline-progress.test.ts` (remove pipeline/acquire-only exports, keep the
  survivors Task 1 verified)
- Modify: `packages/cli/src/index.ts` (replace `pipeline`/`acquire` registrations with hidden stubs)
- Create: none — the stub logic is small enough to inline directly in `index.ts` rather than
  warranting two more tiny files (unlike `subtitle`, which already had a natural home in
  `commands/subtitle.ts` to shrink into)

**Interfaces:** No new public interfaces. `runNativePipeline`, `mergePipelineExitCode` (re-export
chain), `runAcquireStage`, `projectSingleStage`, `nativeAcquireOptionsFromPipelineArgs`, and everything
in `args/pipeline.ts`/`args/single-stage.ts`/`args/commander-pipeline-flags.ts` cease to exist. Nothing
outside this deletion list references any of them after Task 1-3 landed (verified by the research pass;
re-verify with the greps in Step 1 before deleting, since new code may have landed since the plan was
written).

This is the highest-risk task in the plan — it's real, cascading deletion. Do every verification step;
do not skip ahead because a step "should" be fine.

- [ ] **Step 1: Re-verify the dependency graph is still accurate (do this before deleting anything)**

Run each of these and confirm the output matches what's expected (only files ALSO on this task's
deletion list should appear, plus each file's own `.test.ts`):

```bash
grep -rln "native-pipeline\.js" packages/cli/src --include="*.ts" | grep -v ".test.ts"
grep -rln "args/pipeline\.js" packages/cli/src --include="*.ts" | grep -v ".test.ts"
grep -rln "commander-pipeline-flags\.js" packages/cli/src --include="*.ts" | grep -v ".test.ts"
grep -rln "single-stage-projection\.js\|args/single-stage\.js" packages/cli/src --include="*.ts" | grep -v ".test.ts"
grep -rln "native-acquire-from-pipeline-args\.js\|acquire-review-prompt\.js" packages/cli/src --include="*.ts" | grep -v ".test.ts"
grep -rln "orchestrator/index\.js\|args/index\.js\|from \"\.\./orchestrator\"\|from \"\./orchestrator\"" packages/cli/src --include="*.ts"
```

If any of these turns up a file NOT on this task's deletion list (and not something Tasks 1-3 already
handled — e.g. `native-video.ts` should no longer appear for the `args/pipeline.js` grep, since Task 1
moved it off that import), STOP and report — do not proceed with deletion until the discrepancy is
understood. This is the single most important safety check in this entire plan.

- [ ] **Step 2: Prune `commands/_shared.ts`**

Remove `runAcquireStage` in its entirety, along with these now-unused imports:
`PipelineArgs` (type, from `../args/pipeline.js`), `createAcquireOnlyProgress`,
`acquireSubStepProgressFromHandle`, `estimatePipelineVideoCount` (from `../progress/pipeline-progress.js`),
`createAcquireReviewPrompt` (from `./acquire-review-prompt.js`),
`nativeAcquireOptionsFromPipelineArgs` (from `../orchestrator/native-acquire-from-pipeline-args.js`),
`projectSingleStage` (from `./single-stage-projection.js`). Also remove the `SingleStageFlags`/
`SingleStageTarget` re-export lines IF `runAcquireStage` was their only reason for being re-exported
here — check whether `acquire.ts` (being deleted) was the only consumer of that re-export, or whether
some other file imports `SingleStageFlags`/`SingleStageTarget` from `_shared.js` specifically (as
opposed to directly from `command-flags.js`); if any other file does, keep the re-export.

Keep `addCommonSourceOptions` and `addLlmOptions` completely unchanged — these are load-bearing for
`article.ts`, `publish.ts`, `notes.ts`, `dub.ts`, and `subtitle-tools.ts` (Task 3).

- [ ] **Step 3: Prune `progress/pipeline-progress.ts`**

Remove `estimatePipelineVideoCount`, `countPipelineProgressUnits`, `createPipelineProgress`,
`createAcquireOnlyProgress`, `countAcquireSubSteps`, `acquireSubStepProgressFromHandle`, and whatever
`"pipeline"`/`"acquire"` members exist on the file's progress-command union type (read the file first —
narrow the union type's remaining members to just what `notes`/`article`/`publish` need, most likely
just those three literal strings or a smaller shared type). Keep `createCommandProgress`,
`formatProgressBar`, `PipelineProgressHandle` (type), `buildPipelineTimingsPayload`,
`PipelineTimingsPayload` (type) completely unchanged.

Update `progress/pipeline-progress.test.ts` to remove test cases for the deleted exports, keeping test
cases for the survivors — read the current test file to know exactly which `describe`/`it` blocks
correspond to which export before deciding what to remove.

- [ ] **Step 4: Delete the files**

```bash
git rm packages/cli/src/commands/pipeline.ts \
  packages/cli/src/commands/pipeline-run.ts \
  packages/cli/src/commands/pipeline-run.test.ts \
  packages/cli/src/commands/acquire.ts \
  packages/cli/src/commands/single-stage-projection.ts \
  packages/cli/src/commands/single-stage-projection.test.ts \
  packages/cli/src/args/pipeline.ts \
  packages/cli/src/args/pipeline.test.ts \
  packages/cli/src/args/commander-pipeline-flags.ts \
  packages/cli/src/args/commander-pipeline-flags.test.ts \
  packages/cli/src/args/single-stage.ts \
  packages/cli/src/orchestrator/native-pipeline.ts \
  packages/cli/src/orchestrator/native-pipeline.test.ts \
  packages/cli/src/orchestrator/native-acquire-from-pipeline-args.ts \
  packages/cli/src/orchestrator/acquire-review-prompt.ts \
  packages/cli/src/orchestrator/index.ts \
  packages/cli/src/args/index.ts
```

(If `args/single-stage.test.ts` or `orchestrator/acquire-review-prompt.test.ts` exist, add them too —
check with `ls` first; the research pass didn't confirm their existence either way.)

- [ ] **Step 5: Replace `pipeline`/`acquire` registrations in `index.ts` with hidden stubs**

Remove the `import { registerPipelineCommand } from "./commands/pipeline.js";` and
`import { registerAcquireCommand } from "./commands/acquire.js";` lines (their source files are gone).
Replace the `registerPipelineCommand(program);` and `registerAcquireCommand(program);` call sites with
inline hidden-stub registrations, following the exact same pattern Task 3 used for `subtitle`:

```ts
program
  .command("pipeline", { hidden: true })
  .description("Retired — see `yt2x video --help` and `yt2x text --help`.")
  .allowUnknownOption()
  .action(() => {
    logger.error(
      {},
      "`yt2x pipeline` has been replaced by two commands: `yt2x video --deliver <tier> --urls <url>` " +
        "for the video side, then `yt2x text --video-id <id>` for notes/article. Run `yt2x video --help` " +
        "or `yt2x text --help`.",
    );
    process.exitCode = 1;
  });

program
  .command("acquire", { hidden: true })
  .description("Retired — see `yt2x video --help`.")
  .allowUnknownOption()
  .action(() => {
    logger.error(
      {},
      "`yt2x acquire` has been replaced by `yt2x video --deliver <tier> --urls <url>` " +
        "(or --video-id to reuse already-downloaded material). Run `yt2x video --help`.",
    );
    process.exitCode = 1;
  });
```

`index.ts` already imports `logger` for its own top-level error handling — reuse that same import, don't
add a second one.

- [ ] **Step 6: Add stub tests to `index.ts`'s test coverage**

Check whether `index.ts` currently has any test file at all (`packages/cli/src/index.test.ts` — search
for it). If one exists, add cases mirroring Task 3 Step 8's stub tests for both `pipeline` and `acquire`
(hidden from `--help`, non-zero exit + migration message on invocation). If `index.ts` has no existing
test file and no established pattern for testing command registration end-to-end at that level, do NOT
invent a new testing pattern for just this — the `subtitle.test.ts` stub tests from Task 3 already cover
the hidden-stub mechanism itself once; note this in your report rather than adding redundant coverage.

- [ ] **Step 7: Run `npx tsc -b`, lint, and full suite**

Run: `npx tsc -b && npx eslint packages/cli/src && npx vitest run`
Expected: clean. This is the step most likely to surface a missed dependency from Step 1's
verification — if `tsc -b` fails, do not silence the error; trace it back to a file this task deleted
and figure out what still needed it (a real gap in the research pass, or something that changed since).

- [ ] **Step 8: Commit**

```bash
git add -A packages/cli/src
git commit -m "Delete pipeline/acquire commands and now-dead supporting code (ADR-0005)"
```

(Using `git add -A` scoped to `packages/cli/src` here, not the whole repo, is safe and necessary — this
task both deletes files (`git rm` already staged those) and modifies others; a plain `git add <paths>`
listing every touched file individually would be extremely long and error-prone for a task this size.)

---

### Task 5: Migrate `docs/USAGE.md` and `docs/DATA-CONTRACTS.md`

**Files:**

- Modify: `docs/USAGE.md`
- Modify: `docs/DATA-CONTRACTS.md`

**Interfaces:** None — documentation only.

This task is lower-risk than Tasks 1-4 (no code, no test suite to break) but larger in raw editing
volume — 11 distinct locations across 9 sections of `USAGE.md` reference `yt2x pipeline`/`yt2x acquire`
(confirmed by the research pass at these approximate line numbers, which may have shifted slightly from
Tasks 1-4's own doc touches if any — re-locate each by searching for the literal strings, don't trust
hardcoded line numbers blindly):

- `## 环境要求` (prose mention)
- `### 可选 Python 依赖` (table row: `yt2x pipeline --dub`)
- `## 常用命令` (two example command rows)
- `### 视频来源参数` (multiple `--help`/usage examples)
- `### 采集参数` (prose + code examples)
- `### 语义双语字幕` (code + prose)
- `#### pipeline 中的视频下载组合` (an entire subsection titled after the dying command — needs
  retitling, not just content edits)
- `#### YouTube 人机验证 / 登录态` (code examples)
- `## X 发布` (code examples)
- `## 内容质量 warning` (prose)
- `## 续跑与批次队列` (prose: `--continue-from`, a flag that no longer exists on any command — this
  whole section's premise may need rethinking, not just a find-replace)

- [ ] **Step 1: Read `docs/USAGE.md` in full**

Read the entire file front to back before editing anything — several of the sections above interrelate
(e.g. "pipeline 中的视频下载组合" and "语义双语字幕" both describe video-clip/subtitle flag
combinations that now live on `yt2x video` with different flag names per Plan 2's `commands/video.ts`
registration — check that file's actual current option list rather than assuming old flag names carry
over unchanged).

- [ ] **Step 2: For each `yt2x pipeline`/`yt2x acquire` example, translate to the new command**

Use these mappings (verified against Plan 2's actual `commands/video.ts`/`commands/text.ts` option
lists — re-check those files for the current exact flag names before writing any replacement example,
since this plan doesn't re-derive them here):

- `yt2x pipeline --urls <url> --acquire auto --notes auto --article auto --publish skip` style examples
  → split into `yt2x video --urls <url> --deliver <appropriate tier>` followed by
  `yt2x text --video-id <id> --notes auto --article auto`. Choose the `--deliver` tier per what the
  original example's `--subtitle-zh`/`--subtitle-bilingual`/`--dub` flags were doing (map old flag
  combinations to the six-tier enum using `CONTEXT.md`'s "交付物" table as the reference).
- `yt2x acquire --video-only ...` style examples → `yt2x video --deliver none --video-only ...` (check
  `commands/video.ts` actually still has `--video-only` — Plan 2's registration listed it; confirm it
  wasn't dropped).
- `yt2x pipeline --continue-from` (the "续跑与批次队列" section) — neither `yt2x video` nor `yt2x text`
  has an equivalent flag (confirmed: not in either command's option list per Plan 2). Do not invent one.
  Rewrite this section's prose to accurately describe the new reality — likely "batch retry" now means
  re-running `yt2x video`/`yt2x text` with the same `--video-id`/`--urls` and relying on each command's
  own idempotent skip-if-already-done behavior (confirm this is actually true by checking
  `executeNativeAcquire`'s and `executeNativeNotes`'s/`executeNativeArticle`'s skip-if-done logic — if
  it's NOT true, i.e. there's a real capability gap, say so explicitly in the doc and flag it in this
  task's report rather than writing documentation that overclaims).
- `#### pipeline 中的视频下载组合` — retitle to something like `#### yt2x video 中的视频下载组合`.

- [ ] **Step 3: Update `docs/DATA-CONTRACTS.md`'s `yt2x subtitle transcribe-local` mention**

Change to `yt2x subtitle-tools transcribe-local` (the research pass found exactly one occurrence, at
line 111 — re-locate by searching, don't trust the line number blindly).

- [ ] **Step 4: Proofread against the actual current CLI**

For every rewritten example, actually run the command it describes with `--help` (e.g.
`npx tsx packages/cli/src/index.ts video --help`) and confirm every flag named in the doc example is a
real, currently-registered option — this file has a history of drifting from the real CLI (that's
largely why this migration is needed in the first place), don't let the rewrite reintroduce the same
problem on day one.

- [ ] **Step 5: Commit**

```bash
git add docs/USAGE.md docs/DATA-CONTRACTS.md
git commit -m "docs: migrate USAGE.md/DATA-CONTRACTS.md from pipeline/acquire/subtitle to yt2x video/text"
```

---

## Completion check

```bash
npx tsc -b
npx eslint packages/cli/src
npx vitest run
npx tsx packages/cli/src/index.ts --help    # confirm pipeline/acquire/subtitle are absent from the list
npx tsx packages/cli/src/index.ts pipeline  # confirm the hidden stub fires with a clear message
npx tsx packages/cli/src/index.ts subtitle-tools --help  # confirm the new command is visible and complete
```

All green. ADR-0005's command-tree split is now fully live: `yt2x video`/`yt2x text` are the only
delivery entry points, `dub`/`dub-replay`/`subtitle-tools` remain as diagnostic single-step commands,
and `pipeline`/`acquire`/`subtitle` exist only as hidden migration stubs. `docs/USAGE.md` describes the
current command surface.
