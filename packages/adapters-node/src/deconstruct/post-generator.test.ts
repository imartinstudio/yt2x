import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DeconstructManifest, LlmPort } from "@yt2x/core";
import { generateClipsPosts } from "./post-generator.js";

describe("generateClipsPosts", () => {
  it("writes clip posts with Martin AI Coding Workflow 4-segment format", async () => {
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
                title: "我被 2GB 显存的模型上了一课",
                conflict: "本来觉得 2GB 显存能干什么？跑个 embeddings 都费劲。结果它开始处理一个完整的网页项目。",
                what_happened: "它打开浏览器、读取设计稿、生成组件代码——每一步都是自动的。86 秒，一个完整的页面出现在屏幕上。",
                conclusion: "参数大小不是瓶颈，什么时候该用它才是。",
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
      // Series title line with new format
      expect(postText).toContain("🎬 我被 2GB 显存的模型上了一课｜1/1");
      // 4-segment structure — no hashtags, no teaser
      expect(postText).toContain("本来觉得 2GB 显存能干什么？");
      expect(postText).toContain("它打开浏览器、读取设计稿、生成组件代码");
      expect(postText).toContain("参数大小不是瓶颈");
      expect(postText).not.toContain("#ClaudeCode");

      // Manifest updated
      const updatedManifest = JSON.parse(
        await readFile(path.join(clipsDir, "clips-manifest.json"), "utf8"),
      ) as DeconstructManifest;
      expect(updatedManifest.clips[0]!.text?.startsWith("🎬 我被 2GB 显存的模型上了一课｜1/1")).toBe(true);
      expect(updatedManifest.clips[0]!.postTitle).toBe("我被 2GB 显存的模型上了一课");
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });
});
