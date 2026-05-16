import { describe, expect, it } from "vitest";
import { buildThreadUserPrompt, THREAD_X_SYSTEM_PROMPT } from "./prompts.js";

describe("THREAD_X_SYSTEM_PROMPT", () => {
  it("defines a dedicated X thread task", () => {
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/X（Twitter）/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/6–15/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/每条 tweet 只讲一个信息点/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/core_thesis/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/final_post/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/第一条 tweet 是整条串推的独立总述/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/从第二条 tweet 开始/);
  });

  it("defines emoji policy: max 0-1 per tweet, semantic only", () => {
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/Emoji 策略/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/最多 0–1 个/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/禁止纯装饰 emoji/);
  });

  it("forbids hallucination, clickbait, and mechanical recap", () => {
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/不要编造/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/不要廉价标题党/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/不逐段复述/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/不按 Markdown 段落切片/);
  });

  it("requires labeled tweet structure and content-derived length", () => {
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/后续 tweet 数量取决于视频内容中的真实观点密度/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/标新立异的短总结：正文/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/key_points 必须有 4–6 项/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/不要展开具体步骤、配置项或教程细节/);
  });

  it("requires strict JSON for thread and hooks", () => {
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/严格 JSON/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/仅作为内部元数据/);
    expect(THREAD_X_SYSTEM_PROMPT).toMatch(/"planning"/);
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
