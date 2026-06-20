import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewExistingArticleImages } from "./prompt-orchestrator.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "yt2x-prompt-orch-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── splitBodyIntoSections (tested via previewExistingArticleImages section parsing) ──

describe("previewExistingArticleImages", () => {
  it("returns null when no article text exists", async () => {
    const result = await previewExistingArticleImages(tmpRoot, "x");
    expect(result).toBeNull();
  });

  it("renders X preview with cover and sections", async () => {
    const imagesDir = path.join(tmpRoot, "images");
    await mkdir(imagesDir, { recursive: true });
    // Create a fake cover image
    await writeFile(path.join(imagesDir, "cover.png"), Buffer.alloc(1));

    const articleMd = [
      "# My Article Title",
      "",
      "Intro paragraph here.",
      "",
      "![cover](images/cover.png)",
      "",
      "## Section One",
      "Content of section one.",
      "",
      "## Section Two",
      "Content of section two with **bold** text.",
    ].join("\n");
    await writeFile(path.join(tmpRoot, "article.md"), articleMd, "utf8");

    const result = await previewExistingArticleImages(tmpRoot, "x");
    expect(result).not.toBeNull();
    expect(result!.coverCount).toBe(1);
    expect(result!.html).toContain("My Article Title");
    expect(result!.html).toContain("Section One");
    expect(result!.html).toContain("Section Two");
    expect(result!.html).toContain("cover-img");
    // X uses article-body wrapper, not XHS gallery
    expect(result!.html).toContain("article-body");
    expect(result!.html).not.toContain("xhs-gallery");
  });

  it("strips X image references when XHS falls back to article.md", async () => {
    // No xiaohongshu-article.md — should fall back to article.md
    const imagesDir = path.join(tmpRoot, "images");
    await mkdir(imagesDir, { recursive: true });
    await writeFile(path.join(imagesDir, "img1.png"), Buffer.alloc(1));
    await writeFile(path.join(imagesDir, "img2.png"), Buffer.alloc(1));

    const articleMd = [
      "# 测试文章",
      "",
      "![cover](images/img1.png)",
      "",
      "## 第一节",
      "内容。![插图](images/img2.png)",
    ].join("\n");
    await writeFile(path.join(tmpRoot, "article.md"), articleMd, "utf8");

    const result = await previewExistingArticleImages(tmpRoot, "xiaohongshu");
    expect(result).not.toBeNull();
    // XHS gallery layout should be present
    expect(result!.html).toContain("xhs-gallery");
    expect(result!.html).toContain("xhs-article");
    // X images should NOT appear (stripped on fallback)
    expect(result!.html).not.toContain("img1.png");
    expect(result!.html).not.toContain("img2.png");
  });

  it("renders XHS gallery + article layout with xiaohongshu-article.md", async () => {
    const xhsArticle = [
      "# 小红书文章",
      "",
      "**对比封面图**",
      "左边是Claude Code的限速和封号问题，右边是Codex APP的优势。",
      "",
      "---",
      "",
      "**⚡ 5分钟安装流程**",
      "安装前确保有Git、Node.js和VS Code。官网自动匹配系统包。",
      "",
      "**🔄 三栏并行任务布局**",
      "三栏布局：左侧任务列表，中间对话，右侧多功能。",
    ].join("\n");
    await mkdir(path.join(tmpRoot, "xiaohongshu-format"), { recursive: true });
    await writeFile(path.join(tmpRoot, "xiaohongshu-format", "xiaohongshu-article.md"), xhsArticle, "utf8");

    const result = await previewExistingArticleImages(tmpRoot, "xiaohongshu");
    expect(result).not.toBeNull();
    expect(result!.html).toContain("xhs-gallery");
    expect(result!.html).toContain("xhs-article");
    expect(result!.html).toContain("小红书文章");
    // XHS sections parsed correctly (bold headers, not ##)
    expect(result!.html).toContain("5分钟安装流程");
    expect(result!.html).toContain("三栏并行任务布局");
    // Should NOT use article-body (X layout)
    expect(result!.html).not.toContain("article-body");
  });

  it("shows XHS gallery prompt placeholders from prompts.json", async () => {
    // Create xiaohongshu-article.md
    const xhsArticle = [
      "# 测试",
      "",
      "**第一节标题**",
      "第一节内容。",
      "",
      "**第二节标题**",
      "第二节内容。",
    ].join("\n");
    await mkdir(path.join(tmpRoot, "xiaohongshu-format"), { recursive: true });
    await writeFile(path.join(tmpRoot, "xiaohongshu-format", "xiaohongshu-article.md"), xhsArticle, "utf8");

    // Create prompts.json with cover + illustration prompts
    const formatDir = path.join(tmpRoot, "xiaohongshu-format");
    await mkdir(formatDir, { recursive: true });
    const prompts = {
      platform: "xiaohongshu",
      title: "测试",
      coverPrompts: [
        {
          label: "小红书封面 3:4",
          prompt: "A 3:4 portrait cover image for Xiaohongshu...",
          size: "1080×1440",
          filename: "cover-test.png",
          name: "测试封面",
        },
      ],
      illustrationPrompts: [
        {
          index: 0,
          text: "第一节内容",
          prompt: "Illustration for section one... Aspect ratio: 3:4 portrait (1080×1440).",
          filename: "illus-section-one.png",
          name: "第一节插图",
        },
        {
          index: 1,
          text: "第二节内容",
          prompt: "Illustration for section two... Aspect ratio: 3:4 portrait (1080×1440).",
          filename: "illus-section-two.png",
          name: "第二节插图",
        },
      ],
    };
    await writeFile(path.join(formatDir, "prompts.json"), JSON.stringify(prompts), "utf8");

    // Build promptMap matching illustration prompts
    const promptMap = new Map<number, string>();
    promptMap.set(0, prompts.illustrationPrompts[0].prompt);
    promptMap.set(1, prompts.illustrationPrompts[1].prompt);

    const result = await previewExistingArticleImages(tmpRoot, "xiaohongshu", promptMap);
    expect(result).not.toBeNull();
    // Gallery shows cover + 2 illustration prompts
    expect(result!.html).toContain("xhs-gallery");
    expect(result!.html).toContain("测试封面");
    expect(result!.html).toContain("第一节插图");
    expect(result!.html).toContain("第二节插图");
    // Cover prompt appears with correct label
    expect(result!.html).toContain("🎨 封面 · 3:4");
  });

  it("shows 'needs format' note when no prompts and no images exist", async () => {
    await mkdir(path.join(tmpRoot, "xiaohongshu-format"), { recursive: true });
    await writeFile(
      path.join(tmpRoot, "xiaohongshu-format", "xiaohongshu-article.md"),
      "# 空文章\n\n**标题**\n内容。",
      "utf8",
    );

    const result = await previewExistingArticleImages(tmpRoot, "xiaohongshu");
    expect(result).not.toBeNull();
    expect(result!.html).toContain("尚未排版");
  });

  it("uses prompts.json names in XHS gallery when available", async () => {
    const xhsArticle = "# 测试\n\n**唯一章节**\n章节内容。";
    const formatDir = path.join(tmpRoot, "xiaohongshu-format");
    await mkdir(formatDir, { recursive: true });
    await writeFile(path.join(formatDir, "xiaohongshu-article.md"), xhsArticle, "utf8");
    await mkdir(formatDir, { recursive: true });
    await writeFile(
      path.join(formatDir, "prompts.json"),
      JSON.stringify({
        platform: "xiaohongshu",
        title: "测试",
        coverPrompts: [
          {
            label: "封面",
            prompt: "Cover prompt...",
            size: "1080×1440",
            filename: "cover.png",
            name: "我的封面名",
          },
        ],
        illustrationPrompts: [
          {
            index: 0,
            text: "章节内容",
            prompt: "Ill prompt...",
            filename: "ill.png",
            name: "我的插图名",
          },
        ],
      }),
      "utf8",
    );

    // Build promptMap matching the illustration prompt from prompts.json
    const promptMap = new Map<number, string>();
    promptMap.set(0, "Ill prompt...");

    const result = await previewExistingArticleImages(tmpRoot, "xiaohongshu", promptMap);
    expect(result).not.toBeNull();
    expect(result!.html).toContain("我的封面名");
    expect(result!.html).toContain("我的插图名");
  });

  it("shows actual cover image in XHS gallery when image exists", async () => {
    const imagesDir = path.join(tmpRoot, "images");
    await mkdir(imagesDir, { recursive: true });
    await writeFile(path.join(imagesDir, "mycover.png"), Buffer.alloc(1));

    const xhsArticle = [
      "# 有封面的文章",
      "",
      "![封面](images/mycover.png)",
      "",
      "**第一节**",
      "内容。",
    ].join("\n");
    await mkdir(path.join(tmpRoot, "xiaohongshu-format"), { recursive: true });
    await writeFile(path.join(tmpRoot, "xiaohongshu-format", "xiaohongshu-article.md"), xhsArticle, "utf8");

    const result = await previewExistingArticleImages(tmpRoot, "xiaohongshu");
    expect(result).not.toBeNull();
    expect(result!.coverCount).toBe(1);
    expect(result!.html).toContain("mycover.png");
    expect(result!.html).toContain("封面");
  });
});

// ── Platform-specific preview behavior ──

describe("previewExistingArticleImages platform-specific", () => {
  it("renders bilibili preview with article.md sections", async () => {
    const articleMd = [
      "# B站文章",
      "",
      "## 第一部分",
      "内容A。",
      "",
      "## 第二部分",
      "内容B。",
    ].join("\n");
    await writeFile(path.join(tmpRoot, "article.md"), articleMd, "utf8");

    const result = await previewExistingArticleImages(tmpRoot, "bilibili");
    expect(result).not.toBeNull();
    expect(result!.html).toContain("B站文章");
    expect(result!.html).toContain("第一部分");
    expect(result!.html).toContain("第二部分");
    // Bilibili uses article-body, not xhs-gallery
    expect(result!.html).toContain("article-body");
    expect(result!.html).not.toContain("xhs-gallery");
  });

  it("renders wechat preview with article.md", async () => {
    const articleMd = "# 公众号\n\n## 章节\n内容。";
    await writeFile(path.join(tmpRoot, "article.md"), articleMd, "utf8");

    const result = await previewExistingArticleImages(tmpRoot, "wechat");
    expect(result).not.toBeNull();
    expect(result!.html).toContain("公众号");
  });
});
