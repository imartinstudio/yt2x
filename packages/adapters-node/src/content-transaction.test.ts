import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireContentTargetLock,
  atomicWriteUtf8,
  contentTargetLockPathFor,
  replaceDirectoryAtomically,
  withContentTargetLock,
} from "./content-transaction.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("content target transaction helpers", () => {
  it("serializes concurrent target work and removes the lock in finally", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-content-lock-"));
    roots.push(root);
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;

    const work = (name: string) => withContentTargetLock(root, "x-short", async () => {
      events.push(`${name}:enter`);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      events.push(`${name}:exit`);
    });

    await Promise.all([work("a"), work("b")]);

    expect(maximumActive).toBe(1);
    expect(events.filter((event) => event.endsWith(":enter")).sort()).toEqual(["a:enter", "b:enter"]);
    await expect(readdir(path.dirname(contentTargetLockPathFor(root, "x-short")))).resolves.toEqual([]);
  });

  it("keeps concurrent body and metadata writes in the same generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-content-generation-lock-"));
    roots.push(root);
    const bodyPath = path.join(root, "body.md");
    const metadataPath = path.join(root, "metadata.json");
    const writeGeneration = (generation: string) => withContentTargetLock(root, "article", async () => {
      await atomicWriteUtf8(bodyPath, generation + "\n");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await atomicWriteUtf8(metadataPath, JSON.stringify({ generation }) + "\n");
    });

    await Promise.all([writeGeneration("generation-a"), writeGeneration("generation-b")]);

    const bodyGeneration = (await readFile(bodyPath, "utf8")).trim();
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { generation: string };
    expect(metadata.generation).toBe(bodyGeneration);
  });

  it("takes over an expired lock but times out on a live lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-content-stale-lock-"));
    roots.push(root);
    const lockPath = contentTargetLockPathFor(root, "notes");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        token: "stale",
        pid: 999999,
        createdAt: Date.now() - 121_000,
        expiresAt: Date.now() - 1,
      }),
      "utf8",
    );

    await expect(withContentTargetLock(root, "notes", async () => "recovered", {
      timeoutMs: 100,
      pollMs: 1,
    })).resolves.toBe("recovered");

    const release = await acquireContentTargetLock(root, "notes", { timeoutMs: 100, pollMs: 1 });
    await expect(withContentTargetLock(root, "notes", async () => "unreachable", {
      timeoutMs: 15,
      pollMs: 1,
    })).rejects.toThrow(/Timed out acquiring content target lock/);
    await release();
  });

  it("uses unique temporary names and cleans them after an atomic write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-content-atomic-write-"));
    roots.push(root);
    const target = path.join(root, "bundle", "body.md");

    await Promise.all([
      atomicWriteUtf8(target, "first\n"),
      atomicWriteUtf8(target, "second\n"),
    ]);

    await expect(readFile(target, "utf8")).resolves.toMatch(/^first\n$|^second\n$/);
    await expect(readdir(path.dirname(target))).resolves.toEqual(["body.md"]);
  });

  it("replaces a staged bundle as one directory generation and rolls back an interrupted commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-content-directory-"));
    roots.push(root);
    const target = path.join(root, "clips");
    const staged = path.join(root, ".stage-unique");
    await mkdir(target, { recursive: true });
    await mkdir(staged, { recursive: true });
    await writeFile(path.join(target, "body.md"), "old", "utf8");
    await writeFile(path.join(target, "metadata.json"), "old-generation", "utf8");
    await writeFile(path.join(staged, "body.md"), "new", "utf8");
    await writeFile(path.join(staged, "metadata.json"), "new-generation", "utf8");

    await replaceDirectoryAtomically(staged, target);
    await expect(readFile(path.join(target, "body.md"), "utf8")).resolves.toBe("new");
    await expect(readFile(path.join(target, "metadata.json"), "utf8")).resolves.toBe("new-generation");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);

    const nextStage = path.join(root, ".stage-next");
    await mkdir(nextStage, { recursive: true });
    await writeFile(path.join(nextStage, "body.md"), "newest", "utf8");
    let pointerRenameCount = 0;
    await expect(replaceDirectoryAtomically(nextStage, target, {
      rename: async (from, to) => {
        pointerRenameCount += 1;
        if (pointerRenameCount === 2) throw new Error("pointer commit interrupted");
        const { rename } = await import("node:fs/promises");
        await rename(from, to);
      },
    })).rejects.toThrow("pointer commit interrupted");
    await expect(readFile(path.join(target, "body.md"), "utf8")).resolves.toBe("new");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);

    const interruptedTarget = path.join(root, "interrupted");
    const interruptedStage = path.join(root, ".stage-interrupted");
    await mkdir(interruptedTarget, { recursive: true });
    await mkdir(interruptedStage, { recursive: true });
    await writeFile(path.join(interruptedTarget, "body.md"), "stable", "utf8");
    await writeFile(path.join(interruptedStage, "body.md"), "candidate", "utf8");
    let renameCount = 0;
    await expect(replaceDirectoryAtomically(interruptedStage, interruptedTarget, {
      rename: async (from, to) => {
        renameCount += 1;
        if (renameCount === 2) throw new Error("commit interrupted");
        const { rename } = await import("node:fs/promises");
        await rename(from, to);
      },
    })).rejects.toThrow("commit interrupted");
    await expect(readFile(path.join(interruptedTarget, "body.md"), "utf8")).resolves.toBe("stable");
  });
});
