import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as AdaptersNode from "@yt2x/adapters-node";
import type { ChatRequest, LlmPort } from "@yt2x/core";
import { afterEach, expect, it, vi } from "vitest";

const chat = vi.hoisted(() => vi.fn(async (request: ChatRequest) => {
  const system = request.messages[0]?.content ?? "";
  if (system.includes("术语发现器")) {
    return { content: "[]", model: "resolved-model", finishReason: "stop" };
  }
  if (system.includes("6–8")) {
    return {
      content: JSON.stringify({
        title: "Graph Engineering 摘要",
        planning: {
          core_thesis: "Graph Engineering",
          conflict: "范围过大",
          key_points: ["一", "二", "三", "四"],
          reader_gain: "可执行方法",
          final_post: "从小范围开始",
        },
        tweets: ["Graph Engineering", "误区", "方法", "验证", "工具", "收益"],
        hooks: [
          { text: "反直觉", angle: "反直觉", risk: "low" },
          { text: "实用", angle: "实用收益", risk: "low" },
          { text: "技术", angle: "技术洞察", risk: "medium" },
        ],
      }),
      model: "resolved-model",
      finishReason: "stop",
    };
  }
  if (system.includes("短视频说明文字")) {
    return {
      content: JSON.stringify({ text: "Graph Engineering 视频摘要。" }),
      model: "resolved-model",
      finishReason: "stop",
    };
  }
  return {
    content: JSON.stringify({ text: "Graph Engineering 短帖摘要。", angle: "practical", risk: "low" }),
    model: "resolved-model",
    finishReason: "stop",
  };
}));

vi.mock("@yt2x/adapters-node", async (importOriginal) => {
  const actual = await importOriginal<typeof AdaptersNode>();
  return {
    ...actual,
    createLlmAdapter: vi.fn((): LlmPort => ({ chat })),
  };
});

import { executeNativeArticle } from "./native-article.js";

const roots: string[] = [];

afterEach(async () => {
  chat.mockClear();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("reconstructs thread and short two-layer profiles so a second production run calls no provider", async () => {
  const notesOutDir = await mkdtemp(path.join(tmpdir(), "yt2x-native-two-layer-notes-"));
  const articleOutDir = await mkdtemp(path.join(tmpdir(), "yt2x-native-two-layer-articles-"));
  roots.push(notesOutDir, articleOutDir);
  const videoId = "twoLayerCache";
  const videoDir = path.join(notesOutDir, videoId);
  await mkdir(videoDir, { recursive: true });
  await writeFile(path.join(videoDir, "metadata.json"), JSON.stringify({
    id: videoId,
    title: "Graph Engineering",
    webpage_url: "https://www.youtube.com/watch?v=<videoId>",
  }), "utf8");
  await writeFile(path.join(videoDir, "structured-notes.md"), [
    "# Graph Engineering",
    "## Executive Summary",
    "Graph Engineering is the main idea.",
    "## Detailed Notes",
    "Context Engineering is intentionally omitted from the summaries.",
  ].join("\n"), "utf8");
  vi.stubEnv("OPENAI_API_KEY", "test-key");

  const flags = {
    outDir: notesOutDir,
    articleOutDir,
    videoId: [videoId],
    targets: "x-thread,x-short,x-video-short",
    llmProvider: "openai",
    llmModel: "requested-model",
    showProgress: false,
  } as const;
  await expect(executeNativeArticle(flags)).resolves.toBe(0);
  const firstRunProviderCalls = chat.mock.calls.length;
  expect(firstRunProviderCalls).toBeGreaterThan(0);

  await expect(executeNativeArticle(flags)).resolves.toBe(0);

  expect(chat).toHaveBeenCalledTimes(firstRunProviderCalls);
  const metadata = JSON.parse(await readFile(
    path.join(articleOutDir, videoId, ".content-metadata", "x-short.json"),
    "utf8",
  )) as Record<string, unknown>;
  expect(metadata).toMatchObject({
    v: 3,
    technicalTermScope: "scoped",
    technicalTermKnownSourceFingerprint: expect.stringMatching(/^sha256-/u),
    technicalTermRequiredSourceFingerprint: expect.stringMatching(/^sha256-/u),
  });
  expect(metadata.technicalTermKnownSourceFingerprint).not.toBe(
    metadata.technicalTermRequiredSourceFingerprint,
  );
});
