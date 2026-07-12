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
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/图片引用必须单独成段/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/禁止插在同一列表的两个列表项之间/);
  });

  it("system prompt defines emoji policy", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/Emoji 策略/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/默认不使用 emoji/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/语义锚点/);
  });

  it("requires extracted topic hashtags at the article end", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/话题标签规则/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/3–5 个 X 话题标签/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/视频主题、关键工具、核心方法或读者问题/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/系统会在落盘时补完整视频地址/);
  });

  it("system prompt mentions X and markdown-only output", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/X（Twitter）/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/不要用/);
  });

  it("requires Simplified Chinese output and Traditional Chinese conversion", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/简体中文/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/zh-CN/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/繁体中文/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/翻译或转写/);
  });

  it("forbids trailing source attribution in generated articles", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/不要在文末追加来源说明/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/Source 行/);
    expect(ARTICLE_X_SYSTEM_PROMPT).not.toMatch(/最后一行单独一段来源说明/);
  });

  it("requires bold headings and colon labels", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/# \*\*标题\*\*/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/## \*\*小节标题\*\*/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/\*\*xxxx：\*\*/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/列表必须保留 Markdown 源格式/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/无序列表每项使用/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/禁止直接输出/);
  });

  it("requires fenced blocks for all copyable snippets", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/代码、命令、配置片段、prompt、提示词、模板文本/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/fenced code block/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/禁止把可复制内容仅写成行内代码/);
  });

  it("defines a 120-character lead and enhanced title-hook rules", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/首屏 Hook 规则/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/120 字以内/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/标题钩子增强规则/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/认知反转 > 冲突 > 收益 > 功能/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/标题信息缺口检查/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/标题与导语一致性检查/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/最高优先级原则/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/可被读者预测/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/2GB 显存跑 AI Agent/);
  });

  it("anchors the generated title to the original video title", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/原视频标题锚点/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/不得替换原视频的核心主题/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/核心实体、主题和限定条件/);
  });

  it("defines mobile rhythm: max 2 consecutive paragraphs and 250-char cap", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/移动端节奏规则/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/最多连续 2 个正文段落/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/250 字以内/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/加粗结论/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/准备 \/ 操作 \/ 验证 \/ 风险/);
  });

  it("requires a dedicated risk section for high-trust topics", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/风险与适用边界规则/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/## \*\*风险与适用边界\*\*/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/账号锁定/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/凭证泄露/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/不得编造/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/官方认可/);
  });

  it("requires at least one executable asset per article", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/可执行资产规则/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/可复制 prompt、模板、检查清单、操作步骤表、风险清单、决策树/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/可立即使用的产物/);
  });

  it("forbids hallucinated links and fake official sources", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/不得编造官方链接/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/不要编造原笔记没有的信息/);
  });

  it("forbids fabricated images when no screenshots are available", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/不要写任何图片引用/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/不要虚构图片路径/);
  });

  it("requires concrete CTA instead of mechanical engagement bait", () => {
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/CTA 必须具体/);
    expect(ARTICLE_X_SYSTEM_PROMPT).toMatch(/评论区打 1/);
  });
});
