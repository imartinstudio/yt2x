import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeconstructManifest } from "@yt2x/core";
import { assertClipPublishReadiness, validateClipPublishReadiness } from "./publish-readiness.js";

describe("clip publish readiness", () => {
  let articleDir: string;
  let clipsDir: string;

  beforeEach(async () => {
    articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clip-readiness-"));
    clipsDir = path.join(articleDir, "x-format", "clips");
    await mkdir(clipsDir, { recursive: true });

    const manifest: DeconstructManifest = {
      v: 1,
      source: { videoId: "video123", articlePath: "../../article.md", durationSec: 120 },
      generatedAt: "2026-06-12T00:00:00.000Z",
      candidateCount: 1,
      total: 1,
      clips: [
        {
          id: "clip-1",
          slug: "good",
          title: "好片段",
          type: "insight",
          angle: "tutorial",
          risk: "low",
          selected: true,
          timecodes: { start: "00:00:01", end: "00:00:31", startSec: 1, endSec: 31, durationSec: 30 },
          video: "candidate-1-good.mp4",
          text: "正文\n\n🎬 视频 candidate-1-good.mp4（30s）",
        },
      ],
    };
    await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(path.join(clipsDir, "candidate-1-good.mp4"), "fake video", "utf8");
    await writeFile(
      path.join(clipsDir, "post-1-good.md"),
      "---\nref: clips-manifest.json\nclipId: clip-1\ntype: clip-post\nplatform: x\nseries: 1/1\n---\n\n正文\n\n🎬 视频 candidate-1-good.mp4（30s）\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await import("node:fs/promises").then((fs) => fs.rm(articleDir, { recursive: true, force: true }));
  });

  it("passes when selected posts, series, and videos match the manifest", async () => {
    const result = await validateClipPublishReadiness(articleDir);

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.publishOrder).toEqual([
      { file: "post-1-good.md", clipId: "clip-1", series: "1/1", video: "candidate-1-good.mp4" },
    ]);
  });

  it("blocks duplicate final posts for the same clip id", async () => {
    await writeFile(
      path.join(clipsDir, "post-1-duplicate.md"),
      "---\nref: clips-manifest.json\nclipId: clip-1\ntype: clip-post\nplatform: x\nseries: 1/1\n---\n\n正文\n\n🎬 视频 candidate-1-good.mp4（30s）\n",
      "utf8",
    );

    await expect(assertClipPublishReadiness(articleDir)).rejects.toThrow(
      /duplicate final posts: post-1-duplicate.md, post-1-good.md/,
    );
  });

  it("blocks posts that mention a video file missing from disk", async () => {
    await writeFile(
      path.join(clipsDir, "post-1-good.md"),
      "---\nref: clips-manifest.json\nclipId: clip-1\ntype: clip-post\nplatform: x\nseries: 1/1\n---\n\n正文\n\n🎬 视频 candidate-1-missing.mp4（30s）\n",
      "utf8",
    );

    await expect(assertClipPublishReadiness(articleDir)).rejects.toThrow(
      /mentioned video does not exist: candidate-1-missing.mp4/,
    );
  });
});
