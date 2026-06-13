import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DeconstructManifest, LlmPort } from "@yt2x/core";
import { generateClipsPosts } from "./post-generator.js";

describe("generateClipsPosts", () => {
  it("writes clip posts with the global semantic title format", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-posts-"));
    try {
      const clipsDir = path.join(articleDir, "clips");
      await mkdir(clipsDir);
      await writeFile(
        path.join(articleDir, "article.md"),
        "# Claude Code 从 0 到 1 全攻略：90% 的用户只用了 10% 的功能\n\n正文",
        "utf8",
      );

      const manifest: DeconstructManifest = {
        v: 1,
        source: {
          videoId: "video123",
          articlePath: "../article.md",
          durationSec: 600,
        },
        generatedAt: "2026-06-12T00:00:00.000Z",
        candidateCount: 1,
        total: 1,
        clips: [
          {
            id: "clip-1",
            slug: "intro",
            title: "开场爆论",
            type: "hot-take",
            angle: "contrarian",
            risk: "low",
            selected: true,
            timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
            video: "clip-1-intro.mp4",
            scores: {
              counter_intuitiveness: 5,
              shareability: 5,
              practical_value: 4,
              visual_appeal: 4,
              composite: 4.5,
            },
            articleSection: "开场章节",
          },
        ],
      };
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

      const llm: LlmPort = {
        chat: async () => ({
          content: JSON.stringify({
            posts: [
              {
                first_line: "你以为 Claude Code 只能写网页？",
                body: "这里展示的是完整工作流，不是单点技巧。",
                teaser_next: "完整长文 👇",
                hashtags: "#ClaudeCode #AI编程",
              },
            ],
          }),
          model: "test-model",
          finishReason: "stop",
        }),
      };

      const result = await generateClipsPosts({ llm, model: "test-model", articleDir });
      expect(result.postCount).toBe(1);

      const postText = await readFile(result.postPaths[0]!, "utf8");
      expect(postText).toContain("🎬 Claude Code 从 0 到 1 全攻略：开场爆论 | 1/1");

      const updatedManifest = JSON.parse(await readFile(path.join(clipsDir, "clips-manifest.json"), "utf8")) as DeconstructManifest;
      expect(updatedManifest.clips[0]!.text?.startsWith("🎬 Claude Code 从 0 到 1 全攻略：开场爆论 | 1/1")).toBe(true);
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });
});
