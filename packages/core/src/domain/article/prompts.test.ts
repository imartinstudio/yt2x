import { describe, expect, it } from "vitest";
import { ARTICLE_X_SYSTEM_PROMPT, buildArticleUserPrompt } from "./prompts.js";
import type { AvailableVisual } from "../visuals/types.js";

const sampleVisuals: AvailableVisual[] = [
  {
    visual_id: "scene_001",
    path: "screenshots/scene_01.jpg",
    timestamp: "00:01:23",
    nearby_text: "配置界面展示",
    quality: { blur: "low", has_text: true, has_ui: true, center_presenter: false },
  },
];

describe("buildArticleUserPrompt", () => {
  it("embeds stripped metadata and structured notes", () => {
    const md = buildArticleUserPrompt({
      metadata: {
        id: "abc",
        title: "Demo",
        formats: [{ x: 1 }],
        webpage_url: "https://youtu.be/abc",
      },
      structuredNotesMd: "# Notes\n\nbody",
    });
    expect(md).toMatch(/## Video metadata/);
    expect(md).toMatch(/"id": "abc"/);
    expect(md).not.toMatch(/"formats"/);
    expect(md).toMatch(/## Structured notes/);
    expect(md).toMatch(/# Notes/);
  });

  it("does not include available_visuals section when null", () => {
    const md = buildArticleUserPrompt({
      metadata: { id: "abc", title: "Demo" },
      structuredNotesMd: "# Notes",
      availableVisuals: null,
    });
    expect(md).not.toMatch(/available_visuals/);
    expect(md).not.toMatch(/scene_001/);
  });

  it("does not include available_visuals section when empty", () => {
    const md = buildArticleUserPrompt({
      metadata: { id: "abc", title: "Demo" },
      structuredNotesMd: "# Notes",
      availableVisuals: [],
    });
    expect(md).not.toMatch(/available_visuals/);
  });

  it("includes available_visuals JSON when provided", () => {
    const md = buildArticleUserPrompt({
      metadata: { id: "abc", title: "Demo" },
      structuredNotesMd: "# Notes",
      availableVisuals: sampleVisuals,
    });
    expect(md).toMatch(/Available screenshots/);
    expect(md).toMatch(/"visual_id": "scene_001"/);
    expect(md).toMatch(/禁止引用未在 available_visuals 中出现的图片/);
  });

  it("system prompt mentions screenshot rules when visuals available", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/截图配图规则/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/available_visuals/);
  });

  it("system prompt defines emoji policy", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/Emoji 策略/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/默认不使用 emoji/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/语义锚点/);
  });

  it("system prompt mentions X and markdown-only output", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/X（Twitter）/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/不要用/);
  });

  it("requires bold headings and colon labels", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/# \*\*标题\*\*/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/## \*\*小节标题\*\*/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/\*\*xxxx：\*\*/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/有序列表会保留编号/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/无序列表会转成/);
  });
});
