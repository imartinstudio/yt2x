import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readDeconstructArtifacts: vi.fn(),
  runDeconstruct: vi.fn(),
  clipCandidates: vi.fn(),
  writeDeconstructOutput: vi.fn(),
  createLlmAdapter: vi.fn(() => ({})),
  selectClips: vi.fn(),
  selectTopUniqueArticleSections: vi.fn(),
  generateClipsPosts: vi.fn(),
  writeSelectedPostFiles: vi.fn(),
  writeReports: vi.fn(),
  assertClipPublishReadiness: vi.fn(),
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
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
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
      };
      mocks.readDeconstructArtifacts.mockResolvedValue({
        articleMd: "# Latent Workspace Routing",
        srtContent: "",
        videoId: "profile-pass",
        videoPath: path.join(articleDir, "video", "full.mp4"),
        durationSec: 60,
      });
      mocks.runDeconstruct.mockResolvedValue({ candidates: { sections: [section] } });
      mocks.splitOversizedSections.mockReturnValue({ sections: [section] });
      mocks.filterValidSections.mockReturnValue({ sections: [section] });
      mocks.validateClipEndings.mockReturnValue([]);
      mocks.writeDeconstructOutput.mockResolvedValue({
        manifestPath: path.join(clipsDir, "clips-manifest.json"),
        clippedCount: 1,
      });
      mocks.generateClipsPosts.mockResolvedValue({ postCount: 1, postPaths: [], technicalTerms });
      mocks.selectTopUniqueArticleSections.mockReturnValue([{ section, originalIndex: 0 }]);
      mocks.writeSelectedPostFiles.mockResolvedValue([path.join(clipsDir, "post-1.md")]);
      mocks.clipCandidates.mockResolvedValue([{ success: true, candidate: section }]);
      mocks.assertClipPublishReadiness.mockResolvedValue({ publishOrder: ["post-1.md"] });
      mocks.writeReports.mockResolvedValue({ decompositionPath: "decomposition.md", reviewPath: "review.md" });

      await expect(runDeconstructCommand(articleDir, 1)).resolves.toBe(0);

      expect(mocks.writeSelectedPostFiles).toHaveBeenCalledWith(
        expect.objectContaining({ source: expect.objectContaining({ videoId: "profile-pass" }) }),
        articleDir,
        technicalTerms,
      );
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });
});
