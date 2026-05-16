import { describe, expect, it } from "vitest";
import { buildThreadUserPrompt, THREAD_X_SYSTEM_PROMPT } from "./prompts.js";

describe("THREAD_X_SYSTEM_PROMPT", () => {
  it("defines a dedicated X thread task", () => {
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/X（Twitter）/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/8–15/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/每条 tweet 只讲一个信息点/);
  });

  it("forbids hallucination, clickbait, and mechanical recap", () => {
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/不要编造/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/不要廉价标题党/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/不逐段复述/);
  });

  it("requires strict JSON for thread and hooks", () => {
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/严格 JSON/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/"tweets"/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/"hooks"/);
  });
});

describe("buildThreadUserPrompt", () => {
  it("embeds stripped metadata and structured notes", () => {
    const prompt = buildThreadUserPrompt({
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
      buildThreadUserPrompt(
        {
          metadata: { id: "video-id" },
          structuredNotesMd: "# Notes",
        },
        { platform: "newsletter" as "x" },
      ),
    ).toThrow(/Unsupported thread platform/);
  });
});
