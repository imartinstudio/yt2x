import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DeconstructManifest, SectionCandidate } from "@yt2x/core";
import { writeDeconstructOutput } from "./file-store.js";

const candidate: SectionCandidate = {
  id: "section-1",
  title: "检索结构",
  summary: "Knowledge Graph 负责结构化检索。",
  article_section: "检索章节",
  angle: "tutorial",
  risk: "low",
  timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
  scores: {
    counter_intuitiveness: 3,
    shareability: 3,
    practical_value: 4,
    visual_appeal: 2,
    composite: 3,
  },
  key_quote: "Graph 不是图片。",
  video_script: "画面演示 Agent Graph 的节点连接。",
};

describe("writeDeconstructOutput", () => {
  it("can prepare a manifest without replacing an existing manifest", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-deconstruct-staged-manifest-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      const previousManifest = "{\"previous\":true}\n";
      await mkdir(clipsDir, { recursive: true });
      await writeFile(path.join(clipsDir, "clips-manifest.json"), previousManifest, "utf8");

      const result = await writeDeconstructOutput(
        articleDir,
        [candidate],
        "staged-manifest",
        path.join(articleDir, "full.mp4"),
        60,
        "# 技术文章",
        { persist: false, cacheContract: "cli" },
      );

      expect(result.manifest.clips).toHaveLength(1);
      expect(await readFile(result.manifestPath, "utf8")).toBe(previousManifest);
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("persists the original candidate source fields and matching article body", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-deconstruct-source-context-"));
    try {
      const articleMd = "# 技术文章\n\n## 检索章节\n\nContext Engineering 决定检索边界。\n\n## 下一章\n\n无关正文。";
      const result = await writeDeconstructOutput(
        articleDir,
        [candidate],
        "source-context",
        path.join(articleDir, "full.mp4"),
        60,
        articleMd,
      );
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as DeconstructManifest;

      expect(manifest.clips[0]!.sourceContext).toEqual({
        title: "检索结构",
        summary: "Knowledge Graph 负责结构化检索。",
        keyQuote: "Graph 不是图片。",
        videoScript: "画面演示 Agent Graph 的节点连接。",
        articleSection: "检索章节",
        articleBody: "## 检索章节\n\nContext Engineering 决定检索边界。\n",
      });
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });
});
