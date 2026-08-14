import { describe, expect, it } from "vitest";
import { buildVideoShortUserPrompt, VIDEO_SHORT_X_SYSTEM_PROMPT } from "./prompts.js";

describe("VIDEO_SHORT_X_SYSTEM_PROMPT", () => {
  it("requires Simplified Chinese output and Traditional Chinese conversion", () => {
    expect(VIDEO_SHORT_X_SYSTEM_PROMPT).toMatch(/简体中文/);
    expect(VIDEO_SHORT_X_SYSTEM_PROMPT).toMatch(/zh-CN/);
    expect(VIDEO_SHORT_X_SYSTEM_PROMPT).toMatch(/繁体中文/);
    expect(VIDEO_SHORT_X_SYSTEM_PROMPT).toMatch(/源材料中实际出现的术语/);
    expect(VIDEO_SHORT_X_SYSTEM_PROMPT).toMatch(/运行时会追加本次源材料的 active terms/);
    expect(VIDEO_SHORT_X_SYSTEM_PROMPT).not.toMatch(/Prompt Engineering/);
  });
});

describe("buildVideoShortUserPrompt", () => {
  it("instructs the model to generate Simplified Chinese caption JSON", () => {
    const prompt = buildVideoShortUserPrompt({
      metadata: { id: "video-id", title: "Demo" },
      structuredNotesMd: "# Notes",
    });

    expect(prompt).toMatch(/Simplified Chinese \(zh-CN\)/);
    expect(prompt).toMatch(/Translate Traditional Chinese/);
    expect(prompt).toMatch(/Output strict JSON only/);
  });
});
