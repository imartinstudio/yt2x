import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AvailableVisual, ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import {
  generateXArticleContent,
  validateArticleTopicHashtags,
  validateArticleVisualPlan,
} from "./generator.js";
import { clearTechnicalTermDiscoveryCaches as clearDiscoveryCaches } from "../technical-terms/discovery.js";
import type { StructuredNotesArtifacts } from "./file-store.js";

const fakeArtifacts: StructuredNotesArtifacts = {
  videoDir: "/tmp/v",
  videoId: "vid",
  structuredNotesMd: "# Notes\n\n- point\n\nCodex",
  metadata: { id: "vid", title: "Hello" },
};

const makeLlm = (
  respond: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>,
  discoveryResponse = "[]",
): LlmPort => ({ chat: vi.fn((req) => Promise.resolve(
  req.messages[0]?.content.includes("术语发现器")
    ? { content: discoveryResponse, model: "m", finishReason: "stop" }
    : respond(req),
)) });

const sampleVisuals: AvailableVisual[] = [
  {
    visual_id: "scene_001",
    path: "screenshots/scene_01.jpg",
    timestamp: "00:01:23",
    nearby_text: "配置界面",
    quality: { blur: "low", has_text: true, has_ui: true, center_presenter: false },
  },
];

describe("generateXArticleContent", () => {
  it("recovers catalog terms in article markdown without demanding the discovered term", async () => {
    const llm = makeLlm(
      (req) => {
        if (req.messages[0]?.content.includes("术语定向修复器")) {
          const current = req.messages[1]?.content.match(/Current value:\n([\s\S]*?)\n\n只输出修复后的值/u)?.[1] ?? "";
          return {
            content: current.replace("潜在工作区路由", "Latent Workspace Routing"),
            model: "m",
            finishReason: "stop",
          };
        }
        return {
          content: "# 标题\n\n提示工程、上下文工程和图工程会连接知识图谱与代理图谱，潜在工作区路由也很重要。图片、图表和图文不应误报。\n\n#AI #Agent #Workflow",
          model: "m",
          finishReason: "stop",
        };
      },
      JSON.stringify([{ sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" }]),
    );
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      videoId: "article-term-guard",
      structuredNotesMd: "# Prompt Engineering\n\nPrompt Engineering、Context Engineering、Graph Engineering、Knowledge Graph、Agent Graph、Latent Workspace Routing",
      metadata: { id: "article-term-guard", title: "Prompt Engineering" },
    };

    const result = await generateXArticleContent({ llm, model: "task3-article", artifacts });

    expect(result.content).toContain("Prompt Engineering");
    expect(result.content).toContain("Knowledge Graph");
    expect(result.content).toContain("图片、图表和图文");
    expect(result.content).not.toContain("提示工程、上下文工程和图工程");
    expect(result.technicalTermProfileFingerprint).toMatch(/^sha256-[0-9a-f]{64}$/u);
    // 发现词只保护不强制：不再为它跑修复回合
    expect(result.content).toContain("潜在工作区路由");
    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(result.technicalTermDiscovery).toMatchObject({
      promptVersion: expect.any(String),
      sourceIdentity: expect.stringMatching(/^sha256-[0-9a-f]{64}$/u),
      acceptedCandidates: expect.any(Array),
      reviewCandidates: expect.any(Array),
      warnings: expect.any(Array),
    });
  });

  it("keeps a detailed-note term optional but still rejects its forbidden translation", async () => {
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: [
        "# Graph Engineering",
        "## Executive Summary",
        "Graph Engineering is the main idea.",
        "## Detailed Notes",
        "Context Engineering is a detailed long-form section.",
      ].join("\n"),
      metadata: { id: "article-summary-scope", title: "Graph Engineering" },
    };

    const omittingLlm = makeLlm(() => ({
      content: "# 标题\n\nGraph Engineering 摘要。\n\n#AI #Agent #Workflow",
      model: "m",
      finishReason: "stop",
    }));
    const result = await generateXArticleContent({ llm: omittingLlm, model: "m", artifacts });
    expect(result.content).toContain("Graph Engineering");
    expect(omittingLlm.chat).toHaveBeenCalledTimes(2);

    const translatingLlm = makeLlm(() => ({
      content: "# 标题\n\nGraph Engineering 摘要与上下文工程。\n\n#AI #Agent #Workflow",
      model: "m",
      finishReason: "stop",
    }));
    await expect(generateXArticleContent({ llm: translatingLlm, model: "m", artifacts })).rejects.toThrow(
      "Context Engineering",
    );
    // discovery 已被上一轮缓存，这两次是正文生成 + 一次定向修复尝试
    expect(translatingLlm.chat).toHaveBeenCalledTimes(2);
  });

  it("uses the target-side persistent discovery cache after a cold in-memory restart", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "yt2x-article-term-cache-"));
    try {
      const artifacts: StructuredNotesArtifacts = {
        ...fakeArtifacts,
        videoId: "article-cold-cache",
        structuredNotesMd: "# Latent Workspace Routing\n\nLatent Workspace Routing keeps agent state.",
        metadata: { id: "article-cold-cache", title: "Latent Workspace Routing" },
      };
      const firstLlm = makeLlm(
        () => ({ content: "# 标题\n\n正文\n\n#AI #Agent #Workflow", model: "m", finishReason: "stop" }),
        JSON.stringify([{ sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" }]),
      );
      await generateXArticleContent({
        llm: firstLlm,
        model: "article-cache-model",
        artifacts,
        technicalTermDiscoveryCacheDir: cacheDir,
      });
      expect(firstLlm.chat).toHaveBeenCalledTimes(2);

      clearDiscoveryCaches();
      const secondLlm = makeLlm(
        () => ({ content: "# 标题\n\n冷启动后正文\n\n#AI #Agent #Workflow", model: "m", finishReason: "stop" }),
        "[]",
      );
      const result = await generateXArticleContent({
        llm: secondLlm,
        model: "article-cache-model",
        artifacts,
        technicalTermDiscoveryCacheDir: cacheDir,
      });

      expect(secondLlm.chat).toHaveBeenCalledTimes(1);
      expect(result.technicalTermDiscovery.sourceIdentity).toMatch(/^sha256-[0-9a-f]{64}$/u);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
      clearDiscoveryCaches();
    }
  });

  it("sends article system prompt and X user sections", async () => {
    const llm = makeLlm((req) => {
      expect(req.messages[0]!.content).toMatch(/X（Twitter）/);
      expect(req.messages[1]!.content).toMatch(/Structured notes/);
      expect(req.temperature).toBeCloseTo(0.55);
      return { content: "# T\n\nbody\n\n#AI #Codex #工作流", model: "m", finishReason: "stop" };
    });
    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(r.content).toBe("# **Notes**\n\nbody\n\n#AI #Codex #工作流");
    expect(r.videoId).toBe("vid");
    expect(r.visualPlan).toEqual([]);
  });

  it("strips markdown fence wrapper", async () => {
    const llm = makeLlm(() => ({
      content: "```markdown\n# T\n\nx\n\n#AI #Codex #工作流\n```",
      model: "m",
      finishReason: "stop",
    }));
    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(r.content).toBe("# **Notes**\n\nx\n\n#AI #Codex #工作流");
  });

  it("uses the faithful Chinese title from structured notes instead of the model title", async () => {
    const llm = makeLlm(() => ({
      content: "# A different angle\n\nbody\n\n#AI #Codex #工作流",
      model: "m",
      finishReason: "stop",
    }));

    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });

    expect(r.content).toBe("# **Notes**\n\nbody\n\n#AI #Codex #工作流");
  });

  it("restores an untranslated product name from the original title", async () => {
    const llm = makeLlm(() => ({
      content: "# 营销标题\n\nbody\n\n#AI #ClaudeDesign #工作流",
      model: "m",
      finishReason: "stop",
    }));
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "# Claude 设计完整教程：从入门到精通\n\n- point",
      metadata: { id: "vid", title: "Claude Design FULL Tutorial: Beginner to Pro" },
    };

    const r = await generateXArticleContent({ llm, model: "m", artifacts });

    expect(r.content).toMatch(/^# \*\*Claude Design 完整教程：从入门到精通\*\*/);
  });

  it("restores an English technical term from the notes title when the source title contains it", async () => {
    const llm = makeLlm(() => ({
      content: "# 营销标题\n\nbody\n\n#AI #Codex #工作流",
      model: "m",
      finishReason: "stop",
    }));
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "# 为什么图工程会让 Claude/Codex 效率提升十倍\n\n图工程（Graph Engineering）是一种工作流设计方法。",
      metadata: { id: "vid", title: "Why Graph Engineering will 10x your Claude/Codex" },
    };

    const r = await generateXArticleContent({ llm, model: "m", artifacts });

    expect(r.content).toMatch(/^# \*\*为什么 Graph Engineering 会让 Claude\/Codex 效率提升十倍\*\*/);
  });

  it("preserves technical terms without rewriting natural graph wording", async () => {
    const llm = makeLlm(() => ({
      content: [
        "# 营销标题",
        "",
        "## 图的基本词汇",
        "",
        "## 知识图谱 vs 代理图谱",
        "",
        "提示工程和上下文工程都必须保留原名。",
        "",
        "什么时候值得用图",
        "",
        "三个可直接套用的现成图",
        "",
        "更大的图不等于更好的产出",
        "",
        "构建你的第一个图",
        "",
        "图工程需要把工作拆成可检查的步骤。",
        "截图、缩略图和图片应该保持原样。",
        "",
        "#AI #Claude #工作流",
      ].join("\n"),
      model: "m",
      finishReason: "stop",
    }));
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: [
        "# 为什么图工程会让 Claude/Codex 效率提升十倍",
        "",
        "图工程（Graph Engineering）是一种工作流设计方法。",
        "知识图谱（Knowledge Graph）帮助 AI 理解实体之间的关系。",
        "代理图谱（Agent Graph）描述工作如何流动。",
        "提示工程（Prompt Engineering）和上下文工程（Context Engineering）也属于技术术语。",
      ].join("\n"),
      metadata: { id: "vid", title: "Why Graph Engineering will 10x your Claude/Codex" },
    };

    const r = await generateXArticleContent({ llm, model: "m", artifacts });

    expect(r.content).toContain("## 图的基本词汇");
    expect(r.content).toContain("## Knowledge Graph vs Agent Graph");
    expect(r.content).toContain("Prompt Engineering");
    expect(r.content).toContain("Context Engineering");
    expect(r.content).toContain("什么时候值得用图");
    expect(r.content).toContain("现成图");
    expect(r.content).toContain("更大的图");
    expect(r.content).toContain("第一个图");
    expect(r.content).toContain("Graph Engineering 需要");
    expect(r.content).toContain("截图、缩略图和图片应该保持原样。");
    expect(r.content).not.toContain("## Graph 的基本词汇");
  });

  it("strips trailing source attribution from generated article markdown", async () => {
    const llm = makeLlm(() => ({
      content: "# T\n\nbody\n\n#AI #Codex #工作流\n\n来源：<YOUTUBE_URL>",
      model: "m",
      finishReason: "stop",
    }));
    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(r.content).toBe("# **Notes**\n\nbody\n\n#AI #Codex #工作流");
  });

  it("includes available_visuals in user prompt when provided", async () => {
    const llm = makeLlm((req) => {
      expect(req.messages[1]!.content).toMatch(/Available screenshots/);
      expect(req.messages[1]!.content).toMatch(/"visual_id": "scene_001"/);
      return { content: "# T\n\nbody\n\n#AI #Codex #工作流", model: "m", finishReason: "stop" };
    });
    await generateXArticleContent({
      llm,
      model: "m",
      artifacts: fakeArtifacts,
      availableVisuals: sampleVisuals,
    });
  });

  it("validates image references in generated article", async () => {
    const llm = makeLlm(() => ({
      content: "## 配置\n\n![配置截图](screenshots/scene_01.jpg)\n\n正文\n\n#AI #Codex #工作流",
      model: "m",
      finishReason: "stop",
    }));
    const r = await generateXArticleContent({
      llm,
      model: "m",
      artifacts: fakeArtifacts,
      availableVisuals: sampleVisuals,
    });
    expect(r.visualPlan).toHaveLength(1);
    expect(r.visualPlan[0]!.visual_id).toBe("scene_001");
  });

  it("repairs an article that omits the final topic hashtag line", async () => {
    const llm = makeLlm((req) => {
      if (req.messages.length === 2) {
        return { content: "# T\n\nbody", model: "m", finishReason: "stop" };
      }
      expect(req.messages.at(-2)).toMatchObject({ role: "assistant", content: "# T\n\nbody" });
      expect(req.messages.at(-1)?.content).toMatch(/最后一个非空行必须只包含 3-5 个/);
      return { content: "# T\n\nbody\n\n#AI #Codex #工作流", model: "m", finishReason: "stop" };
    });

    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });

    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(r.content).toBe("# **Notes**\n\nbody\n\n#AI #Codex #工作流");
  });

  it("uses a tag-only repair when the full article repair still omits hashtags", async () => {
    const llm = makeLlm((req) => {
      if (req.messages.length === 2) {
        return { content: "# T\n\nbody", model: "m", finishReason: "stop" };
      }
      const repairPrompt = req.messages.at(-1)?.content ?? "";
      if (repairPrompt.includes("只返回一行")) {
        return { content: "#GraphEngineering #Workflow #Codex", model: "m", finishReason: "stop" };
      }
      return { content: "# T\n\n修复后的正文仍然没有标签", model: "m", finishReason: "stop" };
    });

    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });

    expect(llm.chat).toHaveBeenCalledTimes(3);
    expect(r.content).toBe("# **Notes**\n\n修复后的正文仍然没有标签\n\n#GraphEngineering #Workflow #Codex");
  });

  it("normalizes command-style topic hashtags into X-compatible tags", async () => {
    const llm = makeLlm(() => ({
      content: "# T\n\nbody\n\n#/wayfinder #/research #to-spec #to-tickets #Codex",
      model: "m",
      finishReason: "stop",
    }));

    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(r.content).toBe("# **Notes**\n\nbody\n\n#Wayfinder #Research #ToSpec #ToTickets #Codex");
  });

  it("repairs screenshot refs placed between list items", async () => {
    const llm = makeLlm((req) => {
      if (req.messages.length === 2) {
        return {
          content:
            "# T\n\n1. step a\n\n![配置截图](screenshots/scene_01.jpg)\n\n2. step b\n\n#AI #Codex #工作流",
          model: "m",
          finishReason: "stop",
        };
      }
      expect(req.messages.at(-1)?.content).toMatch(/列表外的独立段落/);
      return {
        content:
          "# T\n\n1. step a\n2. step b\n\n![配置截图](screenshots/scene_01.jpg)\n\n#AI #Codex #工作流",
        model: "m",
        finishReason: "stop",
      };
    });

    const r = await generateXArticleContent({
      llm,
      model: "m",
      artifacts: fakeArtifacts,
      availableVisuals: sampleVisuals,
    });

    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(r.visualPlan).toHaveLength(1);
    expect(r.content).toContain("2. step b\n\n![配置截图]");
  });
});

describe("validateArticleTopicHashtags", () => {
  it("accepts a standalone final topic hashtag line", () => {
    expect(validateArticleTopicHashtags("# T\n\nbody\n\n#AI #Codex #中文工作流")).toEqual([
      "#AI",
      "#Codex",
      "#中文工作流",
    ]);
  });

  it("rejects missing or non-standalone topic hashtag endings", () => {
    expect(() => validateArticleTopicHashtags("# T\n\nbody")).toThrow(/3-5 topic hashtags/);
    expect(() => validateArticleTopicHashtags("# T\n\nbody\n\n相关话题 #AI #Codex #工作流")).toThrow(
      /standalone/,
    );
  });
});

describe("validateArticleVisualPlan", () => {
  it("returns empty plan for content without image refs", () => {
    expect(validateArticleVisualPlan("# Title\n\nbody", sampleVisuals)).toEqual([]);
  });

  it("returns empty plan when availableVisuals is null and no refs", () => {
    expect(validateArticleVisualPlan("# Title", null)).toEqual([]);
  });

  it("throws when content has refs but no visuals provided", () => {
    expect(() =>
      validateArticleVisualPlan("![x](screenshots/a.jpg)", null),
    ).toThrow(/no available_visuals/);
  });

  it("throws when content references non-existent visual", () => {
    expect(() =>
      validateArticleVisualPlan("![x](screenshots/nonexistent.jpg)", sampleVisuals),
    ).toThrow(/not in available_visuals/);
  });

  it("accepts valid image ref matching available visual", () => {
    const plan = validateArticleVisualPlan(
      "![caption](screenshots/scene_01.jpg)",
      sampleVisuals,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]!.visual_id).toBe("scene_001");
    expect(plan[0]!.caption).toBe("caption");
  });

  it("rejects image references inside or between list items", () => {
    expect(() =>
      validateArticleVisualPlan("- ![caption](screenshots/scene_01.jpg)", sampleVisuals),
    ).toThrow(/outside ordered or unordered lists/);
    expect(() =>
      validateArticleVisualPlan(
        "1. step a\n\n![caption](screenshots/scene_01.jpg)\n\n2. step b",
        sampleVisuals,
      ),
    ).toThrow(/outside ordered or unordered lists/);
    expect(() =>
      validateArticleVisualPlan(
        "- step a\n  ![caption](screenshots/scene_01.jpg)",
        sampleVisuals,
      ),
    ).toThrow(/outside ordered or unordered lists/);
  });
});
