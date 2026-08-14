import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readDeconstructArtifacts: vi.fn(),
  deconstructCacheIdentityFor: vi.fn(() => ({
    sourceFingerprint: "candidate-source-fingerprint",
    candidateSourceText: "candidate source text",
    sourceTitle: "Cached",
    srtSha256: "sha256-srt",
    videoSourceIdentity: { contentSha256: "sha256-video" },
  })),
  runDeconstruct: vi.fn(),
  clipCandidates: vi.fn(),
  writeDeconstructOutput: vi.fn(),
  createLlmAdapter: vi.fn(() => ({})),
  applyClipSelection: vi.fn((manifest: unknown) => ({ manifest, kept: 1, removed: 0 })),
  selectTopUniqueArticleSections: vi.fn(),
  generateClipsPosts: vi.fn(),
  writeSelectedPostFiles: vi.fn(),
  writeReports: vi.fn(),
  CONTENT_PROMPT_VERSIONS: { deconstruct: "native-deconstruct-v2", clipPost: "native-clip-post-v2" },
  acquireContentTargetLock: vi.fn(async () => async () => {}),
  assertClipPublishReadiness: vi.fn(),
  contentTargetMetadataPathFor: vi.fn((dir: string, target: string) => dir + "/.content-metadata/" + target + ".json"),
  createContentTargetMetadata: vi.fn((input: unknown) => input),
  writeContentTargetMetadata: vi.fn(async () => {}),
  readContentTargetMetadata: vi.fn(),
  isContentTargetMetadataFresh: vi.fn(),
  replaceDirectoryAtomically: vi.fn(async () => {}),
  resolveContentBundleDir: vi.fn(async (dir: string) => dir),
  clipPostSourceTextFor: vi.fn(() => "source-text"),
  selectedClipPostCacheIdentityFor: vi.fn(() => ({
    sourceText: "selected-source-text",
    sourceFingerprint: "selected-source-fingerprint",
  })),
  clipsInputForManifest: vi.fn(() => []),
  filterValidSections: vi.fn(),
  validateClipEndings: vi.fn(),
  splitOversizedSections: vi.fn(),
}));

vi.mock("@yt2x/adapters-node", () => mocks);
vi.mock("../config/env.js", () => ({
  defaultCliLlmProvider: () => "openai",
  resolveLlmConfig: () => ({ provider: "openai", model: "test-model" }),
}));
vi.mock("../config/monorepo-root.js", () => ({
  defaultMonorepoRoot: () => "/tmp/yt2x-test-root",
}));

import { runDeconstructCommand } from "./deconstruct.js";

const section = {
  id: "section-1",
  title: "Latent Workspace Routing",
  summary: "summary",
  article_section: "section",
  angle: "tutorial",
  risk: "low",
  timecodes: { start: "00:00:00", end: "00:00:10", startSec: 0, endSec: 10, durationSec: 10 },
  scores: {
    counter_intuitiveness: 3,
    shareability: 3,
    practical_value: 3,
    visual_appeal: 3,
    composite: 3,
  },
  key_quote: "quote",
  video_script: "script",
};

describe("runDeconstructCommand", () => {
  afterEach(() => vi.clearAllMocks());

  it("reuses the generation technical-term profile for the selected-post rewrite", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-cli-deconstruct-terms-"));
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      // 提交后 finalClipsDir 已经被铺回机制填上这一代的全部交付物；resolveContentBundleDir
      // 在这里模拟真实的「解析出的路径带一次性 generation UUID」，用来断言 CLI 打印给用户
      // 看的路径必须是稳定的公开 root，而不是每次都不同的 generation 路径。
      mocks.resolveContentBundleDir.mockImplementation(
        async (dir: string) => path.join(dir, ".generations", "generation-fake-uuid"),
      );
      const manifest = {
        v: 1,
        source: { videoId: "profile-pass", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-08-09T00:00:00.000Z",
        candidateCount: 1,
        total: 1,
        clips: [],
      };
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest), "utf8");

      const technicalTerms = {
        guard: { profile: { profileFingerprint: "fnv1a-profile-pass" } },
        restoration: { placeholders: [] },
        articleTitle: "Latent Workspace Routing",
        discoveredTerms: [{
          sourceText: "Latent Workspace Routing",
          confidence: "high",
          category: "ai-agent",
        }],
        sourceTextByClipId: { "1": "Latent Workspace Routing" },
      };
      mocks.readDeconstructArtifacts.mockResolvedValue({
        articleMd: "# Latent Workspace Routing",
        srtContent: "",
        videoId: "profile-pass",
        videoPath: path.join(articleDir, "video", "full.mp4"),
        durationSec: 60,
      });
      mocks.runDeconstruct.mockResolvedValue({
        candidates: { sections: [section] },
        candidateTechnicalTerms: {
          sourceFingerprint: "candidate-source-fingerprint",
          profileFingerprint: "candidate-profile",
          discoveryAudit: { promptVersion: "discovery", sourceIdentity: "candidate-audit" },
          requestedModel: "test-model",
          resolvedModel: "resolved-candidate-model",
        },
      });
      mocks.splitOversizedSections.mockReturnValue({ sections: [section] });
      mocks.filterValidSections.mockReturnValue({ sections: [section] });
      mocks.validateClipEndings.mockReturnValue([]);
      mocks.writeDeconstructOutput.mockResolvedValue({
        manifestPath: path.join(clipsDir, "clips-manifest.json"),
        manifest,
        clippedCount: 1,
      });
      mocks.generateClipsPosts.mockResolvedValue({ postCount: 1, postPaths: [], manifest, technicalTerms });
      mocks.selectTopUniqueArticleSections.mockReturnValue([{ section, originalIndex: 0 }]);
      mocks.writeSelectedPostFiles.mockResolvedValue([path.join(clipsDir, "post-1.md")]);
      mocks.clipCandidates.mockResolvedValue([{ success: true, candidate: section }]);
      mocks.assertClipPublishReadiness.mockResolvedValue({ publishOrder: ["post-1.md"] });
      mocks.writeReports.mockResolvedValue({ decompositionPath: "decomposition.md", reviewPath: "review.md" });
      mocks.isContentTargetMetadataFresh.mockResolvedValue(false);

      await expect(runDeconstructCommand(articleDir, 1)).resolves.toBe(0);

      expect(mocks.writeSelectedPostFiles).toHaveBeenCalledWith(
        expect.objectContaining({ source: expect.objectContaining({ videoId: "profile-pass" }) }),
        articleDir,
        technicalTerms,
        expect.objectContaining({
          clipsDir: expect.stringContaining(".deconstruct-stage-"),
          lock: false,
        }),
      );
      expect(mocks.createContentTargetMetadata).toHaveBeenCalledWith(expect.objectContaining({
        target: "deconstruct-run",
        sourceFingerprint: "candidate-source-fingerprint",
        technicalTermProfileFingerprint: "candidate-profile",
        technicalTermDiscovery: expect.objectContaining({ sourceIdentity: "candidate-audit" }),
      }));

      // 提交后的铺回机制已经让公开 root 直接可见交付物，CLI 打印给用户的路径必须
      // 是稳定的 clipsDir，不能带一次性的 generation UUID。
      const loggedLines = consoleLogSpy.mock.calls.map((call) => call.join(" "));
      expect(loggedLines.some((line) => line.includes(`${clipsDir}/clips-manifest.json`))).toBe(true);
      expect(loggedLines.some((line) => line.includes("generation-fake-uuid"))).toBe(false);
    } finally {
      consoleLogSpy.mockRestore();
      mocks.resolveContentBundleDir.mockImplementation(async (dir: string) => dir);
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("checks the complete bundle cache before candidate and post providers", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-cli-deconstruct-cache-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      const manifest = {
        v: 1,
        source: { videoId: "cache-pass", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-08-09T00:00:00.000Z",
        candidateCount: 1,
        total: 1,
        clips: [{
          id: "clip-1",
          slug: "cached",
          title: "Cached",
          type: "insight",
          angle: "tutorial",
          risk: "low",
          timecodes: { start: "00:00:00", end: "00:00:10", startSec: 0, endSec: 10, durationSec: 10 },
          video: "candidate-1-cached.mp4",
          selected: true,
          text: "缓存帖子",
          charCount: 4,
        }],
      };
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest), "utf8");
      await writeFile(path.join(clipsDir, "post-1-cached.md"), "post", "utf8");
      await writeFile(path.join(clipsDir, "candidate-1-cached.mp4"), "video", "utf8");

      mocks.readDeconstructArtifacts.mockResolvedValue({
        articleMd: "# Cached",
        srtContent: "00:00:00,000 --> 00:00:10,000\nCached",
        videoId: "cache-pass",
        videoPath: path.join(articleDir, "video", "full.mp4"),
        durationSec: 60,
      });
      mocks.contentTargetMetadataPathFor.mockReturnValue(path.join(clipsDir, ".content-metadata", "deconstruct.json"));
      mocks.readContentTargetMetadata
        .mockResolvedValueOnce({ target: "deconstruct-run" })
        .mockResolvedValueOnce({ target: "clip-post" });
      mocks.isContentTargetMetadataFresh
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      mocks.assertClipPublishReadiness.mockResolvedValue({ publishOrder: ["post-1-cached.md"] });

      await expect(runDeconstructCommand(articleDir, 1)).resolves.toBe(0);

      expect(mocks.runDeconstruct).not.toHaveBeenCalled();
      expect(mocks.generateClipsPosts).not.toHaveBeenCalled();
      expect(mocks.clipCandidates).not.toHaveBeenCalled();
      expect(mocks.assertClipPublishReadiness).toHaveBeenCalled();
      expect(mocks.deconstructCacheIdentityFor).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: "cache-pass" }),
        { requestedModel: "test-model", selectCount: 1 },
      );
      expect(mocks.isContentTargetMetadataFresh).toHaveBeenNthCalledWith(1,
        { target: "deconstruct-run" },
        expect.objectContaining({
          target: "deconstruct-run",
          sourceFingerprint: "candidate-source-fingerprint",
          sourceText: "candidate source text",
        }),
      );
      expect(mocks.isContentTargetMetadataFresh).toHaveBeenNthCalledWith(2,
        { target: "clip-post" },
        expect.objectContaining({ target: "clip-post" }),
      );
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("keeps the previous bundle when staged clip readiness fails", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-cli-deconstruct-readiness-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      const previousManifest = "{\"generation\":\"old\"}\n";
      const previousPost = "old successful post\n";
      await writeFile(path.join(clipsDir, "clips-manifest.json"), previousManifest, "utf8");
      await writeFile(path.join(clipsDir, "post-1-old.md"), previousPost, "utf8");

      const manifest = {
        v: 1,
        source: { videoId: "readiness-failure", articlePath: "../../../article.md", durationSec: 60 },
        generatedAt: "2026-08-09T00:00:00.000Z",
        candidateCount: 1,
        total: 1,
        clips: [],
      };
      mocks.contentTargetMetadataPathFor.mockImplementation(
        (dir: string, target: string) => dir + "/.content-metadata/" + target + ".json",
      );
      mocks.readContentTargetMetadata.mockResolvedValue(undefined);
      mocks.isContentTargetMetadataFresh.mockResolvedValue(false);
      mocks.readDeconstructArtifacts.mockResolvedValue({
        articleMd: "# Readiness failure",
        srtContent: "",
        videoId: "readiness-failure",
        videoPath: path.join(articleDir, "video", "full.mp4"),
        durationSec: 60,
      });
      mocks.runDeconstruct.mockResolvedValue({
        candidates: { sections: [section] },
        candidateTechnicalTerms: {
          sourceFingerprint: "readiness-candidate-source",
          profileFingerprint: "readiness-candidate-profile",
          discoveryAudit: { promptVersion: "discovery", sourceIdentity: "readiness-audit" },
          requestedModel: "test-model",
          resolvedModel: "test-model",
        },
      });
      mocks.splitOversizedSections.mockReturnValue({ sections: [section] });
      mocks.filterValidSections.mockReturnValue({ sections: [section] });
      mocks.validateClipEndings.mockReturnValue([]);
      mocks.writeDeconstructOutput.mockResolvedValue({
        manifestPath: path.join(articleDir, "staged", "clips-manifest.json"),
        manifest,
        clippedCount: 1,
      });
      mocks.generateClipsPosts.mockResolvedValue({
        postCount: 1,
        postPaths: [],
        manifest,
        technicalTerms: {},
      });
      mocks.selectTopUniqueArticleSections.mockReturnValue([{ section, originalIndex: 0 }]);
      mocks.applyClipSelection.mockReturnValue({ manifest, kept: 1, removed: 0 });
      mocks.writeSelectedPostFiles.mockResolvedValue([path.join(articleDir, "staged", "post-1-new.md")]);
      mocks.clipCandidates.mockResolvedValue([{ success: true, candidate: section }]);
      mocks.assertClipPublishReadiness.mockRejectedValue(new Error("staged readiness failed"));

      await expect(runDeconstructCommand(articleDir, 1)).resolves.toBe(1);

      await expect(readFile(path.join(clipsDir, "clips-manifest.json"), "utf8")).resolves.toBe(previousManifest);
      await expect(readFile(path.join(clipsDir, "post-1-old.md"), "utf8")).resolves.toBe(previousPost);
      expect(mocks.assertClipPublishReadiness).toHaveBeenCalledWith(expect.stringContaining(".deconstruct-stage-"));
      expect(mocks.replaceDirectoryAtomically).not.toHaveBeenCalled();
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });
});
