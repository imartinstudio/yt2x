import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as AdaptersNode from "@yt2x/adapters-node";
import type { ChatRequest, DeconstructManifest, LlmPort, SectionCandidate } from "@yt2x/core";
import { afterEach, expect, it, vi } from "vitest";

/**
 * 生产形态的端到端缓存身份测试：只 fake LLM port 和视频裁剪（避免真实 ffmpeg），
 * 其余（metadata freshness、锁、原子提交、selector）全部走真实实现。
 *
 * 目的：为 Task 2（deconstruct-run 独立缓存身份）提供端到端证据 ——
 * 现有 deconstruct.test.ts 把整个 @yt2x/adapters-node mock 掉了，
 * 缓存身份分离没有任何端到端证据。
 */

const chat = vi.hoisted(() => vi.fn(async (request: ChatRequest) => {
  const system = request.messages[0]?.content ?? "";
  if (system.includes("术语发现器")) {
    return { content: "[]", model: "resolved-model", finishReason: "stop" };
  }
  if (system.includes("AI 内容运营专家")) {
    return {
      content: JSON.stringify({
        sections: [
          {
            id: "section-1",
            title: "内容拆解方法论 核心",
            summary: "内容拆解方法论 的核心洞察",
            article_section: "核心洞察",
            angle: "tutorial",
            risk: "low",
            timecodes: { start: "00:00:00,000", end: "00:00:10,000", startSec: 0, endSec: 10, durationSec: 10 },
            scores: { counter_intuitiveness: 4, shareability: 4, practical_value: 5, visual_appeal: 4, composite: 4.3 },
            key_quote: "这是本期视频最重要的收获。",
            video_script: "屏幕演示 内容拆解方法论 路由流程。",
            skip_reason: null,
          },
          {
            id: "section-2",
            title: "次要背景",
            summary: "简要提及背景",
            article_section: "次要说明",
            angle: "discussion",
            risk: "low",
            timecodes: { start: "00:00:10,000", end: "00:00:20,000", startSec: 10, endSec: 20, durationSec: 10 },
            scores: { counter_intuitiveness: 2, shareability: 2, practical_value: 2, visual_appeal: 2, composite: 2.0 },
            key_quote: "这部分不是今天的重点。",
            video_script: "简单画面。",
            skip_reason: null,
          },
        ],
      }),
      model: "resolved-model",
      finishReason: "stop",
    };
  }
  if (system.includes("AI Agents 领域的内容创作者")) {
    return {
      content: JSON.stringify({
        posts: [
          {
            title: "内容拆解方法论 实战",
            opening_quote: "内容拆解方法论 正在重塑路由决策。",
            core_description: "这是关于 内容拆解方法论 的核心解释。",
            video_suggestion: "看看这段 内容拆解方法论 演示。",
          },
          {
            title: "背景补充",
            opening_quote: "除了 内容拆解方法论 之外还有其他背景。",
            core_description: "简要说明背景信息。",
            video_suggestion: "这段画面简单带过。",
          },
        ],
      }),
      model: "resolved-model",
      finishReason: "stop",
    };
  }
  throw new Error(`Unexpected chat call, system prompt head: ${system.slice(0, 120)}`);
}));

vi.mock("@yt2x/adapters-node", async (importOriginal) => {
  const actual = await importOriginal<typeof AdaptersNode>();
  return {
    ...actual,
    createLlmAdapter: vi.fn((): LlmPort => ({ chat })),
    // 唯一的额外 mock：避开真实 ffmpeg 裁剪。其余（freshness/锁/原子提交/selector）保持真实实现。
    clipCandidates: vi.fn(async (
      _videoPath: string,
      candidates: SectionCandidate[],
      outputDir: string,
    ) => {
      await mkdir(outputDir, { recursive: true });
      return Promise.all(candidates.map(async (candidate) => {
        const filename = actual.candidateVideoFilename(candidate);
        const outPath = path.join(outputDir, filename);
        await writeFile(outPath, "fake-clip-bytes", "utf8");
        return { path: outPath, candidate, success: true };
      }));
    }),
  };
});

import { runDeconstructCommand } from "./deconstruct.js";

const roots: string[] = [];

afterEach(async () => {
  chat.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ARTICLE_MD = [
  "# 内容拆解方法论 深度拆解",
  "",
  "## 核心洞察",
  "内容拆解方法论 正在重塑智能体路由决策的方式，这是本期视频的核心内容。",
  "",
  "## 次要说明",
  "除了 内容拆解方法论 之外，这里简要提及其他相关背景，但不是重点。",
  "",
].join("\n");

const SRT_CONTENT = [
  "1",
  "00:00:00,000 --> 00:00:05,000",
  "内容拆解方法论 正在重塑路由决策。",
  "",
  "2",
  "00:00:05,000 --> 00:00:10,000",
  "这是本期视频最重要的收获。",
  "",
  "3",
  "00:00:10,000 --> 00:00:15,000",
  "除了 内容拆解方法论 之外还有其他背景。",
  "",
  "4",
  "00:00:15,000 --> 00:00:20,000",
  "这部分不是今天的重点。",
  "",
].join("\n");

const setupArticleDir = async (): Promise<string> => {
  const articleDir = await mkdtemp(path.join(tmpdir(), "yt2x-deconstruct-cache-e2e-"));
  roots.push(articleDir);
  await writeFile(path.join(articleDir, "article.md"), ARTICLE_MD, "utf8");
  const videoDir = path.join(articleDir, "video");
  await mkdir(videoDir, { recursive: true });
  await writeFile(path.join(videoDir, "full.srt"), SRT_CONTENT, "utf8");
  await writeFile(path.join(videoDir, "full.mp4"), "not-a-real-video-placeholder", "utf8");
  return articleDir;
};

it("keeps deconstruct-run and clip-post cache identities independent across real production runs", async () => {
  const { selectedClipPostCacheIdentityFor } =
    await vi.importActual<typeof AdaptersNode>("@yt2x/adapters-node");
  const articleDir = await setupArticleDir();

  // --- Run 1: cold cache, must call the LLM provider ---
  await expect(runDeconstructCommand(articleDir, 1)).resolves.toBe(0);
  const firstRunProviderCalls = chat.mock.calls.length;
  expect(firstRunProviderCalls).toBeGreaterThan(0);

  const finalClipsDir = path.join(articleDir, "x-format", "clips");
  const bundleDir = finalClipsDir;

  const deconstructRunMetadataPath = path.join(bundleDir, ".content-metadata", "deconstruct-run.json");
  const clipPostMetadataPath = path.join(bundleDir, ".content-metadata", "clip-post.json");
  const deconstructRunMetadata = JSON.parse(await readFile(deconstructRunMetadataPath, "utf8")) as Record<string, unknown>;
  const clipPostMetadata = JSON.parse(await readFile(clipPostMetadataPath, "utf8")) as Record<string, unknown>;
  expect(deconstructRunMetadata).toMatchObject({ target: "deconstruct-run" });
  expect(clipPostMetadata).toMatchObject({ target: "clip-post" });

  // --- Run 2: identical inputs, must be a complete bundle cache hit (zero new provider calls) ---
  await expect(runDeconstructCommand(articleDir, 1)).resolves.toBe(0);
  expect(chat).toHaveBeenCalledTimes(firstRunProviderCalls);

  // --- Independence check (finding #1): mutating the UNSELECTED candidate's manifest fields
  // must not invalidate the clip-post cache, because clip-post identity is derived only from
  // selected clips + selected post source scope.
  const manifestPath = path.join(bundleDir, "clips-manifest.json");
  const manifestBefore = JSON.parse(await readFile(manifestPath, "utf8")) as DeconstructManifest;
  const articleTitle = ARTICLE_MD.match(/^#\s+(.+)$/m)?.[1] ?? "";
  const identityBeforeMutation = selectedClipPostCacheIdentityFor(articleTitle, manifestBefore);

  const unselectedClip = manifestBefore.clips.find((clip) => clip.selected !== true);
  expect(unselectedClip).toBeDefined();
  const mutatedManifest: DeconstructManifest = JSON.parse(JSON.stringify(manifestBefore));
  const mutatedClip = mutatedManifest.clips.find((clip) => clip.id === unselectedClip!.id)!;
  mutatedClip.text = "完全改写的未选中候选文案，源文本已被替换。";
  mutatedClip.sourceContext = {
    title: "完全改写的标题",
    summary: "完全改写的摘要内容。",
    keyQuote: "完全改写的金句。",
    videoScript: "完全改写的画面描述。",
    articleSection: mutatedClip.articleSection ?? "",
    articleBody: "完全改写的正文引用。",
  };

  const identityAfterMutation = selectedClipPostCacheIdentityFor(articleTitle, mutatedManifest);
  expect(identityAfterMutation.sourceFingerprint).toBe(identityBeforeMutation.sourceFingerprint);

  // Write the mutation to disk and re-run: the third run must still be a complete cache hit
  // (zero additional provider calls) AND must not clobber our manifest mutation, proving the
  // cache-hit branch really was taken rather than a coincidentally-successful regeneration.
  await writeFile(manifestPath, JSON.stringify(mutatedManifest, null, 2) + "\n", "utf8");
  await expect(runDeconstructCommand(articleDir, 1)).resolves.toBe(0);
  expect(chat).toHaveBeenCalledTimes(firstRunProviderCalls);

  const manifestAfterThirdRun = JSON.parse(await readFile(manifestPath, "utf8")) as DeconstructManifest;
  const unchangedClip = manifestAfterThirdRun.clips.find((clip) => clip.id === unselectedClip!.id)!;
  expect(unchangedClip.text).toBe("完全改写的未选中候选文案，源文本已被替换。");
});
