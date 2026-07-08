import { describe, expect, it } from "vitest";
import { buildShortUserPrompt, SHORT_X_SYSTEM_PROMPT } from "./prompts.js";

describe("SHORT_X_SYSTEM_PROMPT", () => {
  it("defines a dedicated X short post task", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/X（Twitter）/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/只生成 1 条短帖正文/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/18 行以内/);
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

  it("requires Simplified Chinese output and Traditional Chinese conversion", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/简体中文/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/zh-CN/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/繁体中文/);

    const prompt = buildShortUserPrompt({
      metadata: { id: "video-id" },
      structuredNotesMd: "# Notes",
    });
    expect(prompt).toMatch(/Simplified Chinese \(zh-CN\)/);
    expect(prompt).toMatch(/Translate Traditional Chinese/);
  });

  it("requires plain-text post formatting shared with thread posts", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/Post 文本格式规则必须和串推保持一致/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要使用 Markdown 加粗、行内代码、代码块、有序列表、无序列表/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/序号后加一个空格/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/emoji 数字/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要写成 `1\/ 内容`/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要输出多个备选版本/);
  });

  it("requires strict JSON for one short post", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/严格 JSON/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/"text"/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/"angle"/);
  });

  it("requires colon labels to wrap after the colon without bold", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/冒号后必须换行/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/关键判断：/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要加粗/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/核心判断：\\n正文/);
  });

  it("forbids markdown tables in generated short posts", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/禁止在短帖中使用 Markdown 表格/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/冒号后换行、序号后加空格规则/);
  });

  it("forbids markdown formatting inside short text", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/text 字段内部也不要包含 Markdown 格式/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要使用 Markdown 粗体/);
  });

  it("requires strong judgment hook in the first sentence", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/第一句必须是判断或反差/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不到 3 秒/);
  });

  it("requires at least one executable list item", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/可执行资产规则/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/至少有 1 条.*具体可复制的例子/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不需要回看视频或文章/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不得编造命令、参数、链接或来源/);
  });

  it("requires a risk reminder for high-trust topics", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/高信任主题风险规则/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/账号注册/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/凭证泄露/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/list 中必须至少有 1 条独立的风险提醒/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/高信任成本主题至少为 "medium"/);
  });

  it("forbids mechanical CTA and engagement bait", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/CTA 必须具体到「让读者完成什么动作」/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/评论区打 1/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/点赞收藏/);
  });

  it("forbids fabricated images inside short text", () => {
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/不要在 text 中写虚构的图片路径或文件名/);
    expect(SHORT_X_SYSTEM_PROMPT).toMatch(/配图必须和短帖里的某个具体要点绑定/);
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
