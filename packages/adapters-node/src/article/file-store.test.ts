import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findPendingNativeArticleDirs,
  readStructuredNotesArtifacts,
  writeNativeArticleBundle,
} from "./file-store.js";

let notesRoot: string;
let articleRoot: string;

beforeEach(async () => {
  notesRoot = await mkdtemp(path.join(tmpdir(), "yt2x-notes-src-"));
  articleRoot = await mkdtemp(path.join(tmpdir(), "yt2x-art-out-"));
});

afterEach(async () => {
  await rm(notesRoot, { recursive: true, force: true });
  await rm(articleRoot, { recursive: true, force: true });
});

const seedNotesVideo = async (
  videoId: string,
  opts: { notes?: string; meta?: string; shot?: Buffer } = {},
): Promise<string> => {
  const dir = path.join(notesRoot, videoId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "structured-notes.md"),
    opts.notes ?? "# Title\n\nbody",
  );
  await writeFile(path.join(dir, "metadata.json"), opts.meta ?? JSON.stringify({ id: videoId, title: "T" }));
  if (opts.shot !== undefined) {
    await mkdir(path.join(dir, "screenshots"), { recursive: true });
    await writeFile(path.join(dir, "screenshots", "a.webp"), opts.shot);
  }
  return dir;
};

describe("readStructuredNotesArtifacts", () => {
  it("reads structured notes + metadata", async () => {
    const dir = await seedNotesVideo("v1", { notes: "N", meta: JSON.stringify({ id: "v1" }) });
    const a = await readStructuredNotesArtifacts(dir);
    expect(a.structuredNotesMd).toBe("N");
    expect(a.metadata.id).toBe("v1");
  });

  it("throws with missing list", async () => {
    const dir = path.join(notesRoot, "bad");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "structured-notes.md"), "x");
    await expect(readStructuredNotesArtifacts(dir)).rejects.toMatchObject({
      missing: ["metadata.json"],
    });
  });

  it("reports missing structured notes clearly", async () => {
    const dir = path.join(notesRoot, "missing-notes");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "metadata.json"), JSON.stringify({ id: "missing-notes" }));
    await expect(readStructuredNotesArtifacts(dir)).rejects.toMatchObject({
      missing: ["structured-notes.md"],
    });
  });
});

describe("writeNativeArticleBundle", () => {
  it("writes article.md and run.json atomically", async () => {
    await seedNotesVideo("v1");
    const run = {
      v: 1 as const,
      platform: "x" as const,
      videoId: "v1",
      model: "m",
      finishReason: "stop",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
    };
    const w = await writeNativeArticleBundle(articleRoot, "v1", "# A\n\nok", run);
    expect(await readFile(w.articlePath, "utf8")).toBe("# A\n\nok");
    const parsed = JSON.parse(await readFile(w.runPath, "utf8")) as { model: string };
    expect(parsed.model).toBe("m");
  });

  it("refuses overwrite without --force", async () => {
    await seedNotesVideo("v1");
    const run = {
      v: 1 as const,
      platform: "x" as const,
      videoId: "v1",
      model: "m",
      finishReason: "stop",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
    };
    await writeNativeArticleBundle(articleRoot, "v1", "one", run);
    await expect(writeNativeArticleBundle(articleRoot, "v1", "two", run)).rejects.toThrow(/already exists/);
  });

  it("copies cover from screenshots when notesVideoDir passed", async () => {
    await seedNotesVideo("v1", { shot: Buffer.from([0x52, 0x49, 0x46, 0x46]) });
    const run = {
      v: 1 as const,
      platform: "x" as const,
      videoId: "v1",
      model: "m",
      finishReason: "stop",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
    };
    const w = await writeNativeArticleBundle(articleRoot, "v1", "x", run, {
      notesVideoDir: path.join(notesRoot, "v1"),
    });
    expect(w.coverPath).toBe(path.join(w.articleDir, "images", "cover.webp"));
  });
});

describe("findPendingNativeArticleDirs", () => {
  it("lists dirs with notes but no destination article.md", async () => {
    await seedNotesVideo("a");
    await seedNotesVideo("b");
    await mkdir(path.join(articleRoot, "b"), { recursive: true });
    await writeFile(path.join(articleRoot, "b", "article.md"), "done");
    const pending = await findPendingNativeArticleDirs(notesRoot, articleRoot);
    expect(pending).toEqual([path.join(notesRoot, "a")]);
  });
});
