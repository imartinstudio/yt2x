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
  summarySourceTextFor,
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
      requestedModel: "model-a",
      resolvedModel: "provider-model-a",
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
      requestedModel: "model-a",
      promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
      sourceText,
      sourceTitle,
      requiredFiles: [metadataPath],
    })).resolves.toBe(true);
    await expect(isContentTargetMetadataFresh(read, {
      target: "x-short",
      sourceFingerprint,
      requestedModel: "model-b",
      promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
      sourceText,
      sourceTitle,
      requiredFiles: [metadataPath],
    })).resolves.toBe(false);
    await expect(isContentTargetMetadataFresh({ target: "x-short" }, {
      target: "x-short",
      sourceFingerprint,
      requestedModel: "model-a",
      promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
      sourceText,
      sourceTitle,
      requiredFiles: [metadataPath],
    })).resolves.toBe(false);
  });

  it("matches the requested model even when the provider reports a different resolved model", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-content-cache-model-alias-"));
    roots.push(root);
    const sourceText = "Graph Engineering";
    const audit = technicalTermDiscoveryAuditFor(
      { accepted: [], reviewCandidates: [], warnings: [] },
      { sourceText, sourceTitle: "Graph Engineering" },
    );
    const guard = createTechnicalTermGuard({ sourceText, sourceTitle: "Graph Engineering", discovery: audit });
    const sourceFingerprint = contentSourceFingerprintFor({ sourceText });
    const metadata = createContentTargetMetadata({
      target: "x-short",
      sourceFingerprint,
      requestedModel: "deepseek-v4-flash",
      resolvedModel: "deepseek-v4-flash-20260801",
      promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
      technicalTermProfileFingerprint: guard.profile.profileFingerprint,
      technicalTermDiscovery: audit,
    });
    const metadataPath = contentTargetMetadataPathFor(root, "x-short");
    await writeContentTargetMetadata(metadataPath, metadata);

    await expect(isContentTargetMetadataFresh(await readContentTargetMetadata(metadataPath), {
      target: "x-short",
      sourceFingerprint,
      requestedModel: "deepseek-v4-flash",
      promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
      sourceText,
      sourceTitle: "Graph Engineering",
      requiredFiles: [metadataPath],
    })).resolves.toBe(true);
  });

  it("migrates a legacy model field without treating it as a provider-resolved cache key", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-content-cache-legacy-model-"));
    roots.push(root);
    const sourceText = "Graph Engineering";
    const sourceTitle = "Graph Engineering";
    const audit = technicalTermDiscoveryAuditFor(
      { accepted: [], reviewCandidates: [], warnings: [] },
      { sourceText, sourceTitle },
    );
    const guard = createTechnicalTermGuard({ sourceText, sourceTitle, discovery: audit });
    const sourceFingerprint = contentSourceFingerprintFor({ sourceText });
    const metadataPath = contentTargetMetadataPathFor(root, "x-short");
    await writeFileForTest(metadataPath, {
      v: 1,
      target: "x-short",
      sourceFingerprint,
      model: "deepseek-v4-flash",
      promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
      technicalTermProfileFingerprint: guard.profile.profileFingerprint,
      technicalTermDiscovery: audit,
      generatedAt: "2026-08-09T00:00:00.000Z",
    });

    const migrated = await readContentTargetMetadata(metadataPath);
    expect(migrated).toMatchObject({
      requestedModel: "deepseek-v4-flash",
      resolvedModel: "deepseek-v4-flash",
    });
    await expect(isContentTargetMetadataFresh(migrated, {
      target: "x-short",
      sourceFingerprint,
      requestedModel: "deepseek-v4-flash",
      promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
      sourceText,
      sourceTitle,
      requiredFiles: [metadataPath],
    })).resolves.toBe(true);
  });

  it("derives summary validation scope from source sections instead of the entire notes document", () => {
    const scope = summarySourceTextFor([
      "# Source title",
      "",
      "## Executive Summary",
      "Graph Engineering is the main idea.",
      "",
      "## Detailed Notes",
      "Knowledge Graph is a later implementation detail.",
      "",
      "## Key Takeaways",
      "Keep the main idea actionable.",
    ].join("\n"));

    expect(scope).toContain("Graph Engineering");
    expect(scope).toContain("Keep the main idea actionable.");
    expect(scope).not.toContain("Knowledge Graph is a later implementation detail.");
  });
});

const writeFileForTest = async (filePath: string, value: unknown): Promise<void> => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};
