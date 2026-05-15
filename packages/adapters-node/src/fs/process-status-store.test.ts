import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROCESS_STATUS_FILE,
  PROCESS_STATUS_JOURNAL,
  isStepDone,
  markStepDone,
  patchProcessStatus,
  patchStepRunning,
  readProcessStatusMerged,
} from "./process-status-store.js";

let videoDir: string;
const identity = () => ({ videoId: "vid1", url: "https://www.youtube.com/watch?v=vid1" });

beforeEach(async () => {
  videoDir = await mkdtemp(path.join(tmpdir(), "yt2x-pstat-"));
});

afterEach(async () => {
  await rm(videoDir, { recursive: true, force: true });
});

describe("patchProcessStatus", () => {
  it("creates process-status.json with done step", async () => {
    const id = identity();
    await patchProcessStatus(videoDir, id, {
      step: "notes",
      stepInfo: {
        status: "done",
        finishedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 12,
        artifacts: ["structured-notes.md"],
      },
    });
    const raw = await readFile(path.join(videoDir, PROCESS_STATUS_FILE), "utf8");
    const doc = JSON.parse(raw) as { steps: { notes: { status: string } } };
    expect(doc.steps.notes.status).toBe("done");
    const journal = await readFile(path.join(videoDir, PROCESS_STATUS_JOURNAL), "utf8").catch(() => "");
    expect(journal.trim()).toBe("");
  });

  it("merges a second step without clobbering the first", async () => {
    const id = identity();
    await patchProcessStatus(videoDir, id, {
      step: "notes",
      stepInfo: { status: "done", finishedAt: "2026-01-01T00:00:00.000Z", artifacts: ["n.md"] },
    });
    await patchProcessStatus(videoDir, id, {
      step: "article",
      stepInfo: { status: "done", finishedAt: "2026-01-01T00:01:00.000Z", artifacts: ["article.md"] },
      articleOutDir: "/tmp/out/vid1",
    });
    const merged = await readProcessStatusMerged(videoDir, id);
    expect(merged).not.toBeNull();
    expect(merged!.steps.notes.status).toBe("done");
    expect(merged!.steps.article.status).toBe("done");
    expect(merged!.articleOutDir).toBe("/tmp/out/vid1");
  });
});

describe("patchStepRunning", () => {
  it("writes running then patchProcessStatus can overwrite with done", async () => {
    const id = identity();
    await patchStepRunning(videoDir, id, "publish", { articleOutDir: "/art" });
    let merged = await readProcessStatusMerged(videoDir, id);
    expect(merged!.steps.publish.status).toBe("running");
    expect(merged!.steps.publish.startedAt).toBeDefined();
    await patchProcessStatus(videoDir, id, {
      step: "publish",
      stepInfo: {
        status: "done",
        finishedAt: "2026-01-01T00:02:00.000Z",
        durationMs: 99,
        artifacts: ["publish-result.json"],
      },
      threadUrl: "https://x.com/u/status/1",
      articleOutDir: "/art",
    });
    merged = await readProcessStatusMerged(videoDir, id);
    expect(merged!.steps.publish.status).toBe("done");
    expect(merged!.steps.publish.durationMs).toBe(99);
    expect(merged!.threadUrl).toBe("https://x.com/u/status/1");
  });
});

describe("markStepDone / isStepDone", () => {
  it("marks acquire done and isStepDone returns true", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yt2x-mark-"));
    try {
      await markStepDone(dir, "acquire", ["metadata.json"]);
      await expect(isStepDone(dir, "acquire")).resolves.toBe(true);
      await expect(isStepDone(dir, "notes")).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readProcessStatusMerged", () => {
  it("replays a non-empty journal when main JSON is corrupt", async () => {
    const id = identity();
    await mkdir(videoDir, { recursive: true });
    await writeFile(path.join(videoDir, PROCESS_STATUS_FILE), "{ not json", "utf8");
    const line = {
      v: 1 as const,
      ts: "2026-01-01T00:00:00.000Z",
      step: "notes" as const,
      stepInfo: {
        status: "done" as const,
        finishedAt: "2026-01-01T00:00:00.000Z",
        artifacts: ["structured-notes.md"],
      },
    };
    await writeFile(path.join(videoDir, PROCESS_STATUS_JOURNAL), `${JSON.stringify(line)}\n`, "utf8");
    const merged = await readProcessStatusMerged(videoDir, id);
    expect(merged!.steps.notes.status).toBe("done");
  });
});
