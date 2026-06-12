import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderPlatformArticleMarkdown, writePlatformArticleBundle } from "./file-store.js";

let articleRoot: string;

beforeEach(async () => {
  articleRoot = await mkdtemp(path.join(tmpdir(), "yt2x-platform-article-out-"));
});

afterEach(async () => {
  await rm(articleRoot, { recursive: true, force: true });
});

describe("renderPlatformArticleMarkdown", () => {
  it("renders xiaohongshu markdown", () => {
    const md = renderPlatformArticleMarkdown({
      target: "xiaohongshu",
      titles: ["t1", "t2", "t3", "t4", "t5"],
      body: "body",
      tags: ["tag1", "#tag2", "tag3"],
      cover: { headline: "h", visual_prompt: "v" },
    });
    expect(md).toMatch(/# 小红书笔记/);
    expect(md).toMatch(/#tag1 #tag2 #tag3/);
  });

  it("renders bilibili timeline markdown", () => {
    const md = renderPlatformArticleMarkdown({
      target: "bilibili",
      title: "title",
      description: "desc",
      category: "科技",
      tags: ["a", "b", "c"],
      timeline: [{ time: "00:00", title: "开场", description: "看点" }],
      comment_prompt: "你怎么看？",
    });
    expect(md).toMatch(/# title/);
    expect(md).toMatch(/00:00 开场：看点/);
  });
});

describe("writePlatformArticleBundle", () => {
  it("writes platform markdown and metadata json", async () => {
    const written = await writePlatformArticleBundle(articleRoot, "v1", {
      target: "wechat",
      title: "title",
      title_options: ["a", "b", "c"],
      summary: "summary",
      lead: "lead",
      body: "body",
      cover: { headline: "h", visual_prompt: "v" },
    });
    expect(path.basename(written.articlePath)).toBe("wechat-article.md");
    expect(await readFile(written.articlePath, "utf8")).toMatch(/# title/);
    const metadata = JSON.parse(await readFile(written.metadataPath, "utf8")) as { target: string };
    expect(metadata.target).toBe("wechat");
  });

  it("refuses overwrite without --force", async () => {
    const article = {
      target: "bilibili" as const,
      title: "title",
      description: "desc",
      category: "科技",
      tags: ["a", "b", "c"],
      timeline: [{ time: "", title: "开场", description: "看点" }],
      comment_prompt: "你怎么看？",
    };
    await writePlatformArticleBundle(articleRoot, "v1", article);
    await expect(writePlatformArticleBundle(articleRoot, "v1", article)).rejects.toThrow(/already exists/);
  });
});
