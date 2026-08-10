import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireContentTargetLock,
  atomicWriteUtf8,
  canonicalContentTargetLockPathFor,
  contentTargetLockPathFor,
  replaceDirectoryAtomically,
  withContentTargetLock,
} from "./content-transaction.js";
import { writeNativeArticleBundle } from "./article/file-store.js";
import { writeNativeShortBundle } from "./short/file-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("content target transaction helpers", () => {
  it("uses one lock namespace for native and direct writers of the same bundle root", () => {
    expect(contentTargetLockPathFor("/tmp/article-root", "native-content")).toBe(
      contentTargetLockPathFor("/tmp/article-root", "article"),
    );
    expect(contentTargetLockPathFor("/tmp/article-root", "native-content")).toBe(
      contentTargetLockPathFor("/tmp/article-root", "x-short"),
    );
  });

  it("makes native-content mutually exclusive with real direct article and x-short writers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-content-real-writers-"));
    roots.push(root);
    const videoId = "same-root";
    const articleDir = path.join(root, videoId);
    const release = await acquireContentTargetLock(articleDir, "native-content");
    const articleWrite = writeNativeArticleBundle(root, videoId, "article-generation", {
      v: 3,
      platform: "x",
      videoId,
      model: "model",
      finishReason: "stop",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
      technicalTermProfileFingerprint: "sha256-profile",
    }, { force: true });
    const shortWrite = writeNativeShortBundle(root, videoId, {
      text: "short-generation",
      angle: "practical",
      risk: "low",
    }, { force: true });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(readFile(path.join(articleDir, "article.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(articleDir, "x-format", "x-short.md"), "utf8")).rejects.toThrow();
    await release();
    await Promise.all([articleWrite, shortWrite]);
    await expect(readFile(path.join(articleDir, "article.md"), "utf8")).resolves.toBe("article-generation");
    await expect(readFile(path.join(articleDir, "x-format", "x-short.md"), "utf8")).resolves.toBe("short-generation\n");
  });

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

  it("swaps a staged bundle into the target and restores the previous one when the commit fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-bundle-swap-"));
    roots.push(root);
    const target = path.join(root, "x-format", "clips");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "clips-manifest.json"), "old", "utf8");
    await writeFile(path.join(target, "stale-post.md"), "stale", "utf8");

    const staged = path.join(root, "stage-1");
    await mkdir(staged, { recursive: true });
    await writeFile(path.join(staged, "clips-manifest.json"), "new", "utf8");
    await replaceDirectoryAtomically(staged, target);

    // 交付物直接躺在公开目录里，上一版残留被整体换掉。
    expect((await readdir(target)).sort()).toEqual(["clips-manifest.json"]);
    expect(await readFile(path.join(target, "clips-manifest.json"), "utf8")).toBe("new");
    expect((await lstat(target)).isDirectory()).toBe(true);

    const failing = path.join(root, "stage-2");
    await mkdir(failing, { recursive: true });
    await writeFile(path.join(failing, "clips-manifest.json"), "never", "utf8");
    let calls = 0;
    await expect(replaceDirectoryAtomically(failing, target, {
      rename: async (from, to) => {
        calls += 1;
        if (calls === 2) throw new Error("simulated commit failure");
        await rename(from, to);
      },
    })).rejects.toThrow("simulated commit failure");

    // 回滚后旧内容原样回到目标位置，不留半成品。
    expect(await readFile(path.join(target, "clips-manifest.json"), "utf8")).toBe("new");
    expect(await stat(failing).catch(() => undefined)).toBeUndefined();
    expect((await readdir(path.join(root, "x-format"))).sort()).toEqual(["clips"]);
  });

});

describe("canonical content target locks", () => {
  it("gives the same lock to an aliased symlink path and the real path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-content-alias-lock-"));
    roots.push(root);
    const realDir = path.join(root, "real", "article");
    await mkdir(realDir, { recursive: true });
    const aliasRoot = path.join(root, "files");
    await symlink(path.join(root, "real"), aliasRoot, "dir");
    const aliasDir = path.join(aliasRoot, "article");

    await expect(canonicalContentTargetLockPathFor(aliasDir, "deconstruct")).resolves.toBe(
      await canonicalContentTargetLockPathFor(realDir, "deconstruct"),
    );

    const release = await acquireContentTargetLock(realDir, "deconstruct");
    try {
      await expect(acquireContentTargetLock(aliasDir, "deconstruct", {
        timeoutMs: 60,
        pollMs: 5,
      })).rejects.toThrow(/Timed out acquiring content target lock/);
    } finally {
      await release();
    }

    const releaseAlias = await acquireContentTargetLock(aliasDir, "deconstruct", { timeoutMs: 200, pollMs: 5 });
    await releaseAlias();
  });

  it("canonicalizes a not-yet-created root through its nearest existing ancestor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-content-alias-missing-lock-"));
    roots.push(root);
    await mkdir(path.join(root, "real"), { recursive: true });
    await symlink(path.join(root, "real"), path.join(root, "files"), "dir");
    const missingReal = path.join(root, "real", "pending", "x-format", "clips");
    const missingAlias = path.join(root, "files", "pending", "x-format", "clips");

    await expect(canonicalContentTargetLockPathFor(missingAlias, "deconstruct")).resolves.toBe(
      await canonicalContentTargetLockPathFor(missingReal, "deconstruct"),
    );
    await expect(canonicalContentTargetLockPathFor(missingAlias, "deconstruct")).resolves.toContain(
      path.join("pending", "x-format", "clips"),
    );

    const release = await acquireContentTargetLock(missingReal, "deconstruct");
    try {
      await expect(acquireContentTargetLock(missingAlias, "deconstruct", {
        timeoutMs: 60,
        pollMs: 5,
      })).rejects.toThrow(/Timed out acquiring content target lock/);
    } finally {
      await release();
    }
  });
});
