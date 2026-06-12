import { describe, expect, it } from "vitest";
import {
  buildPlatformArticleUserPrompt,
  getPlatformArticleSystemPrompt,
} from "./platform-prompts.js";

describe("getPlatformArticleSystemPrompt", () => {
  it("builds the confirmed Xiaohongshu prompt rules", () => {
    const prompt = getPlatformArticleSystemPrompt("xiaohongshu");
    expect(prompt).toMatch(/种草型、强情绪、强钩子/);
    expect(prompt).toMatch(/5 个标题候选/);
    expect(prompt).toMatch(/3-5 个核心标签/);
    expect(prompt).toMatch(/xiaohongshu-article.md/);
    expect(prompt).toMatch(/严格 JSON|JSON schema/);
  });

  it("builds the WeChat prompt rules", () => {
    const prompt = getPlatformArticleSystemPrompt("wechat");
    expect(prompt).toMatch(/完整 Markdown 长文/);
    expect(prompt).toMatch(/1 个主标题 \+ 3 个备选标题/);
    expect(prompt).toMatch(/摘要和开头导语/);
    expect(prompt).toMatch(/wechat-metadata.json/);
  });

  it("builds the Bilibili prompt rules with the confirmed title style", () => {
    const prompt = getPlatformArticleSystemPrompt("bilibili");
    expect(prompt).toMatch(/强冲突、高点击/);
    expect(prompt).toMatch(/8-10 个标签/);
    expect(prompt).toMatch(/章节时间线草案/);
    expect(prompt).toMatch(/不得虚构精确秒数|不编造精确秒数/);
  });

  it("keeps every platform source-only and claim-preserving", () => {
    for (const target of ["xiaohongshu", "wechat", "bilibili"] as const) {
      const prompt = getPlatformArticleSystemPrompt(target);
      expect(prompt).toMatch(/只基于输入的 article\.md/);
      expect(prompt).toMatch(/不新增事实/);
      expect(prompt).toMatch(/不能改变原文观点、结论和风险边界/);
    }
  });
});

describe("buildPlatformArticleUserPrompt", () => {
  it("embeds stripped metadata and source article", () => {
    const prompt = buildPlatformArticleUserPrompt(
      {
        metadata: {
          id: "abc",
          title: "Demo",
          formats: [{ url: "large" }],
          webpage_url: "https://youtu.be/abc",
        },
        articleMd: "# Article\n\nBody",
      },
      { target: "wechat" },
    );
    expect(prompt).toMatch(/## Video metadata/);
    expect(prompt).toMatch(/"id": "abc"/);
    expect(prompt).not.toMatch(/"formats"/);
    expect(prompt).toMatch(/## Source article\.md/);
    expect(prompt).toMatch(/# Article/);
    expect(prompt).toMatch(/strict JSON only/);
  });

  it("includes timestamped cues only when provided", () => {
    const withoutCues = buildPlatformArticleUserPrompt(
      {
        metadata: { id: "abc" },
        articleMd: "# Article",
      },
      { target: "bilibili" },
    );
    expect(withoutCues).not.toMatch(/timestamped cues/);

    const withCues = buildPlatformArticleUserPrompt(
      {
        metadata: { id: "abc" },
        articleMd: "# Article",
        timestampedCuesMd: "00:00 intro",
      },
      { target: "bilibili" },
    );
    expect(withCues).toMatch(/Optional timestamped cues/);
    expect(withCues).toMatch(/00:00 intro/);
  });
});
