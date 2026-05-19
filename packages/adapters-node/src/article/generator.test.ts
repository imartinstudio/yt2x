import { describe, expect, it, vi } from "vitest";
import type { AvailableVisual, ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import { generateXArticleContent, validateArticleVisualPlan } from "./generator.js";
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
      return { content: "# T\n\nbody", model: "m", finishReason: "stop" };
    });
    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(r.content).toBe("# T\n\nbody");
    expect(r.videoId).toBe("vid");
    expect(r.visualPlan).toEqual([]);
  });

  it("strips markdown fence wrapper", async () => {
    const llm = makeLlm(() => ({
      content: "```markdown\n# T\n\nx\n```",
      model: "m",
      finishReason: "stop",
    }));
    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(r.content).toBe("# T\n\nx");
  });

  it("strips trailing source attribution from generated article markdown", async () => {
    const llm = makeLlm(() => ({
      content: "# T\n\nbody\n\n来源：<YOUTUBE_URL>",
      model: "m",
      finishReason: "stop",
    }));
    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(r.content).toBe("# T\n\nbody");
  });

  it("includes available_visuals in user prompt when provided", async () => {
    const llm = makeLlm((req) => {
      expect(req.messages[1]!.content).toMatch(/Available screenshots/);
      expect(req.messages[1]!.content).toMatch(/"visual_id": "scene_001"/);
      return { content: "# T\n\nbody", model: "m", finishReason: "stop" };
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
      content: "## 配置\n\n![配置截图](screenshots/scene_01.jpg)\n\n正文",
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
});
