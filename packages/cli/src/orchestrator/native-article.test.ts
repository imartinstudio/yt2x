import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as AdaptersNode from "@yt2x/adapters-node";
import {
  CONTENT_PROMPT_VERSIONS,
  contentSourceFingerprintFor,
  contentTechnicalTermSourceFingerprintFor,
  createContentTargetMetadata,
  knownSourceTextWithMetadata,
  structuredNotesContentSourceFor,
  summarySourceTextFor,
} from "@yt2x/adapters-node";
import {
  createTechnicalTermGuard,
} from "@yt2x/core";
import { technicalTermDiscoveryAuditFor } from "@yt2x/adapters-node";
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
  it("reuses an existing article only when source, model, prompt and term profile metadata match", async () => {
    const notesOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-cache-notes-"));
    const articleOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-cache-out-"));
    const videoId = "cacheArticle";
    const sourceText = "# 笔记";
    const metadata = { title: "测试视频" };
    const audit = technicalTermDiscoveryAuditFor(
      { accepted: [], reviewCandidates: [], warnings: [] },
      { sourceText, sourceTitle: metadata.title },
    );
    // 已知范围含 prompt 可见的 metadata，必需范围只有摘要——缓存判定必须用同一个 scoped profile
    const knownSourceText = knownSourceTextWithMetadata(metadata, sourceText);
    const guard = createTechnicalTermGuard({
      sourceText: knownSourceText,
      sourceTitle: metadata.title,
      discovery: audit,
    }).scope(summarySourceTextFor(sourceText), metadata.title);
    const sourceFingerprint = contentSourceFingerprintFor(structuredNotesContentSourceFor({
      metadata,
      structuredNotesMd: sourceText,
      availableVisuals: null,
    }));
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(path.join(notesOutDir, videoId), { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(path.join(articleDir, "article.md"), "旧文章", "utf8");
    const run = createContentTargetMetadata({
      target: "article",
      sourceFingerprint,
      model: "test-model",
      promptVersion: CONTENT_PROMPT_VERSIONS.article,
      technicalTermProfileFingerprint: guard.profile.profileFingerprint,
      technicalTermDiscovery: audit,
      technicalTermKnownSourceFingerprint:
        contentTechnicalTermSourceFingerprintFor(knownSourceText, metadata.title),
      technicalTermRequiredSourceFingerprint:
        contentTechnicalTermSourceFingerprintFor(summarySourceTextFor(sourceText), metadata.title),
      technicalTermScope: "scoped",
    });
    await writeFile(path.join(articleDir, "run.json"), JSON.stringify({
      ...run,
      platform: "x",
      videoId,
      finishReason: "stop",
      durationMs: 1,
    }, null, 2), "utf8");

    const code = await executeNativeArticle({
      outDir: notesOutDir,
      articleOutDir,
      videoId: [videoId],
      targets: "article",
      llmProvider: "openai",
      llmModel: "test-model",
      showProgress: false,
    });

    expect(code).toBe(0);
    expect(generateXArticleContentMock).not.toHaveBeenCalled();
  });

  it("rebuilds an existing article when its profile metadata is stale", async () => {
    const notesOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-stale-notes-"));
    const articleOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-stale-out-"));
    const videoId = "staleArticle";
    await mkdir(path.join(notesOutDir, videoId), { recursive: true });
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(articleDir, { recursive: true });
    await writeFile(path.join(articleDir, "article.md"), "旧文章", "utf8");
    await writeFile(path.join(articleDir, "run.json"), JSON.stringify({
      v: 1,
      platform: "x",
      target: "article",
      videoId,
      model: "old-model",
      promptVersion: CONTENT_PROMPT_VERSIONS.article,
      sourceFingerprint: "sha256-stale",
      technicalTermProfileFingerprint: "sha256-stale",
    }), "utf8");
    generateXArticleContentMock.mockResolvedValueOnce({
      videoId,
      model: "test-model",
      finishReason: "stop",
      durationMs: 1,
      content: "# 新文章\n\n正文",
      visualPlan: [],
      technicalTermProfileFingerprint: "sha256-new",
      technicalTermDiscovery: { promptVersion: "technical-term-discovery-v1", acceptedCandidates: [], reviewCandidates: [], warnings: [] },
      sourceFingerprint: "sha256-new-source",
      promptVersion: CONTENT_PROMPT_VERSIONS.article,
    });
    writeNativeArticleBundleMock.mockResolvedValueOnce(null);

    const code = await executeNativeArticle({
      outDir: notesOutDir,
      articleOutDir,
      videoId: [videoId],
      targets: "article",
      llmProvider: "openai",
      llmModel: "test-model",
      showProgress: false,
    });

    expect(code).toBe(0);
    expect(generateXArticleContentMock).toHaveBeenCalledOnce();
  });

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
      expect.objectContaining({ force: false }),
    );
  });

  it("rebuilds an existing article when target metadata is missing", async () => {
    const notesOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-skip-notes-"));
    const articleOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-article-skip-out-"));
    const videoId = "skipArticle";
    await mkdir(path.join(notesOutDir, videoId), { recursive: true });
    await mkdir(path.join(articleOutDir, videoId), { recursive: true });
    await writeFile(path.join(articleOutDir, videoId, "article.md"), "# 已有长文\n\n正文");
    generateXArticleContentMock.mockResolvedValueOnce({
      videoId,
      model: "test-model",
      finishReason: "stop",
      durationMs: 1,
      content: "# 新文章\n\n正文",
      visualPlan: [],
      technicalTermProfileFingerprint: "sha256-new-profile",
      technicalTermDiscovery: {
        promptVersion: "technical-term-discovery-v1",
        acceptedCandidates: [],
        reviewCandidates: [],
        warnings: [],
      },
      sourceFingerprint: "sha256-new-source",
      promptVersion: CONTENT_PROMPT_VERSIONS.article,
    });

    const code = await executeNativeArticle({
      outDir: notesOutDir,
      articleOutDir,
      videoId: [videoId],
      targets: "article",
      llmProvider: "openai",
      llmModel: "test-model",
      showProgress: false,
    });

    expect(code).toBe(0);
    expect(generateXArticleContentMock).toHaveBeenCalledOnce();
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
      technicalTermProfileFingerprint: "fnv1a-task3",
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
    expect(writeNativeArticleBundleMock).toHaveBeenCalledWith(
      articleOutDir,
      videoId,
      "# 新文章\n\n正文",
      expect.objectContaining({ technicalTermProfileFingerprint: "fnv1a-task3" }),
      expect.any(Object),
    );
  });

  it("rebuilds an existing thread when target metadata is missing", async () => {
    const notesOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-thread-skip-notes-"));
    const articleOutDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-thread-skip-out-"));
    const videoId = "skipThread";
    await mkdir(path.join(notesOutDir, videoId), { recursive: true });
    await mkdir(path.join(articleOutDir, videoId, "x-format"), { recursive: true });
    await writeFile(path.join(articleOutDir, videoId, "x-format", "x-thread.md"), "已有thread");
    generateXThreadContentMock.mockResolvedValueOnce({
      videoId,
      model: "test-model",
      finishReason: "stop",
      durationMs: 1,
      thread: {
        title: "标题",
        planning: {
          core_thesis: "核心",
          conflict: "冲突",
          key_points: ["要点"],
          reader_gain: "收益",
          final_post: "结论",
        },
        tweets: ["正文"],
        hooks: [],
      },
      technicalTermProfileFingerprint: "sha256-thread-profile",
      technicalTermDiscovery: {
        promptVersion: "technical-term-discovery-v1",
        acceptedCandidates: [],
        reviewCandidates: [],
        warnings: [],
      },
      sourceFingerprint: "sha256-thread-source",
      promptVersion: CONTENT_PROMPT_VERSIONS.xThread,
    });

    const code = await executeNativeArticle({
      outDir: notesOutDir,
      articleOutDir,
      videoId: [videoId],
      targets: "x-thread",
      llmProvider: "openai",
      llmModel: "test-model",
      showProgress: false,
    });

    expect(code).toBe(0);
    expect(generateXThreadContentMock).toHaveBeenCalledOnce();
  });

  it("rebuilds a platform target when target metadata is missing", async () => {
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

    expect(code).toBe(0);
    expect(generatePlatformArticleContentMock).toHaveBeenCalledOnce();
  });
});
