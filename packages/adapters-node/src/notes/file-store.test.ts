import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTENT_PROMPT_VERSIONS,
  contentSourceFingerprintFor,
  contentTargetMetadataPathFor,
  createContentTargetMetadata,
  writeContentTargetMetadata,
} from "../content-cache.js";
import {
  findPendingVideoDirs,
  readVideoArtifacts,
  writeStructuredNotes,
} from "./file-store.js";
import { createTechnicalTermGuard } from "@yt2x/core";
import { technicalTermDiscoveryAuditFor } from "../technical-terms/discovery.js";

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "yt2x-notes-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const seedVideo = async (
  videoId: string,
  files: Partial<{
    chunks: string;
    cues: string;
    metadata: string;
    screenshots: string;
    structuredNotes: string;
  }> = {},
): Promise<string> => {
  const dir = path.join(outDir, videoId);
  await mkdir(dir, { recursive: true });
  if (files.chunks !== undefined) await writeFile(path.join(dir, "chunks.md"), files.chunks);
  if (files.cues !== undefined)
    await writeFile(path.join(dir, "timestamped-cues.md"), files.cues);
  if (files.metadata !== undefined)
    await writeFile(path.join(dir, "metadata.json"), files.metadata);
  if (files.screenshots !== undefined) {
    await mkdir(path.join(dir, "screenshots"), { recursive: true });
    await writeFile(path.join(dir, "screenshots", "scene_manifest.json"), files.screenshots);
  }
  if (files.structuredNotes !== undefined)
    await writeFile(path.join(dir, "structured-notes.md"), files.structuredNotes);
  return dir;
};

describe("readVideoArtifacts", () => {
  it("reads chunks/cues/metadata when all present", async () => {
    const dir = await seedVideo("abc", {
      chunks: "## c",
      cues: "00:00 — hi",
      metadata: JSON.stringify({ id: "abc", title: "Hello" }),
    });
    const arts = await readVideoArtifacts(dir);
    expect(arts.videoId).toBe("abc");
    expect(arts.chunksMd).toBe("## c");
    expect(arts.timestampedCuesMd).toBe("00:00 — hi");
    expect(arts.metadata.id).toBe("abc");
    expect(arts.screenshots).toBeNull();
  });

  it("loads screenshots manifest when present", async () => {
    const dir = await seedVideo("abc", {
      chunks: "c",
      cues: "x",
      metadata: "{}",
      screenshots: JSON.stringify({ frames: [{ timestamp: "00:00", file: "a.jpg" }] }),
    });
    const arts = await readVideoArtifacts(dir);
    expect(arts.screenshots?.frames?.[0]?.file).toBe("a.jpg");
  });

  it("tolerates malformed screenshots manifest (falls back to null)", async () => {
    const dir = await seedVideo("abc", {
      chunks: "c",
      cues: "x",
      metadata: "{}",
      screenshots: "not json",
    });
    const arts = await readVideoArtifacts(dir);
    expect(arts.screenshots).toBeNull();
  });

  it("throws clear error listing missing required files", async () => {
    const dir = await seedVideo("abc", { chunks: "c" }); // missing cues + metadata
    await expect(readVideoArtifacts(dir)).rejects.toMatchObject({
      missing: expect.arrayContaining(["timestamped-cues.md", "metadata.json"]),
    });
  });

  it("throws on invalid JSON metadata", async () => {
    const dir = await seedVideo("abc", {
      chunks: "c",
      cues: "x",
      metadata: "{ not json",
    });
    await expect(readVideoArtifacts(dir)).rejects.toThrow(/not valid JSON/);
  });
});

describe("writeStructuredNotes", () => {
  it("writes file atomically and returns absolute path", async () => {
    const dir = path.join(outDir, "abc");
    await mkdir(dir, { recursive: true });
    const file = await writeStructuredNotes(dir, "# Title\n\nbody");
    expect(file).toBe(path.join(dir, "structured-notes.md"));
    expect(await readFile(file, "utf8")).toBe("# Title\n\nbody");
  });

  it("returns null when structured-notes.md exists without --force", async () => {
    const dir = await seedVideo("abc", { structuredNotes: "old" });
    const result = await writeStructuredNotes(dir, "new");
    expect(result).toBeNull();
    expect(await readFile(path.join(dir, "structured-notes.md"), "utf8")).toBe("old");
  });

  it("overwrites with force: true", async () => {
    const dir = await seedVideo("abc", { structuredNotes: "old" });
    await writeStructuredNotes(dir, "new", { force: true });
    expect(await readFile(path.join(dir, "structured-notes.md"), "utf8")).toBe("new");
  });

  it("rebuilds an existing notes file when the profile-aware cache metadata is stale", async () => {
    const dir = await seedVideo("abc", {
      chunks: "Graph Engineering",
      cues: "00:00 — Graph Engineering",
      metadata: JSON.stringify({ id: "abc", title: "Graph Engineering" }),
      structuredNotes: "old",
    });
    const sourceText = "Graph Engineering\n00:00 — Graph Engineering";
    const sourceTitle = "Graph Engineering";
    const audit = technicalTermDiscoveryAuditFor(
      { accepted: [], reviewCandidates: [], warnings: [] },
      { sourceText, sourceTitle },
    );
    const guard = createTechnicalTermGuard({ sourceText, sourceTitle, discovery: audit });
    const metadataPath = contentTargetMetadataPathFor(dir, "notes");
    await writeContentTargetMetadata(metadataPath, createContentTargetMetadata({
      target: "notes",
      sourceFingerprint: contentSourceFingerprintFor({ sourceText, sourceTitle, revision: "old" }),
      requestedModel: "notes-model",
      resolvedModel: "notes-model",
      promptVersion: CONTENT_PROMPT_VERSIONS.notes,
      technicalTermProfileFingerprint: guard.profile.profileFingerprint,
      technicalTermDiscovery: audit,
    }));

    await expect(writeStructuredNotes(dir, "new", {
      cacheExpectation: {
        target: "notes",
        sourceFingerprint: contentSourceFingerprintFor({ sourceText, sourceTitle }),
        requestedModel: "notes-model",
        promptVersion: CONTENT_PROMPT_VERSIONS.notes,
        sourceText,
        sourceTitle,
        requiredFiles: [path.join(dir, "structured-notes.md"), metadataPath],
      },
    })).resolves.toBe(path.join(dir, "structured-notes.md"));
    await expect(readFile(path.join(dir, "structured-notes.md"), "utf8")).resolves.toBe("new");
  });

  it("creates parent directory if missing", async () => {
    const dir = path.join(outDir, "fresh");
    const file = await writeStructuredNotes(dir, "x");
    expect(await readFile(file, "utf8")).toBe("x");
  });
});

describe("findPendingVideoDirs", () => {
  it("returns empty array for non-existent outDir (no throw)", async () => {
    expect(await findPendingVideoDirs(path.join(outDir, "ghost"))).toEqual([]);
  });

  it("lists every acquired dir so stale notes metadata can be rebuilt", async () => {
    await seedVideo("a", { chunks: "x", cues: "x", metadata: "{}" });
    await seedVideo("b", { chunks: "x", cues: "x", metadata: "{}", structuredNotes: "done" });
    await seedVideo("c", { chunks: "x", cues: "x", metadata: "{}" });
    await seedVideo("d", {}); // no chunks → skipped
    const pending = await findPendingVideoDirs(outDir);
    expect(pending.map((p) => path.basename(p)).sort()).toEqual(["a", "b", "c"]);
  });

  it("is deterministic (sorted)", async () => {
    await seedVideo("z", { chunks: "x", cues: "x", metadata: "{}" });
    await seedVideo("a", { chunks: "x", cues: "x", metadata: "{}" });
    const pending = await findPendingVideoDirs(outDir);
    expect(pending.map((p) => path.basename(p))).toEqual(["a", "z"]);
  });

  it("ignores plain files in outDir", async () => {
    await writeFile(path.join(outDir, "loose-file.txt"), "x");
    await seedVideo("a", { chunks: "x", cues: "x", metadata: "{}" });
    const pending = await findPendingVideoDirs(outDir);
    expect(pending).toHaveLength(1);
  });
});
