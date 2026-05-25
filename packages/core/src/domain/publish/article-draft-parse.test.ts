import { describe, expect, it } from "vitest";
import {
  collectLocalMediaReferences,
  isLocalMediaReference,
  parseArticleDraftFromMarkdown,
} from "./article-draft-parse.js";

describe("extractArticleTitle", () => {
  it("prefers H1 over leading English prompt lines", () => {
    const parsed = parseArticleDraftFromMarkdown(
      [
        "Run a security check.",
        "",
        "# **不会写代码也能做应用**",
        "",
        "## 第一节",
        "",
        "正文。",
      ].join("\n"),
      { resolveMediaPath: (source) => source },
    );
    expect(parsed.title).toBe("不会写代码也能做应用");
    expect(parsed.html).toMatch(/第一节/);
    expect(parsed.html).not.toMatch(/Run a security check/);
  });
});

describe("parseArticleDraftFromMarkdown", () => {
  it("extracts title, cover, content media, dividers, and rich HTML blocks", () => {
    const parsed = parseArticleDraftFromMarkdown(
      [
        "# **Draft title**",
        "",
        "![cover](images/cover.jpg)",
        "",
        "Intro with **bold** and [link](https://example.com).",
        "",
        "## Section",
        "",
        "- one",
        "- two",
        "",
        "![shot](images/shot.png)",
        "",
        '<video controls src="video/clip.mp4"></video>',
        "",
        "---",
        "",
        "> quote",
      ].join("\n"),
      {
        resolveMediaPath: (source) => `/articles/vid/${source}`,
      },
    );

    expect(parsed.title).toBe("Draft title");
    expect(parsed.coverImage).toBe("/articles/vid/images/cover.jpg");
    expect(parsed.contentImages).toEqual([
      expect.objectContaining({
        path: "/articles/vid/images/shot.png",
        blockIndex: 3,
      }),
    ]);
    expect(parsed.contentVideos).toEqual([
      expect.objectContaining({
        path: "/articles/vid/video/clip.mp4",
        blockIndex: 3,
      }),
    ]);
    expect(parsed.dividers).toEqual([
      expect.objectContaining({ blockIndex: 2, afterText: "Section" }),
      expect.objectContaining({ blockIndex: 3 }),
    ]);
    expect(parsed.totalBlocks).toBe(4);
    expect(parsed.html).toContain("<strong>bold</strong>");
    expect(parsed.html).toContain("<h2>Section</h2>");
    expect(parsed.html).toContain("<ul>");
    expect(parsed.htmlBlocks).toEqual([
      expect.stringContaining("<strong>bold</strong>"),
      expect.stringContaining("<h2>Section</h2>"),
      expect.stringContaining("<ul>"),
      expect.stringContaining("<blockquote>"),
    ]);
  });

  it("uses a generated cover fallback when Markdown has no images", () => {
    const parsed = parseArticleDraftFromMarkdown("# Title\n\nBody", {
      resolveMediaPath: (source) => source,
      fallbackCoverImage: "/cover.png",
    });

    expect(parsed.coverImage).toBe("/cover.png");
    expect(parsed.contentImages).toEqual([]);
  });

  it("extracts fenced code blocks and anchors following media", () => {
    const parsed = parseArticleDraftFromMarkdown(
      [
        "# Title",
        "",
        "![cover](images/cover.png)",
        "",
        "Intro",
        "",
        "```text",
        "Copy this prompt",
        "Topic = demo",
        "```",
        "",
        "![shot](images/shot.png)",
      ].join("\n"),
      { resolveMediaPath: (source) => source },
    );

    expect(parsed.contentCodeBlocks).toEqual([
      {
        code: "Copy this prompt\nTopic = demo",
        language: "text",
        blockIndex: 1,
        afterText: "Intro",
      },
    ]);
    expect(parsed.contentImages).toEqual([
      expect.objectContaining({ afterText: "Topic = demo" }),
    ]);
    expect(parsed.html).not.toContain("Copy this prompt");
  });

  it("skips English-only markdown paragraphs and inline English lead-ins", () => {
    const parsed = parseArticleDraftFromMarkdown(
      [
        "# 中文标题",
        "",
        "Check if I have Git installed. If not, install it for me.",
        "",
        "你有一个应用想法，但不会写代码。",
      ].join("\n"),
      { resolveMediaPath: (source) => source },
    );

    expect(parsed.html).not.toContain("Git installed");
    expect(parsed.html).toContain("你有一个应用想法");
  });

  it("skips English prompt artifact code blocks", () => {
    const parsed = parseArticleDraftFromMarkdown(
      [
        "# Title",
        "",
        "Intro",
        "",
        "```text",
        "Create a new GitHub repository for this project.",
        "Summarize everything important about this project.",
        "```",
        "",
        "![shot](images/shot.png)",
      ].join("\n"),
      { resolveMediaPath: (source) => source },
    );

    expect(parsed.contentCodeBlocks).toEqual([]);
    expect(parsed.html).not.toContain("GitHub repository");
  });

  it("dedupes repeated local media paths by earliest block index", () => {
    const parsed = parseArticleDraftFromMarkdown(
      [
        "# Title",
        "",
        "![cover](images/cover.png)",
        "",
        "Intro",
        "",
        "![shot](images/scene_001.jpg)",
        "",
        "## Section",
        "",
        "![shot](images/scene_001.jpg)",
      ].join("\n"),
      { resolveMediaPath: (source) => source },
    );

    expect(parsed.contentImages).toEqual([
      expect.objectContaining({ path: "images/scene_001.jpg", blockIndex: 1 }),
    ]);
  });

  it("drops duplicate footer markdown blocks", () => {
    const parsed = parseArticleDraftFromMarkdown(
      [
        "# Title",
        "",
        "Body",
        "",
        "可复制提示词：开放问题",
        "",
        "👇完整视频：",
        "https://example.com/watch?v=demo",
        "",
        "可复制提示词：重复尾注",
      ].join("\n"),
      { resolveMediaPath: (source) => source },
    );

    expect(parsed.html.match(/可复制提示词/gu)?.length ?? 0).toBe(1);
  });

  it("strips leading English boilerplate before the first Chinese section", () => {
    const parsed = parseArticleDraftFromMarkdown(
      [
        "# 中文标题",
        "",
        "![cover](images/cover.png)",
        "",
        "Is there anything else I should be aware of before making this live?",
        "Create a new GitHub repository for this project.",
        "",
        "你有一个应用想法，但不会写代码。",
        "",
        "## Claude Code 是什么",
      ].join("\n"),
      { resolveMediaPath: (source) => source },
    );

    expect(parsed.html).not.toContain("GitHub repository");
    expect(parsed.html).toContain("你有一个应用想法");
    expect(parsed.html).toContain("<h2>Claude Code 是什么</h2>");
  });

  it("adds one publish divider after each H2 without duplicating an explicit divider", () => {
    const parsed = parseArticleDraftFromMarkdown("# Title\n\n## One\n\nBody\n\n## Two\n\n---\n\nTail", {
      resolveMediaPath: (source) => source,
    });

    expect(parsed.dividers).toEqual([
      expect.objectContaining({ blockIndex: 1, afterText: "One" }),
      expect.objectContaining({ blockIndex: 3, afterText: "Two" }),
    ]);
  });

  it("preserves author content without generating structural inserts for Markdown imports", () => {
    const parsed = parseArticleDraftFromMarkdown(
      [
        "# 中文标题",
        "",
        "An English introduction that must remain in an imported draft.",
        "",
        "## Section",
        "",
        "```text",
        "Create a new GitHub repository for this project.",
        "Summarize everything important about this project.",
        "```",
        "",
        "---",
        "",
        "正文。",
      ].join("\n"),
      { resolveMediaPath: (source) => source, preserveSourceContent: true },
    );

    expect(parsed.contentCodeBlocks).toEqual([]);
    expect(parsed.dividers).toEqual([]);
    expect(parsed.html).toContain("An English introduction");
    expect(parsed.html).toContain("<pre><code>Create a new GitHub repository");
    expect(parsed.html).toContain("<hr>");
  });

  it("keeps imported prose while mapping dividers, lists, and prompt blocks to native X blocks", () => {
    const parsed = parseArticleDraftFromMarkdown(
      [
        "# 中文标题",
        "",
        "An English introduction that must remain in an imported draft.",
        "",
        "## Section",
        "",
        "**Prompt examples:**",
        "- first point",
        "- second point",
        "",
        "```text",
        "Create a new GitHub repository for this project.",
        "Summarize everything important about this project.",
        "```",
        "",
        "正文。",
      ].join("\n"),
      {
        resolveMediaPath: (source) => source,
        preserveSourceContent: true,
        useNativeEditorBlocks: true,
      },
    );

    expect(parsed.html).toContain("An English introduction");
    expect(parsed.html).toContain("<p><strong>Prompt examples:</strong></p>");
    expect(parsed.html).toContain("<ul>");
    expect(parsed.html).not.toContain("<pre>");
    expect(parsed.dividers).toEqual([expect.objectContaining({ afterText: "Section" })]);
    expect(parsed.contentCodeBlocks).toEqual([
      expect.objectContaining({
        code: "Create a new GitHub repository for this project.\nSummarize everything important about this project.",
        language: "text",
      }),
    ]);
  });
});

describe("collectLocalMediaReferences", () => {
  it("collects image and video paths from markdown", () => {
    expect(
      collectLocalMediaReferences(
        "![a](images/a.png)\n<video src=\"clips/b.mp4\"></video>\n![c](/abs/c.jpg)",
      ),
    ).toEqual(["images/a.png", "clips/b.mp4", "/abs/c.jpg"]);
  });

  it("ignores remote image and video URLs", () => {
    expect(
      collectLocalMediaReferences(
        "![remote](https://example.com/a.png)\n<video src=\"https://example.com/b.mp4\"></video>",
      ),
    ).toEqual([]);
  });
});

describe("isLocalMediaReference", () => {
  it("treats http(s) and data URLs as non-local", () => {
    expect(isLocalMediaReference("https://example.com/a.png")).toBe(false);
    expect(isLocalMediaReference("data:image/png;base64,abc")).toBe(false);
    expect(isLocalMediaReference("images/a.png")).toBe(true);
  });
});
