import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertArticleDraftImagesExist, parseArticleDraftMarkdown } from "./parse-article-draft.js";

describe("parseArticleDraftMarkdown", () => {
  it("extracts title, cover, content media, dividers, and rich HTML blocks", () => {
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
        '<video controls src="video/clip.mp4"></video>',
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
    expect(parsed.contentVideos).toEqual([
      expect.objectContaining({
        path: path.resolve("/articles/vid/video/clip.mp4"),
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
  });

  it("uses a generated cover fallback when Markdown has no images", () => {
    const parsed = parseArticleDraftMarkdown("# Title\n\nBody", "/articles/vid", "/cover.png");

    expect(parsed.coverImage).toBe("/cover.png");
    expect(parsed.contentImages).toEqual([]);
    expect(parsed.contentVideos).toEqual([]);
    expect(parsed.contentCodeBlocks).toEqual([]);
  });

  it("extracts fenced code blocks for native X code insertion and anchors following media", () => {
    const parsed = parseArticleDraftMarkdown(
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
      "/articles/vid",
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
    expect(parsed.html).not.toContain("<pre>");
  });

  it("adds one publish divider after each H2 without duplicating an explicit divider", () => {
    const parsed = parseArticleDraftMarkdown(
      "# Title\n\n## One\n\nBody\n\n## Two\n\n---\n\nTail",
      "/articles/vid",
    );

    expect(parsed.dividers).toEqual([
      expect.objectContaining({ blockIndex: 1, afterText: "One" }),
      expect.objectContaining({ blockIndex: 3, afterText: "Two" }),
    ]);
  });

  it("reports missing draft videos before browser automation", async () => {
    const articleDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-draft-video-"));
    try {
      const parsed = parseArticleDraftMarkdown(
        '# Title\n\n<video controls src="video/missing.mp4"></video>',
        articleDir,
      );

      await expect(assertArticleDraftImagesExist(parsed)).rejects.toThrow(/content video was not found/);
    } finally {
      await rm(articleDir, { recursive: true, force: true });
    }
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
