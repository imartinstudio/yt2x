import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DeconstructManifest, LlmPort } from "@yt2x/core";
import { generateClipsPosts, writeSelectedPostFiles } from "./post-generator.js";

describe("generateClipsPosts", () => {
  it("writes clip posts with quote, loops leverage, video suggestion, and CTA", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-posts-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      await writeFile(
        path.join(articleDir, "article.md"),
        "# Graph Engineering（图工程）从 0 到 1 全攻略\n\n知识图谱（Knowledge Graph）和代理图谱（Agent Graph）是正文术语。Agents 也会运行 loop。",
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
          {
            id: "clip-2",
            slug: "risk",
            title: "风险边界",
            type: "practical-tip",
            angle: "risk",
            risk: "medium",
            selected: true,
            timecodes: { start: "00:01:02", end: "00:02:02", startSec: 62, endSec: 122, durationSec: 60 },
            video: "clip-2-risk.mp4",
            scores: {
              counter_intuitiveness: 4,
              shareability: 4,
              practical_value: 5,
              visual_appeal: 4,
              composite: 4.25,
            },
            articleSection: "风险章节",
          },
        ],
      };
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

      const responses = [
        "[]",
        JSON.stringify({
            posts: [
              {
                title: "Loops 才是优势",
                opening_quote: "「未来属于把 agents 变成 loops 的团队。」——输入素材中的 OpenAI 工程师",
                core_description: "图工程的杠杆不是更大的模型，而是围绕它的 loop：评估、重试、上下文和部署反馈。这就是一个 agent 从好看的 demo 变成每天 20-40 个 PR 的方式。Agents 需要持续验证。",
                video_suggestion: "视频里可以看到，agent 盯住 CI、修复失败，再打开下一个 PR。",
              },
              {
                title: "边界决定可靠性",
                opening_quote: "每个 loop 都有边界。知道哪里会断，比知道哪里能跑更重要。",
                core_description: "知识图谱和代理图谱的风险不在概念，而在兼容性、API 稳定性和响应延迟。可靠的 agent loop 必须处理重试、降级和人工 review。",
                video_suggestion: "视频里可以看到，模型超时后 agent 自动重试、切到备用模型，并通知 Agents 人工介入。",
              },
            ],
        }),
      ];
      const llm: LlmPort = {
        chat: async () => ({
          content: responses.shift()!,
          model: "test-model",
          finishReason: "stop",
        }),
      };

      const result = await generateClipsPosts({ llm, model: "test-model", articleDir });
      expect(result.postCount).toBe(2);

      const postText = await readFile(result.postPaths[0]!, "utf8");
      const secondPostText = await readFile(result.postPaths[1]!, "utf8");
      const bodyLines = postText.split("\n").filter((line) => !line.startsWith("---") && !line.includes(": "));
      const firstBodyLine = bodyLines.find((line) => line.trim().length > 0)!;
      // Clip post body starts directly with quote/viewpoint, without a title line.
      expect(postText).not.toContain("\nLoops 才是优势\n");
      expect(firstBodyLine).toBe("「未来属于把 Agents 变成 loops 的团队。」——输入素材中的 OpenAI 工程师");
      expect(firstBodyLine).not.toContain("🎬");
      expect(firstBodyLine).not.toContain("｜1/1");
      // AnatoliKopadze-style structure — no hashtags, no teaser
      expect(postText).toContain("「未来属于把 Agents 变成 loops 的团队。」");
      expect(postText).toContain("每天 20-40 个 PR");
      expect(postText).toContain("Graph Engineering");
      expect(secondPostText).toContain("Knowledge Graph");
      expect(secondPostText).toContain("Agent Graph");
      expect(postText).toContain("视频里可以看到，agent 盯住 CI");
      expect(postText).not.toContain("建议附上");
      expect(postText).not.toContain("先看视频，再阅读下方完整/分步指南，学习如何为你的 agents 构建 loops。");
      expect(secondPostText).toContain("先看视频，再阅读下方完整/分步指南，学习如何为你的 agents 构建 loops。");
      expect(postText).not.toContain("#ClaudeCode");

      // Manifest updated
      const updatedManifest = JSON.parse(
        await readFile(path.join(clipsDir, "clips-manifest.json"), "utf8"),
      ) as DeconstructManifest;
      expect(updatedManifest.clips[0]!.text?.startsWith("「未来属于把 Agents 变成 loops 的团队。」")).toBe(true);
      expect(updatedManifest.clips[0]!.text).not.toContain("先看视频，再阅读下方完整/分步指南，学习如何为你的 agents 构建 loops。");
      expect(updatedManifest.clips[1]!.text).toContain("先看视频，再阅读下方完整/分步指南，学习如何为你的 agents 构建 loops。");
      expect(updatedManifest.clips[0]!.postTitle).toBe("Loops 才是优势");
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("canonicalizes the final selected post after adding the lowercase agents CTA", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-final-term-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      await writeFile(
        path.join(articleDir, "article.md"),
        "# Graph Engineering 与 Agents\n\nGraph Engineering 应保留 canonical 原文。",
        "utf8",
      );
      const manifest: DeconstructManifest = {
        v: 1,
        source: { videoId: "final-term", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-06-12T00:00:00.000Z",
        candidateCount: 1,
        total: 1,
        clips: [{
          id: "clip-1",
          slug: "final-term",
          title: "标题",
          type: "hot-take",
          angle: "contrarian",
          risk: "low",
          selected: true,
          text: "图工程会让工作流更可靠。",
          timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
          video: "clip-1-final-term.mp4",
        }],
      };
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest), "utf8");

      const result = await writeSelectedPostFiles(manifest, articleDir);
      const postText = await readFile(result[0]!, "utf8");

      expect(postText).toContain("Graph Engineering");
      expect(postText).not.toContain("图工程");
      expect(postText).toContain("学习如何为你的 agents 构建 loops。");
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });
});
