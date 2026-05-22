import { describe, expect, it, vi } from "vitest";
import type { AvailableVisual, ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import {
  generateXArticleContent,
  validateArticleTopicHashtags,
  validateArticleVisualPlan,
} from "./generator.js";
import type { StructuredNotesArtifacts } from "./file-store.js";

const fakeArtifacts: StructuredNotesArtifacts = {
  videoDir: "/tmp/v",
  videoId: "vid",
  structuredNotesMd: "# Notes\n\n- point",
  metadata: { id: "vid", title: "Hello" },
};

const makeLlm = (
  respond: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>,
): LlmPort => ({ chat: vi.fn((req) => Promise.resolve(respond(req))) });

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
  it("sends article system prompt and X user sections", async () => {
    const llm = makeLlm((req) => {
      expect(req.messages[0]!.content).toMatch(/X（Twitter）/);
      expect(req.messages[1]!.content).toMatch(/Structured notes/);
      expect(req.temperature).toBeCloseTo(0.55);
      return { content: "# T\n\nbody\n\n#AI #Codex #工作流", model: "m", finishReason: "stop" };
    });
    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(r.content).toBe("# T\n\nbody\n\n#AI #Codex #工作流");
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
    expect(r.content).toBe("# T\n\nx\n\n#AI #Codex #工作流");
  });

  it("strips trailing source attribution from generated article markdown", async () => {
    const llm = makeLlm(() => ({
      content: "# T\n\nbody\n\n#AI #Codex #工作流\n\n来源：<YOUTUBE_URL>",
      model: "m",
      finishReason: "stop",
    }));
    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(r.content).toBe("# T\n\nbody\n\n#AI #Codex #工作流");
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
    expect(r.content).toBe("# T\n\nbody\n\n#AI #Codex #工作流");
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
