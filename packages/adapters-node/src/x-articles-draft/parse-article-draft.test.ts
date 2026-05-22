import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertArticleDraftImagesExist, parseArticleDraftMarkdown } from "./parse-article-draft.js";

describe("parseArticleDraftMarkdown", () => {
  it("extracts title, cover, content images, dividers, and rich HTML blocks", () => {
    const parsed = parseArticleDraftMarkdown(
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
        "---",
        "",
        "> quote",
      ].join("\n"),
      "/articles/vid",
    );

    expect(parsed.title).toBe("Draft title");
    expect(parsed.coverImage).toBe(path.resolve("/articles/vid/images/cover.jpg"));
    expect(parsed.contentImages).toEqual([
      expect.objectContaining({
        path: path.resolve("/articles/vid/images/shot.png"),
        blockIndex: 3,
      }),
    ]);
    expect(parsed.dividers).toEqual([expect.objectContaining({ blockIndex: 3 })]);
    expect(parsed.totalBlocks).toBe(4);
    expect(parsed.html).toContain("<strong>bold</strong>");
    expect(parsed.html).toContain("<h2>Section</h2>");
    expect(parsed.html).toContain("<ul>");
  });

  it("uses a generated cover fallback when Markdown has no images", () => {
    const parsed = parseArticleDraftMarkdown("# Title\n\nBody", "/articles/vid", "/cover.png");

    expect(parsed.coverImage).toBe("/cover.png");
    expect(parsed.contentImages).toEqual([]);
  });

  it("reports missing draft images before browser automation", async () => {
    const articleDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-draft-images-"));
    try {
      await mkdir(path.join(articleDir, "images"));
      await writeFile(path.join(articleDir, "images", "cover.png"), "cover");
      const parsed = parseArticleDraftMarkdown(
        "# Title\n\n![cover](images/cover.png)\n\n![shot](images/missing.png)",
        articleDir,
      );

      await expect(assertArticleDraftImagesExist(parsed)).rejects.toThrow(/content image was not found/);
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
  });
});
