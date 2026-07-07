import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as AdaptersNode from "@yt2x/adapters-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateXArticleContentMock = vi.hoisted(() => vi.fn());
const generateXThreadContentMock = vi.hoisted(() => vi.fn());
const generatePlatformArticleContentMock = vi.hoisted(() =>
  vi.fn(async () => ({
    videoId: "platformOnly1",
    model: "test-model",
    finishReason: "stop",
    durationMs: 1,
    platformArticle: {
      target: "xiaohongshu",
      title: "小红书标题",
      body: "小红书正文",
      tags: ["AI", "效率", "工具"],
      cover: { headline: "封面标题", visual_prompt: "封面图建议" },
    },
  })),
);
const writePlatformArticleBundleMock = vi.hoisted(() =>
  vi.fn(async (articleOutDir: string, videoId: string) => ({
    articleDir: path.join(articleOutDir, videoId),
    articlePath: path.join(articleOutDir, videoId, "xiaohongshu-article.md"),
    metadataPath: path.join(articleOutDir, videoId, "xiaohongshu-metadata.json"),
  })),
);
const writeNativeArticleBundleMock = vi.hoisted(() =>
  vi.fn(async (_articleOutDir: string, _videoId: string) => null),
);

vi.mock("@yt2x/adapters-node", async (importOriginal) => {
  const actual = await importOriginal<typeof AdaptersNode>();
  return {
    ...actual,
    createLlmAdapter: vi.fn(() => ({ chat: vi.fn() })),
    generateXArticleContent: generateXArticleContentMock,
    generateXThreadContent: generateXThreadContentMock,
    generatePlatformArticleContent: generatePlatformArticleContentMock,
    patchProcessStatus: vi.fn(async () => {}),
    patchStepRunning: vi.fn(async () => {}),
    readStructuredNotesArtifacts: vi.fn(async (videoDir: string) => ({
      videoId: path.basename(videoDir),
      metadata: { title: "测试视频" },
      structuredNotesMd: "# 笔记",
    })),
    readYoutubePageUrl: vi.fn(async () => "https://www.youtube.com/watch?v=<videoId>"),
    writeNativeArticleBundle: writeNativeArticleBundleMock,
    writePlatformArticleBundle: writePlatformArticleBundleMock,
  };
});

import { executeNativeArticle } from "./native-article.js";

beforeEach(() => {
  generateXArticleContentMock.mockClear();
  generateXThreadContentMock.mockClear();
  generatePlatformArticleContentMock.mockClear();
  writeNativeArticleBundleMock.mockClear();
  writePlatformArticleBundleMock.mockClear();
  vi.stubEnv("OPENAI_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("executeNativeArticle", () => {
  it("uses existing article.md for platform targets when --targets is omitted", async () => {
    const notesOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-notes-"));
    const articleOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-out-"));
    const videoId = "platformOnly1";
    await mkdir(path.join(notesOutDir, videoId), { recursive: true });
    await mkdir(path.join(articleOutDir, videoId), { recursive: true });
    await writeFile(path.join(articleOutDir, videoId, "article.md"), "# 已有长文\n\n正文");

    const code = await executeNativeArticle({
      outDir: notesOutDir,
      articleOutDir,
      videoId: [videoId],
      platformTargets: "xiaohongshu",
      llmProvider: "openai",
      llmModel: "test-model",
      showProgress: false,
    });

    expect(code).toBe(0);
    expect(generateXArticleContentMock).not.toHaveBeenCalled();
    expect(generatePlatformArticleContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "xiaohongshu",
        articleMd: "# 已有长文\n\n正文",
      }),
    );
    expect(writePlatformArticleBundleMock).toHaveBeenCalledWith(
      articleOutDir,
      videoId,
      expect.objectContaining({ target: "xiaohongshu" }),
      { force: false },
    );
  });

  it("skips article generation when article.md already exists and --force is not set", async () => {
    const notesOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-skip-notes-"));
    const articleOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-skip-out-"));
    const videoId = "skipArticle";
    await mkdir(path.join(notesOutDir, videoId), { recursive: true });
    await mkdir(path.join(articleOutDir, videoId), { recursive: true });
    await writeFile(path.join(articleOutDir, videoId, "article.md"), "# 已有长文\n\n正文");

    const code = await executeNativeArticle({
      outDir: notesOutDir,
      articleOutDir,
      videoId: [videoId],
      targets: "article",
      llmProvider: "openai",
      llmModel: "test-model",
      showProgress: false,
    });

    expect(code).toBe(1);
    expect(generateXArticleContentMock).not.toHaveBeenCalled();
  });

  it("generates article when --force is set even if article.md exists", async () => {
    const notesOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-force-notes-"));
    const articleOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-force-out-"));
    const videoId = "forceArticle";
    await mkdir(path.join(notesOutDir, videoId), { recursive: true });
    await mkdir(path.join(articleOutDir, videoId), { recursive: true });
    await writeFile(path.join(articleOutDir, videoId, "article.md"), "# 已有长文\n\n正文");

    writeNativeArticleBundleMock.mockResolvedValueOnce({
      articleDir: path.join(articleOutDir, videoId),
      articlePath: path.join(articleOutDir, videoId, "article.md"),
      runPath: path.join(articleOutDir, videoId, "run.json"),
      coverPath: null,
      videoPath: null,
      subtitlePath: null,
    });
    generateXArticleContentMock.mockResolvedValueOnce({
      videoId,
      model: "test-model",
      finishReason: "stop",
      durationMs: 1,
      content: "# 新文章\n\n正文",
      visualPlan: [],
    });

    const code = await executeNativeArticle({
      outDir: notesOutDir,
      articleOutDir,
      videoId: [videoId],
      targets: "article",
      force: true,
      llmProvider: "openai",
      llmModel: "test-model",
      showProgress: false,
    });

    expect(code).toBe(0);
    expect(generateXArticleContentMock).toHaveBeenCalled();
  });

  it("skips thread generation when x-thread.md already exists and --force is not set", async () => {
    const notesOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-thread-skip-notes-"));
    const articleOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-thread-skip-out-"));
    const videoId = "skipThread";
    await mkdir(path.join(notesOutDir, videoId), { recursive: true });
    await mkdir(path.join(articleOutDir, videoId, "x-format"), { recursive: true });
    await writeFile(path.join(articleOutDir, videoId, "x-format", "x-thread.md"), "已有thread");

    const code = await executeNativeArticle({
      outDir: notesOutDir,
      articleOutDir,
      videoId: [videoId],
      targets: "x-thread",
      llmProvider: "openai",
      llmModel: "test-model",
      showProgress: false,
    });

    expect(code).toBe(1);
    expect(generateXThreadContentMock).not.toHaveBeenCalled();
  });

  it("skips platform target when output md already exists and --force is not set", async () => {
    const notesOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-platskip-notes-"));
    const articleOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-platskip-out-"));
    const videoId = "skipPlatform";
    await mkdir(path.join(notesOutDir, videoId), { recursive: true });
    await mkdir(path.join(articleOutDir, videoId, "xiaohongshu-format"), { recursive: true });
    await writeFile(path.join(articleOutDir, videoId, "xiaohongshu-format", "xiaohongshu-article.md"), "已有");
    await writeFile(path.join(articleOutDir, videoId, "article.md"), "# 已有长文\n\n正文");

    const code = await executeNativeArticle({
      outDir: notesOutDir,
      articleOutDir,
      videoId: [videoId],
      platformTargets: "xiaohongshu",
      llmProvider: "openai",
      llmModel: "test-model",
      showProgress: false,
    });

    expect(code).toBe(1);
    expect(generatePlatformArticleContentMock).not.toHaveBeenCalled();
  });
});
