import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanDashboardVideos } from "./dashboard.js";

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
