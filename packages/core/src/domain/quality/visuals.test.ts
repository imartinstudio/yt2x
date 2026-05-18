import { describe, expect, it } from "vitest";
import {
  deriveArticleVisualSuggestions,
  pickArticleCoverFromCandidates,
} from "./visuals.js";

describe("pickArticleCoverFromCandidates", () => {
  it("returns null for empty input", () => {
    expect(pickArticleCoverFromCandidates([])).toBeNull();
  });

  it("prefers youtube_cover.* above all", () => {
    expect(
      pickArticleCoverFromCandidates([
        "contact_sheet.jpg",
        "scene_01.webp",
        "youtube_cover.jpg",
      ]),
    ).toBe("youtube_cover.jpg");
  });

  it("falls back to any non contact_sheet keyframe when no youtube cover", () => {
    expect(
      pickArticleCoverFromCandidates(["contact_sheet.jpg", "scene_03.webp"]),
    ).toBe("scene_03.webp");
  });

  it("falls back to contact_sheet only when nothing else exists", () => {
    expect(pickArticleCoverFromCandidates(["contact_sheet.jpg"])).toBe(
      "contact_sheet.jpg",
    );
  });

  it("is case-insensitive on the file prefix", () => {
    expect(
      pickArticleCoverFromCandidates(["YouTube_Cover.JPG", "scene_01.webp"]),
    ).toBe("YouTube_Cover.JPG");
  });
});

describe("deriveArticleVisualSuggestions", () => {
  it("returns empty array for article without H2", () => {
    expect(deriveArticleVisualSuggestions("# **Title**\n\nbody")).toEqual([]);
  });

  it("suggests comparison diagram for 对比 / 误区 sections", () => {
    const md = `# **A**\n\nlead\n\n## **常见误区与正确做法**\n\nbody`;
    const out = deriveArticleVisualSuggestions(md);
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe("comparison");
    expect(out[0]!.target_section).toBe("常见误区与正确做法");
    expect(out[0]!.priority).toBe("high");
  });

  it("suggests flow diagram for 流程 / 步骤 sections", () => {
    const md = `# **A**\n\nlead\n\n## **完整流程**\n\nbody`;
    const out = deriveArticleVisualSuggestions(md);
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe("diagram");
    expect(out[0]!.target_section).toBe("完整流程");
  });

  it("suggests template-card for 模板 / 清单 sections", () => {
    const md = `# **A**\n\nlead\n\n## **检查清单**\n\nbody\n\n## **可复制模板**\n\nbody`;
    const out = deriveArticleVisualSuggestions(md);
    const kinds = out.map((s) => s.kind);
    expect(kinds).toContain("template-card");
    expect(out.length).toBe(2);
  });

  it("suggests ui-screenshot for 配置 / 命令 / 操作 sections", () => {
    const md = `# **A**\n\nlead\n\n## **配置与命令演示**\n\nbody`;
    const out = deriveArticleVisualSuggestions(md);
    expect(out[0]!.kind).toBe("ui-screenshot");
  });

  it("suggests risk card for 风险 / 边界 sections", () => {
    const md = `# **A**\n\nlead\n\n## **风险与适用边界**\n\nbody`;
    const out = deriveArticleVisualSuggestions(md);
    expect(out[0]!.kind).toBe("comparison");
    expect(out[0]!.description).toMatch(/风险卡片/);
  });

  it("deduplicates sections with the same heading", () => {
    const md = `# **A**\n\nlead\n\n## **流程**\n\nbody\n\n## **流程**\n\nbody`;
    const out = deriveArticleVisualSuggestions(md);
    expect(out.length).toBe(1);
  });

  it("derives multiple suggestions from a real abstract-framework article", () => {
    const md = `# **Claude Skills 实操**

短导语。

## **Skill 与 Prompt 的对比**

对比内容。

## **Skill 设计流程**

流程内容。

## **可复制模板**

模板内容。
`;
    const out = deriveArticleVisualSuggestions(md);
    expect(out.length).toBe(3);
    expect(out.map((s) => s.kind).sort()).toEqual([
      "comparison",
      "diagram",
      "template-card",
    ]);
  });
});
