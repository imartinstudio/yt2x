import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as AdaptersNode from "@yt2x/adapters-node";
import { createTechnicalTermGuard } from "@yt2x/core";
import {
  CONTENT_PROMPT_VERSIONS,
  contentSourceFingerprintFor,
  contentTargetMetadataPathFor,
  contentTechnicalTermSourceFingerprintFor,
  createContentTargetMetadata,
  notesContentSourceFor,
  notesKnownSourceTextFor,
  notesRequiredSourceTextFor,
  readContentTargetMetadata,
} from "@yt2x/adapters-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { technicalTermDiscoveryAuditFor } from "@yt2x/adapters-node";

const generateNotesContentMock = vi.hoisted(() => vi.fn());

vi.mock("@yt2x/adapters-node", async (importOriginal) => {
  const actual = await importOriginal<typeof AdaptersNode>();
  return {
    ...actual,
    createLlmAdapter: vi.fn(() => ({ chat: vi.fn() })),
    generateNotesContent: generateNotesContentMock,
    patchStepRunning: vi.fn(async () => {}),
    patchProcessStatus: actual.patchProcessStatus,
  };
});

import { executeNativeNotes } from "./native-notes.js";

const roots: string[] = [];

afterEach(async () => {
  generateNotesContentMock.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe("executeNativeNotes", () => {
  it("rebuilds stale notes metadata and then skips the complete bundle without a provider", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const outDir = await mkdtemp(path.join(tmpdir(), "yt2x-native-notes-cache-"));
    roots.push(outDir);
    const videoDir = path.join(outDir, "notes-cache");
    await mkdir(videoDir, { recursive: true });
    const metadata = { id: "notes-cache", title: "Graph Engineering" };
    const chunksMd = "Graph Engineering";
    const timestampedCuesMd = "00:00 — Graph Engineering";
    await writeFile(path.join(videoDir, "chunks.md"), chunksMd, "utf8");
    await writeFile(path.join(videoDir, "timestamped-cues.md"), timestampedCuesMd, "utf8");
    await writeFile(path.join(videoDir, "metadata.json"), JSON.stringify(metadata), "utf8");
    await writeFile(path.join(videoDir, "structured-notes.md"), "old", "utf8");

    const source = notesContentSourceFor({ metadata, chunksMd, timestampedCuesMd, screenshots: null });
    const sourceFingerprint = contentSourceFingerprintFor(source);
    const artifacts = { metadata, chunksMd, timestampedCuesMd };
    const knownSourceText = notesKnownSourceTextFor(artifacts);
    const sourceText = notesRequiredSourceTextFor(artifacts);
    const sourceTitle = metadata.title;
    const audit = technicalTermDiscoveryAuditFor(
      { accepted: [], reviewCandidates: [], warnings: [] },
      { sourceText, sourceTitle },
    );
    // 已知范围含 prompt 可见的 metadata，必需范围只有转录——缓存判定按 scoped profile 重建
    const guard = createTechnicalTermGuard({ sourceText: knownSourceText, sourceTitle, discovery: audit })
      .scope(sourceText, sourceTitle);
    const metadataPath = contentTargetMetadataPathFor(videoDir, "notes");
    await writeFile(path.join(videoDir, "process-status.json"), "{}", "utf8");
    await mkdir(path.dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, JSON.stringify(createContentTargetMetadata({
      target: "notes",
      sourceFingerprint: contentSourceFingerprintFor({ source, stale: true }),
      requestedModel: "requested-notes-model",
      resolvedModel: "old-provider-model",
      promptVersion: CONTENT_PROMPT_VERSIONS.notes,
      technicalTermProfileFingerprint: guard.profile.profileFingerprint,
      technicalTermDiscovery: audit,
      technicalTermKnownSourceFingerprint:
        contentTechnicalTermSourceFingerprintFor(knownSourceText, sourceTitle),
      technicalTermRequiredSourceFingerprint:
        contentTechnicalTermSourceFingerprintFor(sourceText, sourceTitle),
      technicalTermScope: "scoped",
    })), "utf8");

    generateNotesContentMock.mockResolvedValue({
      content: "# 新笔记\n\nGraph Engineering",
      model: "provider-resolved-model",
      requestedModel: "requested-notes-model",
      resolvedModel: "provider-resolved-model",
      finishReason: "stop",
      videoId: "notes-cache",
      durationMs: 1,
      sourceFingerprint,
      promptVersion: CONTENT_PROMPT_VERSIONS.notes,
      technicalTermProfileFingerprint: guard.profile.profileFingerprint,
      technicalTermDiscovery: audit,
    });

    await expect(executeNativeNotes({
      outDir,
      videoId: ["notes-cache"],
      llmProvider: "openai",
      llmModel: "requested-notes-model",
      showProgress: false,
    })).resolves.toBe(0);
    expect(generateNotesContentMock).toHaveBeenCalledOnce();
    await expect(readFile(path.join(videoDir, "structured-notes.md"), "utf8"))
      .resolves.toContain("新笔记");

    generateNotesContentMock.mockClear();
    await expect(executeNativeNotes({
      outDir,
      videoId: ["notes-cache"],
      llmProvider: "openai",
      llmModel: "requested-notes-model",
      showProgress: false,
    })).resolves.toBe(0);
    expect(generateNotesContentMock).not.toHaveBeenCalled();
    await expect(readContentTargetMetadata(metadataPath)).resolves.toMatchObject({
      requestedModel: "requested-notes-model",
      resolvedModel: "provider-resolved-model",
    });
  });
});
