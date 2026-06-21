import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as dashboard from "./dashboard.js";

const { scanDashboardVideos } = dashboard;

describe("scanDashboardVideos", () => {
  it("merges local artifacts, metadata, and publish status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-dashboard-"));
    const articleOutDir = path.join(root, "articles");
    const downloadsDir = path.join(root, "downloads");
    const videoId = "video123";
    await mkdir(path.join(articleOutDir, videoId), { recursive: true });
    await mkdir(path.join(downloadsDir, videoId), { recursive: true });
    await mkdir(path.join(articleOutDir, videoId, "x-format"), { recursive: true });
    await mkdir(path.join(articleOutDir, videoId, "wechat-format", "article"), { recursive: true });
    await writeFile(path.join(articleOutDir, videoId, "article.md"), "# **正式发布标题**\n\n正文");
    await writeFile(path.join(articleOutDir, videoId, "x-format", "x-article.md"), "# **正式发布标题**\n\n正文");
    await writeFile(path.join(articleOutDir, videoId, "x-format", "x-short.md"), "# **正式发布标题**\n\n正文");
    await writeFile(path.join(articleOutDir, videoId, "wechat-format", "article", "article.html"), "<article>html</article>");
    await writeFile(path.join(articleOutDir, videoId, "wechat-format", "article", "preview.html"), "<html>preview</html>");
    await writeFile(path.join(downloadsDir, videoId, "metadata.json"), JSON.stringify({ title: "真实标题" }));
    const indexPath = path.join(root, "publish-index.json");
    await writeFile(
      indexPath,
      JSON.stringify({
        videos: {
          [videoId]: {
            platforms: {
              xiaohongshu: { published: true, url: "https://example.com/xhs", note: "done" },
            },
          },
        },
      }),
    );

    const result = await scanDashboardVideos({ articleOutDir, downloadsDir, indexPath });
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]!.title).toBe("正式发布标题");
    expect(result.videos[0]!.originalTitle).toBe("真实标题");
    expect(result.videos[0]!.platforms.x.generated).toBe(true);
    expect(result.videos[0]!.platforms.x.published).toBe(false);
    expect(result.videos[0]!.platforms.xiaohongshu.generated).toBe(true);
    expect(result.videos[0]!.platforms.xiaohongshu.published).toBe(true);
    expect(result.videos[0]!.platforms.xiaohongshu.url).toBe("https://example.com/xhs");
    expect(result.videos[0]!.platforms.wechat.generated).toBe(true);
    expect(result.videos[0]!.platforms.wechat.formatStatus).toBe("formatted");
    expect(result.videos[0]!.platforms.wechat.htmlPath).toContain("wechat-format");
  });

  it("shows failed status when index has formatStatus failed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-dashboard-"));
    const articleOutDir = path.join(root, "articles");
    const downloadsDir = path.join(root, "downloads");
    const videoId = "fail123";
    await mkdir(path.join(articleOutDir, videoId), { recursive: true });
    await mkdir(path.join(downloadsDir, videoId), { recursive: true });
    await writeFile(path.join(articleOutDir, videoId, "article.md"), "# 标题");
    const indexPath = path.join(root, "publish-index.json");
    await writeFile(
      indexPath,
      JSON.stringify({
        videos: {
          [videoId]: {
            platforms: {
              xiaohongshu: { formatStatus: "failed", formatError: "API timeout" },
              bilibili: { formatStatus: "failed", formatError: "no-llm-key" },
            },
          },
        },
      }),
    );
    const result = await scanDashboardVideos({ articleOutDir, downloadsDir, indexPath });
    expect(result.videos[0]!.platforms.xiaohongshu.status).toBe("failed");
    expect(result.videos[0]!.platforms.xiaohongshu.formatError).toBe("API timeout");
    expect(result.videos[0]!.platforms.bilibili.status).toBe("failed");
    expect(result.videos[0]!.platforms.bilibili.formatError).toBe("no-llm-key");
  });

  it("reads bilibili primaryFile as video-info.md", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-dashboard-"));
    const articleOutDir = path.join(root, "articles");
    const downloadsDir = path.join(root, "downloads");
    const videoId = "bili123";
    await mkdir(path.join(articleOutDir, videoId, "bilibili-format"), { recursive: true });
    await mkdir(path.join(downloadsDir, videoId), { recursive: true });
    await writeFile(path.join(articleOutDir, videoId, "article.md"), "# 标题");
    await writeFile(path.join(articleOutDir, videoId, "bilibili-format", "video-info.md"), "## 视频信息\n\n正文");
    const indexPath = path.join(root, "publish-index.json");
    await writeFile(indexPath, JSON.stringify({}));
    const result = await scanDashboardVideos({ articleOutDir, downloadsDir, indexPath });
    expect(result.videos[0]!.platforms.bilibili.files).toContain("bilibili-format/video-info.md");
    expect(result.videos[0]!.platforms.bilibili.generated).toBe(true);
  });

  it("wechat formatted requires article.html and preview.html", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-dashboard-"));
    const articleOutDir = path.join(root, "articles");
    const downloadsDir = path.join(root, "downloads");
    const videoId = "wechat123";
    await mkdir(path.join(articleOutDir, videoId, "wechat-format", "article"), { recursive: true });
    await mkdir(path.join(downloadsDir, videoId), { recursive: true });
    await writeFile(path.join(articleOutDir, videoId, "article.md"), "# 标题");
    await writeFile(path.join(articleOutDir, videoId, "wechat-format", "article", "article.html"), "<html>article</html>");
    const indexPath = path.join(root, "publish-index.json");
    await writeFile(indexPath, JSON.stringify({}));
    const result = await scanDashboardVideos({ articleOutDir, downloadsDir, indexPath });
    expect(result.videos[0]!.platforms.wechat.formatStatus).toBe("none");
  });
});

describe("decodeDashboardImage", () => {
  it("accepts supported image data URLs and rejects unsupported or oversized input", () => {
    const decodeDashboardImage = (dashboard as Record<string, unknown>)["decodeDashboardImage"] as
      | ((dataUrl: string) => { data: Buffer; extension: string })
      | undefined;

    expect(decodeDashboardImage).toBeTypeOf("function");
    expect(decodeDashboardImage!("data:image/png;base64,AA==")).toEqual({
      data: Buffer.from([0]),
      extension: ".png",
    });
    expect(() => decodeDashboardImage!("data:image/gif;base64,AA==")).toThrow("仅支持 JPG、PNG、WebP 图片");
    expect(() => decodeDashboardImage!("data:image/png;base64," + Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"))).toThrow(
      "图片不能超过 10MB",
    );
  });
});

describe("saveDashboardPromptImage", () => {
  it("stores an uploaded image and updates its prompt and Markdown reference", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-dashboard-upload-"));
    const articleOutDir = path.join(root, "articles");
    const articleDir = path.join(articleOutDir, "video123", "xiaohongshu-format");
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(articleDir, "prompts.json"),
      JSON.stringify({ illustrationPrompts: [{ index: 0, name: "第一节插图", prompt: "绘制第一节" }] }),
    );
    await writeFile(path.join(articleDir, "xiaohongshu-article.md"), "# 标题\n\n**第一节**\n内容。\n");

    const saveDashboardPromptImage = (dashboard as Record<string, unknown>)["saveDashboardPromptImage"] as
      | ((input: { articleOutDir: string; videoId: string; platform: string; promptId: string; dataUrl: string }) => Promise<{ file: string }>)
      | undefined;

    expect(saveDashboardPromptImage).toBeTypeOf("function");
    await expect(
      saveDashboardPromptImage!({
        articleOutDir,
        videoId: "video123",
        platform: "xiaohongshu",
        promptId: "ill-0",
        dataUrl: "data:image/png;base64,AA==",
      }),
    ).resolves.toEqual({ file: "prompt-ill-0.png" });
    await expect(readFile(path.join(articleDir, "images", "prompt-ill-0.png"))).resolves.toEqual(Buffer.from([0]));
    await expect(readFile(path.join(articleDir, "xiaohongshu-article.md"), "utf8")).resolves.toContain(
      "![第一节插图](images/prompt-ill-0.png)",
    );
    await expect(readFile(path.join(articleDir, "prompts.json"), "utf8")).resolves.toContain('"filename": "prompt-ill-0.png"');

    await saveDashboardPromptImage!({
      articleOutDir,
      videoId: "video123",
      platform: "xiaohongshu",
      promptId: "ill-0",
      dataUrl: "data:image/jpeg;base64,AQ==",
    });
    await expect(readFile(path.join(articleDir, "xiaohongshu-article.md"), "utf8")).resolves.not.toContain("prompt-ill-0.png");
    await expect(readFile(path.join(articleDir, "xiaohongshu-article.md"), "utf8")).resolves.toContain("prompt-ill-0.jpg");

    const deleteDashboardPromptImage = (dashboard as Record<string, unknown>)["deleteDashboardPromptImage"] as
      | ((input: { articleOutDir: string; videoId: string; platform: string; promptId: string }) => Promise<void>)
      | undefined;
    expect(deleteDashboardPromptImage).toBeTypeOf("function");
    await deleteDashboardPromptImage!({ articleOutDir, videoId: "video123", platform: "xiaohongshu", promptId: "ill-0" });
    await expect(readFile(path.join(articleDir, "xiaohongshu-article.md"), "utf8")).resolves.not.toContain("prompt-ill-0.jpg");
  });
});
