import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTechnicalTermGuard, type DeconstructManifest, type LlmPort } from "@yt2x/core";
import { technicalTermDiscoveryAuditFor } from "../technical-terms/discovery.js";
import {
  CONTENT_PROMPT_VERSIONS,
  contentSourceFingerprintFor,
  contentTargetMetadataPathFor,
  createContentTargetMetadata,
  writeContentTargetMetadata,
} from "../content-cache.js";
import { writeDeconstructOutput } from "./file-store.js";
import { generateClipsPosts, writeSelectedPostFiles } from "./post-generator.js";

describe("generateClipsPosts", () => {
  it("derives final term filtering from the active profile instead of a Graph allowlist", async () => {
    const implementation = await readFile(new URL("./post-generator.ts", import.meta.url), "utf8");

    expect(implementation).not.toMatch(/violation\.canonical\s*===\s*["']Graph["']/u);
    expect(implementation).not.toMatch(/violation\.canonical\s*===\s*["']Knowledge Graph["']/u);
    expect(implementation).not.toMatch(/violation\.canonical\s*===\s*["']Agent Graph["']/u);
  });

  it("keeps the previous manifest and selected post bytes when final validation fails", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-atomic-failure-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      const previousManifest = JSON.stringify({
        v: 1,
        source: { videoId: "atomic-failure", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-06-12T00:00:00.000Z",
        candidateCount: 1,
        clips: [{
          id: "clip-1",
          slug: "atomic",
          title: "Knowledge Graph",
          type: "insight",
          angle: "tutorial",
          risk: "low",
          selected: true,
          text: "Knowledge Graph 的旧成功文案。",
          timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
          video: "clip-1-atomic.mp4",
        }],
      }, null, 2) + "\n";
      const previousPost = "旧成功帖子\n";
      await writeFile(path.join(clipsDir, "clips-manifest.json"), previousManifest, "utf8");
      await writeFile(path.join(clipsDir, "post-1-atomic.md"), previousPost, "utf8");

      const manifest = JSON.parse(previousManifest) as DeconstructManifest;
      manifest.clips[0]!.text = "知识图谱的错误新文案。";
      const guard = createTechnicalTermGuard({ sourceText: "Knowledge Graph" });

      await expect(writeSelectedPostFiles(manifest, articleDir, {
        guard,
        restoration: { placeholders: [] },
        articleTitle: "Knowledge Graph",
        discoveredTerms: [],
        sourceTextByClipId: { "clip-1": "Knowledge Graph" },
      })).rejects.toThrow(/Knowledge Graph/u);

      await expect(readFile(path.join(clipsDir, "clips-manifest.json"), "utf8"))
        .resolves.toBe(previousManifest);
      await expect(readFile(path.join(clipsDir, "post-1-atomic.md"), "utf8"))
        .resolves.toBe(previousPost);
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("can generate posts from an in-memory manifest without replacing the persisted one", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-staged-generation-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      await writeFile(path.join(articleDir, "article.md"), "# 标题\n\n正文。", "utf8");
      const previousManifest = "{\"previous\":true}\n";
      await writeFile(path.join(clipsDir, "clips-manifest.json"), previousManifest, "utf8");
      const manifest: DeconstructManifest = {
        v: 1,
        source: { videoId: "staged-generation", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-06-12T00:00:00.000Z",
        candidateCount: 1,
        total: 1,
        clips: [{
          id: "clip-1",
          slug: "staged",
          title: "片段",
          type: "insight",
          angle: "tutorial",
          risk: "low",
          selected: false,
          timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
          video: "clip-1-staged.mp4",
        }],
      };
      const responses = [
        "[]",
        JSON.stringify({
          posts: [{
            title: "片段标题",
            opening_quote: "一句引语",
            core_description: "一段描述",
            video_suggestion: "一个画面",
          }],
        }),
      ];
      const llm: LlmPort = {
        chat: async () => ({ content: responses.shift()!, model: "test-model", finishReason: "stop" }),
      };

      const result = await generateClipsPosts({
        llm,
        model: "test-model",
        articleDir,
        manifest,
        persist: false,
        cacheContract: "cli",
      });

      expect(result.manifest.clips[0]!.text).toContain("一句引语");
      expect(result.postPaths).toEqual([]);
      expect(await readFile(path.join(clipsDir, "clips-manifest.json"), "utf8")).toBe(previousManifest);
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("reuses clip posts only when profile-aware metadata matches without calling the provider", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-cache-hit-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      const articleMd = "# 标题\n\n正文。";
      await writeFile(path.join(articleDir, "article.md"), articleMd, "utf8");
      const manifest: DeconstructManifest = {
        v: 1,
        source: { videoId: "cache-hit", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-06-12T00:00:00.000Z",
        candidateCount: 1,
        total: 1,
        clips: [{
          id: "clip-1",
          slug: "cached",
          title: "片段",
          type: "insight",
          angle: "tutorial",
          risk: "low",
          selected: true,
          text: "旧成功帖子。",
          timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
          video: "clip-1-cached.mp4",
          articleSection: "章节",
        }],
      };
      const clips = [{
        id: "clip-1",
        title: "片段",
        summary: "片段",
        angle: "tutorial",
        timecodes: { durationSec: 60 },
        video: "clip-1-cached.mp4",
      }];
      const sourceText = `${articleMd}\n${JSON.stringify(clips)}`;
      const audit = technicalTermDiscoveryAuditFor(
        { accepted: [], reviewCandidates: [], warnings: [] },
        { sourceText, sourceTitle: "标题" },
      );
      const finalSourceText = [
        "标题",
        "片段\n章节",
        "先看视频，再阅读下方完整/分步指南，学习如何为你的 Agents 构建 loops。",
      ].join("\n");
      const guard = createTechnicalTermGuard({ sourceText: finalSourceText, sourceTitle: "标题", discovery: audit });
      const metadataPath = contentTargetMetadataPathFor(articleDir, "clip-post");
      await writeContentTargetMetadata(metadataPath, createContentTargetMetadata({
        target: "clip-post",
        sourceFingerprint: contentSourceFingerprintFor({ articleTitle: "标题", articleMd, clips }),
        model: "test-model",
        promptVersion: CONTENT_PROMPT_VERSIONS.clipPost,
        technicalTermProfileFingerprint: guard.profile.profileFingerprint,
        technicalTermDiscovery: audit,
      }));
      const postPath = path.join(clipsDir, "post-1-cached.md");
      await writeFile(postPath, "旧成功帖子。\n", "utf8");
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest), "utf8");

      const provider = {
        chat: async (): Promise<never> => {
          throw new Error("provider must not be called on a cache hit");
        },
      } satisfies LlmPort;
      const result = await generateClipsPosts({ llm: provider, model: "test-model", articleDir });

      expect(result.postPaths).toEqual([postPath]);
      expect(result.postCount).toBe(1);
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("writes clip posts with quote, loops leverage, video suggestion, and CTA", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-posts-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      await writeFile(
        path.join(articleDir, "article.md"),
        "# Graph Engineering（图工程）从 0 到 1 全攻略\n\n## 开场章节\n\nGraph Engineering 是正文术语，Agents 也会运行 loop。\n\n## 风险章节\n\nKnowledge Graph 和 Agent Graph 是风险章节术语，完整视频来自 youtube。",
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
                opening_quote: "「未来属于把 agents 变成 loops 的团队。」——输入素材中的工程师",
                core_description: "图工程的杠杆不是更大的模型，而是围绕它的 loop：评估、重试、上下文和部署反馈。这就是一个 agent 从好看的 demo 变成每天 20-40 个 PR 的方式。Agents 需要持续验证。",
                video_suggestion: "视频里可以看到，agent 盯住 CI、修复失败，再打开下一个 PR。",
              },
              {
                title: "边界决定可靠性",
                opening_quote: "每个 loop 都有边界。知道哪里会断，比知道哪里能跑更重要。",
                core_description: "知识图谱和代理图谱的风险不在概念，而在兼容性、API 稳定性和响应延迟。可靠的 agent loop 必须处理重试、降级和人工 review。",
                video_suggestion: "YouTube 视频里可以看到，模型超时后 agent 自动重试、切到备用模型，并通知 Agents 人工介入。",
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
      expect(firstBodyLine).toBe("「未来属于把 Agents 变成 loops 的团队。」——输入素材中的工程师");
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
      expect(postText).not.toContain("先看视频，再阅读下方完整/分步指南，学习如何为你的 Agents 构建 loops。");
      expect(secondPostText).toContain("先看视频，再阅读下方完整/分步指南，学习如何为你的 Agents 构建 loops。");
      expect(postText).not.toContain("youtube.com/watch?v=");
      expect(secondPostText).toContain("https://www.youtube.com/watch?v=video123");
      expect(postText).not.toContain("#ClaudeCode");

      // Manifest updated
      const updatedManifest = JSON.parse(
        await readFile(path.join(clipsDir, "clips-manifest.json"), "utf8"),
      ) as DeconstructManifest;
      expect(updatedManifest.clips[0]!.text?.startsWith("「未来属于把 Agents 变成 loops 的团队。」")).toBe(true);
      expect(updatedManifest.clips[0]!.text).not.toContain("先看视频，再阅读下方完整/分步指南，学习如何为你的 Agents 构建 loops。");
      expect(updatedManifest.clips[1]!.text).toContain("先看视频，再阅读下方完整/分步指南，学习如何为你的 Agents 构建 loops。");
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

      const guard = createTechnicalTermGuard({
        sourceText: "Graph Engineering 与 Agents\nYouTube",
      });
      const result = await writeSelectedPostFiles(manifest, articleDir, {
        guard,
        restoration: { placeholders: [] },
        articleTitle: "Graph Engineering 与 Agents",
        discoveredTerms: [],
        sourceTextByClipId: { "clip-1": "Graph Engineering 应保留 canonical 原文。" },
      });
      const postText = await readFile(result[0]!, "utf8");

      expect(postText).toContain("Graph Engineering");
      expect(postText).not.toContain("图工程");
      expect(postText).toContain("学习如何为你的 Agents 构建 loops。");
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("rejects Graph translated as 图 when Graph only appears in the selected source body", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-selected-graph-body-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      const manifest: DeconstructManifest = {
        v: 1,
        source: { videoId: "selected-graph-body", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-06-12T00:00:00.000Z",
        candidateCount: 1,
        total: 1,
        clips: [{
          id: "clip-1",
          slug: "selected-graph-body",
          title: "构建关系结构",
          type: "hot-take",
          angle: "contrarian",
          risk: "low",
          selected: true,
          text: "图能让 agent 看见依赖关系。",
          timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
          video: "clip-1-selected-graph-body.mp4",
        }],
      };
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest), "utf8");
      const guard = createTechnicalTermGuard({ sourceText: "Graph\nAgents" });

      await expect(writeSelectedPostFiles(manifest, articleDir, {
        guard,
        restoration: { placeholders: [] },
        articleTitle: "构建关系结构",
        discoveredTerms: [],
        sourceTextByClipId: { "clip-1": "Graph 能让 agent 看见依赖关系。" },
      })).rejects.toThrow("输出使用了 图，应保留 Graph");

      await expect(readFile(path.join(clipsDir, "post-1-selected-graph-body.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["translated", "知识图谱能提高检索质量。", "输出使用了 知识图谱，应保留 Knowledge Graph"],
    ["missing", "这种结构能提高检索质量。", "输出缺少源术语 Knowledge Graph"],
  ])("rejects %s Knowledge Graph from the selected source body", async (_case, generatedText, expectedError) => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-selected-knowledge-graph-body-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      const manifest: DeconstructManifest = {
        v: 1,
        source: { videoId: "selected-knowledge-graph-body", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-06-12T00:00:00.000Z",
        candidateCount: 1,
        total: 1,
        clips: [{
          id: "clip-1",
          slug: "selected-knowledge-graph-body",
          title: "检索结构",
          type: "insight",
          angle: "tutorial",
          risk: "low",
          selected: true,
          text: generatedText,
          timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
          video: "clip-1-selected-knowledge-graph-body.mp4",
        }],
      };
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest), "utf8");
      const guard = createTechnicalTermGuard({ sourceText: "Knowledge Graph\nAgents" });

      await expect(writeSelectedPostFiles(manifest, articleDir, {
        guard,
        restoration: { placeholders: [] },
        articleTitle: "检索结构",
        discoveredTerms: [],
        sourceTextByClipId: { "clip-1": "Knowledge Graph 能提高检索质量。" },
      })).rejects.toThrow(expectedError);

      await expect(readFile(path.join(clipsDir, "post-1-selected-knowledge-graph-body.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("rejects the final selected post when a discovered source term is missing", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-final-missing-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      const manifest: DeconstructManifest = {
        v: 1,
        source: { videoId: "final-missing", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-06-12T00:00:00.000Z",
        candidateCount: 1,
        total: 1,
        clips: [{
          id: "clip-1",
          slug: "final-missing",
          title: "Latent Workspace Routing",
          type: "hot-take",
          angle: "contrarian",
          risk: "low",
          selected: true,
          text: "这里只保留普通正文。",
          timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
          video: "clip-1-final-missing.mp4",
        }],
      };
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest), "utf8");
      const discoveredTerms = [{
        sourceText: "Latent Workspace Routing",
        confidence: "high" as const,
        category: "ai-agent" as const,
      }];
      const guard = createTechnicalTermGuard({
        sourceText: "Latent Workspace Routing\nAgents\nYouTube",
        discoveredTerms,
      });

      await expect(writeSelectedPostFiles(manifest, articleDir, {
        guard,
        restoration: { placeholders: [] },
        articleTitle: "可靠交付",
        discoveredTerms,
        sourceTextByClipId: { "clip-1": "Latent Workspace Routing" },
      })).rejects.toThrow(/Latent Workspace Routing/u);

      await expect(readFile(path.join(clipsDir, "post-1-final-missing.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("does not require a discovered term that only belongs to an unselected clip", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-selected-scope-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      const manifest: DeconstructManifest = {
        v: 1,
        source: { videoId: "selected-scope", articlePath: "../article.md", durationSec: 120 },
        generatedAt: "2026-06-12T00:00:00.000Z",
        candidateCount: 2,
        total: 2,
        clips: [{
          id: "clip-1",
          slug: "selected",
          title: "可靠交付",
          type: "hot-take",
          angle: "contrarian",
          risk: "low",
          selected: true,
          text: "这里只讨论可靠交付。",
          timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
          video: "clip-1-selected.mp4",
        }, {
          id: "clip-2",
          slug: "unselected",
          title: "Archive Memory Routing",
          type: "insight",
          angle: "tutorial",
          risk: "low",
          selected: false,
          text: "Archive Memory Routing 只属于未选片段。",
          timecodes: { start: "00:01:02", end: "00:02:02", startSec: 62, endSec: 122, durationSec: 60 },
          video: "clip-2-unselected.mp4",
        }],
      };
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest), "utf8");
      const discoveredTerms = [{
        sourceText: "Archive Memory Routing",
        confidence: "high" as const,
        category: "ai-agent" as const,
      }];
      const guard = createTechnicalTermGuard({
        sourceText: "可靠交付\nArchive Memory Routing\nAgents\nYouTube",
        discoveredTerms,
      });

      const result = await writeSelectedPostFiles(manifest, articleDir, {
        guard,
        restoration: { placeholders: [] },
        articleTitle: "可靠交付",
        discoveredTerms,
        sourceTextByClipId: {
          "clip-1": "这里只讨论可靠交付。",
          "clip-2": "Archive Memory Routing 只属于未选片段。",
        },
      });

      expect(await readFile(result[0]!, "utf8")).toContain("这里只讨论可靠交付。");
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("rejects a translated discovered term in a selected clip", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-selected-translation-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      const manifest: DeconstructManifest = {
        v: 1,
        source: { videoId: "selected-translation", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-06-12T00:00:00.000Z",
        candidateCount: 1,
        total: 1,
        clips: [{
          id: "clip-1",
          slug: "selected-translation",
          title: "Latent Workspace Routing",
          type: "hot-take",
          angle: "contrarian",
          risk: "low",
          selected: true,
          text: "潜在工作区路由能减少上下文漂移。",
          timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
          video: "clip-1-selected-translation.mp4",
        }],
      };
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest), "utf8");
      const discoveredTerms = [{
        sourceText: "Latent Workspace Routing",
        confidence: "high" as const,
        category: "ai-agent" as const,
      }];
      const guard = createTechnicalTermGuard({
        sourceText: "Latent Workspace Routing\nAgents\nYouTube",
        discoveredTerms,
      });

      await expect(writeSelectedPostFiles(manifest, articleDir, {
        guard,
        restoration: { placeholders: [] },
        articleTitle: "可靠交付",
        discoveredTerms,
        sourceTextByClipId: { "clip-1": "Latent Workspace Routing" },
      })).rejects.toThrow(/Latent Workspace Routing/u);

      await expect(readFile(path.join(clipsDir, "post-1-selected-translation.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["summary", "Knowledge Graph", "知识图谱能提高检索质量。", "输出使用了 知识图谱，应保留 Knowledge Graph"],
    ["key_quote", "Graph", "图能表达节点关系。", "输出使用了 图，应保留 Graph"],
    ["video_script", "Agent Graph", "代理图谱展示了调用链。", "输出使用了 代理图谱，应保留 Agent Graph"],
  ])("activates a selected term persisted only in %s", async (field, term, generatedText, expectedError) => {
    const articleDir = await mkdtemp(path.join(tmpdir(), `yt2x-clips-persisted-${field}-`));
    try {
      const selectedCandidate = {
        id: "section-1",
        title: "可靠检索",
        summary: field === "summary" ? `${term} 负责检索。` : "普通摘要。",
        article_section: "可靠检索",
        angle: "tutorial" as const,
        risk: "low" as const,
        timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
        scores: {
          counter_intuitiveness: 3,
          shareability: 3,
          practical_value: 4,
          visual_appeal: 2,
          composite: 3,
        },
        key_quote: field === "key_quote" ? `${term} 不是普通图片。` : "普通引语。",
        video_script: field === "video_script" ? `画面展示 ${term}。` : "普通画面。",
      };
      const output = await writeDeconstructOutput(
        articleDir,
        [selectedCandidate],
        `persisted-${field}`,
        path.join(articleDir, "full.mp4"),
        60,
        "# 可靠检索\n\n## 可靠检索\n\n普通正文。",
      );
      const manifest = JSON.parse(await readFile(output.manifestPath, "utf8")) as DeconstructManifest;
      manifest.clips[0]!.selected = true;
      manifest.clips[0]!.text = generatedText;
      const guard = createTechnicalTermGuard({
        sourceText: `${term}\nAgents`,
      });

      await expect(writeSelectedPostFiles(manifest, articleDir, {
        guard,
        restoration: { placeholders: [] },
        articleTitle: "可靠检索",
        discoveredTerms: [],
      })).rejects.toThrow(expectedError);
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("does not activate a persisted term that only belongs to an unselected clip", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-persisted-unselected-"));
    try {
      const baseCandidate = {
        article_section: "可靠检索",
        angle: "tutorial" as const,
        risk: "low" as const,
        timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
        scores: {
          counter_intuitiveness: 3,
          shareability: 3,
          practical_value: 4,
          visual_appeal: 2,
          composite: 3,
        },
        key_quote: "普通引语。",
        video_script: "普通画面。",
      };
      const output = await writeDeconstructOutput(
        articleDir,
        [{ ...baseCandidate, id: "section-1", title: "选中片段", summary: "普通摘要。" }, {
          ...baseCandidate,
          id: "section-2",
          title: "未选片段",
          summary: "Archive Memory Routing 只属于未选片段。",
        }],
        "persisted-unselected",
        path.join(articleDir, "full.mp4"),
        120,
        "# 可靠检索\n\n## 可靠检索\n\n普通正文。",
      );
      const manifest = JSON.parse(await readFile(output.manifestPath, "utf8")) as DeconstructManifest;
      manifest.clips[0]!.selected = true;
      manifest.clips[0]!.text = "这里只讨论可靠检索。";
      manifest.clips[1]!.selected = false;
      manifest.clips[1]!.text = "Archive Memory Routing 只属于未选片段。";
      const discoveredTerms = [{
        sourceText: "Archive Memory Routing",
        confidence: "high" as const,
        category: "ai-agent" as const,
      }];
      const guard = createTechnicalTermGuard({
        sourceText: "普通摘要。\nArchive Memory Routing\nAgents",
        discoveredTerms,
      });

      const paths = await writeSelectedPostFiles(manifest, articleDir, {
        guard,
        restoration: { placeholders: [] },
        articleTitle: "可靠检索",
        discoveredTerms,
      });

      expect(await readFile(paths[0]!, "utf8")).toContain("这里只讨论可靠检索。");
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("falls back safely for an old manifest without persisted source context", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-legacy-source-fallback-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      const manifest: DeconstructManifest = {
        v: 1,
        source: { videoId: "legacy-source-fallback", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-06-12T00:00:00.000Z",
        candidateCount: 1,
        clips: [{
          id: "clip-1",
          slug: "legacy",
          title: "旧片段",
          type: "insight",
          angle: "tutorial",
          risk: "low",
          selected: true,
          text: "这里只保留旧格式正文。",
          timecodes: { start: "00:00:01", end: "00:01:01", startSec: 1, endSec: 61, durationSec: 60 },
          video: "clip-1-legacy.mp4",
          articleSection: "旧章节",
        }],
      };
      await writeFile(path.join(clipsDir, "clips-manifest.json"), JSON.stringify(manifest), "utf8");
      const guard = createTechnicalTermGuard({ sourceText: "旧片段\n旧章节\nAgents" });

      const paths = await writeSelectedPostFiles(manifest, articleDir, {
        guard,
        restoration: { placeholders: [] },
        articleTitle: "旧文章",
        discoveredTerms: [],
      });

      expect(await readFile(paths[0]!, "utf8")).toContain("这里只保留旧格式正文。");
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });

  it("keeps the old direct bundle readable when the generation commit is interrupted", async () => {
    const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-clips-direct-atomic-"));
    try {
      const clipsDir = path.join(articleDir, "x-format", "clips");
      await mkdir(clipsDir, { recursive: true });
      const oldManifest = "{\"generation\":\"old\"}\n";
      const oldPost = "old post\n";
      const oldMetadata = "{\"generation\":\"old\"}\n";
      await writeFile(path.join(clipsDir, "clips-manifest.json"), oldManifest, "utf8");
      await writeFile(path.join(clipsDir, "post-1-old.md"), oldPost, "utf8");
      await mkdir(path.join(clipsDir, ".content-metadata"), { recursive: true });
      await writeFile(path.join(clipsDir, ".content-metadata", "clip-post.json"), oldMetadata, "utf8");
      const manifest: DeconstructManifest = {
        v: 1,
        source: { videoId: "direct-atomic", articlePath: "../article.md", durationSec: 60 },
        generatedAt: "2026-08-09T00:00:00.000Z",
        candidateCount: 1,
        clips: [{
          id: "clip-1",
          slug: "new",
          title: "新片段",
          type: "insight",
          angle: "tutorial",
          risk: "low",
          selected: true,
          text: "新文案。",
          timecodes: { start: "00:00:01", end: "00:00:11", startSec: 1, endSec: 11, durationSec: 10 },
          video: "clip-1-new.mp4",
        }],
      };
      const guard = createTechnicalTermGuard({ sourceText: "新片段" });

      await expect(writeSelectedPostFiles(manifest, articleDir, {
        guard,
        restoration: { placeholders: [] },
        articleTitle: "新文章",
        discoveredTerms: [],
        sourceFingerprint: "sha256-new-source",
        profileFingerprint: guard.profile.profileFingerprint,
        discoveryAudit: {
          promptVersion: "technical-term-discovery-v1",
          sourceIdentity: "sha256-new-source",
          acceptedCandidates: [],
          reviewCandidates: [],
          warnings: [],
        },
        requestedModel: "requested-model",
        resolvedModel: "resolved-model",
        promptVersion: "native-clip-post-v2",
      }, {
        commit: async () => { throw new Error("commit interrupted"); },
      })).rejects.toThrow("commit interrupted");

      await expect(readFile(path.join(clipsDir, "clips-manifest.json"), "utf8")).resolves.toBe(oldManifest);
      await expect(readFile(path.join(clipsDir, "post-1-old.md"), "utf8")).resolves.toBe(oldPost);
      await expect(readFile(path.join(clipsDir, ".content-metadata", "clip-post.json"), "utf8")).resolves.toBe(oldMetadata);
      await expect(readFile(path.join(clipsDir, "post-1-new.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });
});
