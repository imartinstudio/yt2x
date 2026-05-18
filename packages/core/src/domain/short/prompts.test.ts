import { describe, expect, it } from "vitest";
import { buildShortUserPrompt, SHORT_X_SYSTEM_PROMPT } from "./prompts.js";

describe("SHORT_X_SYSTEM_PROMPT", () => {
  it("defines a dedicated X short post task", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/X（Twitter）/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/只生成 1 条短帖正文/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不设置固定字数上限/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/精炼表达核心判断/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/一句话核心总结/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/内容总结 list/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/至少 4 条具体 list item/);
  });

  it("defines emoji policy: default plain text, max 0-1 semantic", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/Emoji 策略/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/默认纯文本/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/0–1 个/);
  });

  it("forbids hallucination, clickbait, and mechanical recap", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要编造/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要廉价标题党/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要逐段复述/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要只做概括/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要写成空泛目录/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/没有编号 list 的 text 视为不合格/);
  });

  it("allows an in-post list but forbids thread formatting", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/可以在单条短帖内部使用 `1\. 2\. 3\.`/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/无序列表使用/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要写成 `1\/`、`2\/`/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要使用数字 emoji/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要输出多个备选版本/);
  });

  it("requires strict JSON for one short post", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/严格 JSON/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/"text"/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/"angle"/);
  });

  it("requires bold headings and colon labels", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/\*\*xxxx：\*\*/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/\*\*核心判断：\*\*正文/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/1\. \*\*关键步骤：\*\*正文/);
  });

  it("forbids markdown tables in generated short posts", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/禁止在短帖中使用 Markdown 表格/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/编号列表、要点列表或「字段：值」短行/);
  });

  it("preserves useful markdown except tables inside short text", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/text 字段内部可以包含除表格外的 Markdown/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/加粗、行内代码、代码块、有序列表、无序列表、链接、引用/);
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
