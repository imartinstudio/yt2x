import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProcessStatusMerged } from "@yt2x/adapters-node";
import { executeNativePublish } from "./native-publish.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-publish-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("executeNativePublish", () => {
  it("rejects path-like video ids", async () => {
    const code = await executeNativePublish({
      videoId: "../outside",
      outDir: path.join(root, "downloads"),
      articleOutDir: path.join(root, "articles"),
      dryRun: true,
    });

    expect(code).toBe(2);
  });

  it("writes preview artifact and publish status on dry-run", async () => {
    const videoId = "dryRunVid1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://youtu.be/dryRunVid1" }),
    );
    await writeFile(path.join(articleDir, "article.md"), "Preview body");

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        dryRun: true,
      });

      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as { format: string; source: string; parts: unknown[] };
    expect(preview.format).toBe("article");
    expect(preview.source).toBe("article.md");
    expect(preview.parts).toHaveLength(1);

    const status = await readProcessStatusMerged(videoDir, {
      videoId,
      url: "https://youtu.be/dryRunVid1",
    });
    expect(status?.steps.publish.status).toBe("done");
    expect(status?.steps.publish.resultFile).toBe("publish-preview.json");
    expect(status?.articleOutDir).toBe(articleDir);
  });

  it("previews generated thread source on dry-run", async () => {
    const videoId = "threadPreview1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/thread-preview" }),
    );
    await writeFile(path.join(articleDir, "x-thread.md"), "# T\n\n1/ first\n\n2/ second\n");

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        target: "x-thread",
        threadSource: "generated",
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as {
      mode: string;
      source: string;
      tweets: string[];
      sourceReply: string;
      threadDelayMs: { min: number; max: number };
    };
    expect(preview.mode).toBe("thread");
    expect(preview.source).toBe("x-thread.md");
    expect(preview.tweets).toEqual(["1/ first", "2/ second"]);
    expect(preview.sourceReply).toBe("👇完整视频：\nhttps://example.com/thread-preview");
    expect(preview.threadDelayMs).toEqual({ min: 20_000, max: 30_000 });
  });

  it("previews generated thread with configured delay", async () => {
    const videoId = "threadDelay1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/thread-delay" }),
    );
    await writeFile(path.join(articleDir, "x-thread.md"), "1/ first\n\n2/ second\n");

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        target: "x-thread",
        threadDelay: "7-9",
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as { threadDelayMs: { min: number; max: number } };
    expect(preview.threadDelayMs).toEqual({ min: 7_000, max: 9_000 });
  });

  it("normalizes generated thread markdown before previewing", async () => {
    const videoId = "threadNormalize1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/thread-normalize" }),
    );
    await writeFile(path.join(articleDir, "x-thread.md"), "1/ **标题：**正文\n- item\n\n2/ | A | B |\n| --- | --- |\n| ok | yes |");

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        target: "x-thread",
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as { tweets: string[] };
    expect(preview.tweets).toEqual(["1/ 标题：正文\n• item", "2/ A ｜ B\nok ｜ yes"]);
  });

  it("keeps blank lines inside numbered generated thread tweets", async () => {
    const videoId = "threadParagraphs1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/thread-paragraphs" }),
    );
    await writeFile(
      path.join(articleDir, "x-thread.md"),
      [
        "1/ **标题：**第一段",
        "",
        "第二段保留在同一条 tweet",
        "",
        "- item",
        "",
        "2/ **下一条：**正文",
      ].join("\n"),
    );

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        target: "x-thread",
        publishMaxChars: "1000",
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as { tweets: string[] };
    expect(preview.tweets).toEqual([
      "1/ 标题：第一段\n\n第二段保留在同一条 tweet\n\n• item",
      "2/ 下一条：正文",
    ]);
  });

  it("rejects invalid thread delay", async () => {
    const code = await executeNativePublish({
      videoId: "badThreadDelay1",
      outDir: path.join(root, "downloads"),
      articleOutDir: path.join(root, "articles"),
      target: "x-thread",
      threadDelay: "9-7",
      dryRun: true,
    });

    expect(code).toBe(2);
  });

  it("rejects over-limit generated thread tweets instead of truncating them", async () => {
    const videoId = "threadTooLong1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/thread-too-long" }),
    );
    await writeFile(path.join(articleDir, "x-thread.md"), `1/ ${"长".repeat(300)}\n`);

    const code = await executeNativePublish({
      videoId,
      outDir,
      articleOutDir,
      target: "x-thread",
      threadSource: "generated",
      publishMaxChars: "500",
      dryRun: true,
    });

    expect(code).toBe(2);
  });

  it("previews short target on dry-run", async () => {
    const videoId = "shortPreview1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/short-preview" }),
    );
    await writeFile(path.join(articleDir, "x-short.md"), "short post body\n");

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        target: "x-short",
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as { mode: string; source: string; text: string; sourceReply: string };
    expect(preview.mode).toBe("short");
    expect(preview.source).toBe("x-short.md");
    expect(preview.text).toBe("short post body");
    expect(preview.sourceReply).toBe("👇完整视频：\nhttps://example.com/short-preview");
  });

  it("normalizes generated short markdown before previewing", async () => {
    const videoId = "shortNormalize1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/short-normalize" }),
    );
    await writeFile(path.join(articleDir, "x-short.md"), "**核心：**正文\n- [x] done\n- next\n");

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        target: "x-short",
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as { text: string };
    expect(preview.text).toBe("核心：正文\n☑ done\n• next");
  });

  it("includes cover path for short target on dry-run", async () => {
    const videoId = "shortCover1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    const coverPath = path.join(articleDir, "images", "cover.png");
    await mkdir(videoDir, { recursive: true });
    await mkdir(path.dirname(coverPath), { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/short-cover" }),
    );
    await writeFile(path.join(articleDir, "x-short.md"), "short with cover\n");
    await writeFile(coverPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        target: "x-short",
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as { coverPath: string | null };
    expect(preview.coverPath).toBe(coverPath);
  });

  it("previews thread-short target with short as head and thread replies", async () => {
    const videoId = "threadShort1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    const coverPath = path.join(articleDir, "images", "cover.jpg");
    await mkdir(videoDir, { recursive: true });
    await mkdir(path.dirname(coverPath), { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/thread-short" }),
    );
    await writeFile(path.join(articleDir, "x-short.md"), "short head\n");
    await writeFile(path.join(articleDir, "x-thread.md"), "# T\n\n1/ first reply\n\n2/ second reply\n");
    await writeFile(coverPath, Buffer.from([0xff, 0xd8, 0xff]));

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        target: "x-thread-short",
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as {
      mode: string;
      source: string;
      text: string;
      replies: string[];
      tweets: string[];
      sourceReply: string;
      coverPath: string | null;
      threadDelayMs: { min: number; max: number };
    };
    expect(preview.mode).toBe("thread-short");
    expect(preview.source).toBe("x-short.md + x-thread.md");
    expect(preview.text).toBe("short head👇");
    expect(preview.replies).toEqual(["1/ first reply", "2/ second reply"]);
    expect(preview.tweets).toEqual(["short head👇", "1/ first reply", "2/ second reply"]);
    expect(preview.sourceReply).toBe("👇完整视频：\nhttps://example.com/thread-short");
    expect(preview.coverPath).toBe(coverPath);
    expect(preview.threadDelayMs).toEqual({ min: 20_000, max: 30_000 });
  });

  it("does not truncate short target with publish max chars", async () => {
    const videoId = "shortNoLimit1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    const longShort = `核心判断：${"短帖内容".repeat(80)}`;
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/short-no-limit" }),
    );
    await writeFile(path.join(articleDir, "x-short.md"), longShort);

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        target: "x-short",
        publishMaxChars: "50",
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as { text: string };
    expect(preview.text).toBe(longShort);
  });

  it("rejects real article publish because X Article has no API path", async () => {
    const videoId = "articleNoApi1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/article-no-api" }),
    );
    await writeFile(path.join(articleDir, "article.md"), "Article body");

    const code = await executeNativePublish({
      videoId,
      outDir,
      articleOutDir,
      target: "article",
      dryRun: false,
    });

    expect(code).toBe(2);
  });

  it("rejects x-thread max tweets above ten", async () => {
    const code = await executeNativePublish({
      videoId: "maxTweets11",
      outDir: path.join(root, "downloads"),
      articleOutDir: path.join(root, "articles"),
      target: "x-thread",
      maxTweets: "11",
      dryRun: true,
    });

    expect(code).toBe(2);
  });
});
