import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectNativePipelineVideoIds,
  listBatchVideosFromOutRoot,
  resolveAcquireVideoQueue,
} from "./batch-queue.js";
import { markStepDone } from "../fs/process-status-store.js";

describe("listBatchVideosFromOutRoot", () => {
  it("lists dirs with metadata.json or process-status only", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-batch-"));
    await mkdir(path.join(outRoot, "z99"), { recursive: true });
    await mkdir(path.join(outRoot, "a11"), { recursive: true });
    await writeFile(path.join(outRoot, "a11", "metadata.json"), JSON.stringify({ title: "A" }));
    const pstatDir = path.join(outRoot, "pstat");
    await mkdir(pstatDir, { recursive: true });
    await markStepDone(pstatDir, "acquire", []);
    await writeFile(path.join(outRoot, "noise.txt"), "x");
    const rows = await listBatchVideosFromOutRoot(outRoot);
    expect(rows.map((r) => r.video_id)).toEqual(["a11", "pstat"]);
  });
});

describe("resolveAcquireVideoQueue", () => {
  it("continue prefers disk dirs over new urls", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-queue-"));
    await mkdir(path.join(outRoot, "onDisk"), { recursive: true });
    await writeFile(path.join(outRoot, "onDisk", "metadata.json"), "{}");
    const rows = await resolveAcquireVideoQueue({
      outDir: outRoot,
      continueFlag: true,
      sources: { urls: ["https://www.youtube.com/watch?v=notUsed123"] },
    });
    expect(rows?.map((r) => r.video_id)).toEqual(["onDisk"]);
  });

  it("returns null when sources cannot be resolved", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-queue-empty-"));
    const rows = await resolveAcquireVideoQueue({
      outDir: outRoot,
      continueFlag: false,
      sources: { urls: [] },
    });
    expect(rows).toBeNull();
  });
});

describe("collectNativePipelineVideoIds", () => {
  it("returns sorted video ids from listBatchVideosFromOutRoot", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-col-"));
    for (const id of ["b", "a"]) {
      await mkdir(path.join(outRoot, id), { recursive: true });
      await writeFile(path.join(outRoot, id, "metadata.json"), "{}");
    }
    const ids = await collectNativePipelineVideoIds(outRoot);
    expect(ids).toEqual(["a", "b"]);
  });
});
