import { describe, expect, it } from "vitest";
import { ARTICLE_X_SYSTEM_PROMPT, buildArticleUserPrompt } from "./prompts.js";

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

  it("system prompt mentions X and markdown-only output", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/X（Twitter）/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/不要用/);
  });
});
