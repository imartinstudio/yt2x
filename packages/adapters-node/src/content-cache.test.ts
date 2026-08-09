import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTechnicalTermGuard,
  fingerprintTechnicalTermValue,
} from "@yt2x/core";
import {
  CONTENT_PROMPT_VERSIONS,
  contentSourceFingerprintFor,
  contentTargetMetadataPathFor,
  createContentTargetMetadata,
  isContentTargetMetadataFresh,
  readContentTargetMetadata,
  writeContentTargetMetadata,
} from "./content-cache.js";
import { technicalTermDiscoveryAuditFor } from "./technical-terms/discovery.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("content target metadata", () => {
  it("accepts an exact profile-aware cache record and rejects legacy or changed inputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-content-cache-"));
    roots.push(root);
    const sourceText = "Graph Engineering connects a Knowledge Graph.";
    const sourceTitle = "Graph Engineering";
    const audit = technicalTermDiscoveryAuditFor(
      { accepted: [], reviewCandidates: [], warnings: [] },
      { sourceText, sourceTitle },
    );
    const guard = createTechnicalTermGuard({ sourceText, sourceTitle, discovery: audit });
    const sourceFingerprint = contentSourceFingerprintFor({ sourceText, sourceTitle, seed: "visuals-v1" });
    const metadata = createContentTargetMetadata({
      target: "x-short",
      sourceFingerprint,
      model: "model-a",
      promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
      technicalTermProfileFingerprint: guard.profile.profileFingerprint,
      technicalTermDiscovery: audit,
      seedFingerprint: fingerprintTechnicalTermValue("visuals-v1"),
    });
    const metadataPath = contentTargetMetadataPathFor(root, "x-short");

    await writeContentTargetMetadata(metadataPath, metadata);
    await expect(readFile(metadataPath, "utf8")).resolves.toContain('"technicalTermProfileFingerprint"');
    const read = await readContentTargetMetadata(metadataPath);

    await expect(isContentTargetMetadataFresh(read, {
      target: "x-short",
      sourceFingerprint,
      model: "model-a",
      promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
      sourceText,
      sourceTitle,
      requiredFiles: [metadataPath],
    })).resolves.toBe(true);
    await expect(isContentTargetMetadataFresh(read, {
      target: "x-short",
      sourceFingerprint,
      model: "model-b",
      promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
      sourceText,
      sourceTitle,
      requiredFiles: [metadataPath],
    })).resolves.toBe(false);
    await expect(isContentTargetMetadataFresh({ target: "x-short" }, {
      target: "x-short",
      sourceFingerprint,
      model: "model-a",
      promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
      sourceText,
      sourceTitle,
      requiredFiles: [metadataPath],
    })).resolves.toBe(false);
  });
});
