import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWechatFormatter, formatWechatArticle } from "./formatter.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "yt2x-wechat-format-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checkWechatFormatter", () => {
  it("always succeeds — the formatter is self-contained with no external deps", async () => {
    const result = await checkWechatFormatter();
    expect(result.ok).toBe(true);
    expect(result.pythonBin).toBe("builtin");
    expect(result.checks.formatterDir).toBe(true);
    expect(result.checks.script).toBe(true);
    expect(result.checks.config).toBe(true);
    expect(result.checks.python).toBe(true);
    expect(result.checks.markdown).toBe(true);
    expect(result.checks.requests).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("ignores deprecated input fields", async () => {
    const result = await checkWechatFormatter({
      formatterDir: "/nonexistent/path",
      pythonBin: "/usr/bin/python3",
      env: {},
      runner: {},
    });
    expect(result.ok).toBe(true);
  });
});

describe("formatWechatArticle", () => {
  it("renders article.md and writes article.html / preview.html", async () => {
    const articleDir = path.join(root, "articles", "video123");
    await mkdir(articleDir, { recursive: true });
    const markdown = "# **测试标题**\n\n正文段落。\n\n```js\nconsole.log(1);\n```\n\n![alt text](image.png)\n";
    await writeFile(path.join(articleDir, "article.md"), markdown, "utf8");

    const result = await formatWechatArticle({
      articleDir,
      theme: "github",
    });

    expect(result.inputPath).toBe(path.join(articleDir, "article.md"));
    expect(result.outputBaseDir).toBe(path.join(articleDir, "wechat-format"));
    expect(result.formattedDir).toBe(path.join(articleDir, "wechat-format", "article"));
    expect(result.articleHtmlPath).toBe(path.join(result.formattedDir, "article.html"));
    expect(result.previewHtmlPath).toBe(path.join(result.formattedDir, "preview.html"));
    expect(result.theme).toBe("github");
    expect(result.command).toBe("builtin");
    expect(result.args).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    // Verify files were written and contain expected content
    const { readFile } = await import("node:fs/promises");
    const articleHtml = await readFile(result.articleHtmlPath, "utf8");
    const previewHtml = await readFile(result.previewHtmlPath, "utf8");

    expect(articleHtml).toContain("测试标题");
    expect(articleHtml).toContain('<section style="');
    expect(articleHtml).toContain("正文段落");
    expect(previewHtml).toContain("<!doctype html>");
    expect(previewHtml).toContain('<div class="wx-article">');

    // Code blocks should NOT be corrupted by <p> → <pre> collision
    expect(articleHtml).toContain("<pre style=");
    // Should NOT contain mangled tag like <p style="..."re>
    expect(articleHtml).not.toMatch(/<p style="[^"]*"re>/);

    // Title should be HTML-escaped
    expect(articleHtml).toContain("测试标题");
  });

  it("falls back to default theme for unknown theme ids", async () => {
    const articleDir = path.join(root, "articles", "video456");
    await mkdir(articleDir, { recursive: true });
    await writeFile(path.join(articleDir, "article.md"), "# Title\n\nBody text.", "utf8");

    const result = await formatWechatArticle({
      articleDir,
      theme: "nonexistent-theme",
    });

    // Returns the resolved theme id, not the user-provided one
    expect(result.theme).toBe("github");
  });

  it("uses custom outputDir when provided", async () => {
    const articleDir = path.join(root, "articles", "video789");
    await mkdir(articleDir, { recursive: true });
    await writeFile(path.join(articleDir, "article.md"), "# Test\n\nContent.", "utf8");

    const customOutput = path.join(root, "custom-format");
    const result = await formatWechatArticle({
      articleDir,
      outputDir: customOutput,
    });

    expect(result.outputBaseDir).toBe(customOutput);
    expect(result.formattedDir).toBe(path.join(customOutput, "article"));
  });

  it("reads an explicit sourceFile", async () => {
    const articleDir = path.join(root, "articles", "video000");
    await mkdir(articleDir, { recursive: true });
    await writeFile(path.join(articleDir, "wechat-article.md"), "# Legacy\n\nContent.", "utf8");

    const result = await formatWechatArticle({
      articleDir,
      sourceFile: "wechat-article.md",
    });

    expect(result.inputPath).toBe(path.join(articleDir, "wechat-article.md"));
    expect(result.formattedDir).toContain("wechat-article");
  });

  it("fails clearly when article.md is missing", async () => {
    const articleDir = path.join(root, "articles", "empty");
    await mkdir(articleDir, { recursive: true });

    await expect(formatWechatArticle({
      articleDir,
    })).rejects.toThrow(/Missing WeChat source article/);
  });
});
