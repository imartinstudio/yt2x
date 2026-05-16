import { describe, expect, it } from "vitest";
import { buildShortUserPrompt, SHORT_X_SYSTEM_PROMPT } from "./prompts.js";

describe("SHORT_X_SYSTEM_PROMPT", () => {
  it("defines a dedicated X short post task", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/X（Twitter）/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/只生成 1 条短帖正文/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/只表达一个核心判断/);
  });

  it("forbids hallucination, clickbait, and mechanical recap", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要编造/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要廉价标题党/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要逐段复述/);
  });

  it("forbids thread formatting", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要编号/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要写成 1\/、2\//);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要输出多个备选版本/);
  });

  it("requires strict JSON for one short post", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/严格 JSON/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/"text"/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/"angle"/);
  });
});

describe("buildShortUserPrompt", () => {
  it("embeds stripped metadata and structured notes", () => {
    const prompt = buildShortUserPrompt({
      metadata: {
        id: "video-id",
        title: "Demo",
        formats: [{ x: 1 }],
        webpage_url: "https://example.com/watch",
      },
      structuredNotesMd: "# Notes\n\nbody",
    });
    expect(prompt).toMatch(/## Video metadata/);
    expect(prompt).toMatch(/"id": "video-id"/);
    expect(prompt).not.toMatch(/"formats"/);
    expect(prompt).toMatch(/## Structured notes/);
    expect(prompt).toMatch(/# Notes/);
    expect(prompt).toMatch(/Output strict JSON only/);
  });

  it("rejects unsupported platforms", () => {
    expect(() =>
      buildShortUserPrompt(
        {
          metadata: { id: "video-id" },
          structuredNotesMd: "# Notes",
        },
        { platform: "newsletter" as "x" },
      ),
    ).toThrow(/Unsupported short platform/);
  });
});
