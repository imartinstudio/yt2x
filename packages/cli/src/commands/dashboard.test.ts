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
    await writeFile(path.join(articleOutDir, videoId, "article.md"), "# **正式发布标题**\n\n正文");
    await writeFile(path.join(articleOutDir, videoId, "xiaohongshu-article.md"), "# 小红书");
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
  });
});
