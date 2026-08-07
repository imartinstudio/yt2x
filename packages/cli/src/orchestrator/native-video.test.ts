import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeNativeAcquireMock = vi.hoisted(() =>
  vi.fn(async (opts: { outDir: string }) => {
    const videoId = "abc123def45";
    await mkdir(path.join(opts.outDir, videoId), { recursive: true });
    await writeFile(path.join(opts.outDir, videoId, "metadata.json"), JSON.stringify({ id: videoId }));
    return 0;
  }),
);
vi.mock("@yt2x/adapters-node", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, executeNativeAcquire: executeNativeAcquireMock };
});

const executeNativeDubMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./native-dub.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, executeNativeDub: executeNativeDubMock };
});

const ensureDubPreflightMock = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));
vi.mock("./dub-preflight.js", () => ({ ensureDubPreflight: ensureDubPreflightMock }));

const executeNativeSubtitleMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./native-subtitle.js", () => ({ executeNativeSubtitle: executeNativeSubtitleMock }));

// 无翻译时用不到真实 LLM 凭据；本文件里需要翻译的场景（bilingual-burned/zh-srt acquire wiring）
// 用这个 stub 避免依赖开发机/CI 上是否配置了真实 API key，与 native-pipeline.test.ts 对
// "./native-stage-common.js" 的 mock 手法一致。可用 mockReturnValueOnce 覆写单个测试里的失败路径。
const resolveNativeLlmMock = vi.hoisted(() =>
  vi.fn(() => ({
    ok: true as const,
    adapter: { chat: async () => ({ content: "", model: "test", finishReason: "stop" as const }) },
    provider: "openai" as const,
    model: "test",
  })),
);
vi.mock("./native-stage-common.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, resolveNativeLlm: resolveNativeLlmMock };
});

import { executeNativeVideo } from "./native-video.js";

beforeEach(() => {
  executeNativeAcquireMock.mockClear();
  executeNativeDubMock.mockClear();
  ensureDubPreflightMock.mockClear();
  ensureDubPreflightMock.mockResolvedValue({ ok: true });
  resolveNativeLlmMock.mockClear();
  executeNativeSubtitleMock.mockClear();
  executeNativeSubtitleMock.mockResolvedValue(0);
});

describe("executeNativeVideo — --deliver validation", () => {
  it("rejects a missing --deliver before doing any work", async () => {
    const code = await executeNativeVideo({ urls: ["https://www.youtube.com/watch?v=abc123def45"] });
    expect(code).not.toBe(0);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid --deliver value", async () => {
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "not-a-real-tier",
    });
    expect(code).not.toBe(0);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });

  it("rejects --deliver dubbed --from youtube with a descriptive error, before acquiring anything", async () => {
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "dubbed",
      from: "youtube",
    });
    expect(code).not.toBe(0);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });

  it("rejects when neither --urls/--url-file/--search nor --video-id is given", async () => {
    const code = await executeNativeVideo({ deliver: "none" });
    expect(code).not.toBe(0);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });

  it("rejects when both --urls and --video-id are given, before doing any work", async () => {
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      videoId: ["existingVid1"],
      deliver: "none",
    });
    expect(code).not.toBe(0);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });
});

describe("executeNativeVideo — acquire wiring", () => {
  it("maps --deliver bilingual-burned to subtitleZh off / subtitleBilingual burned in the acquire call", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-bilingual-"));
    const articleOutRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-bilingual-articles-"));
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "bilingual-burned",
      outDir: outRoot,
      articleOutDir: articleOutRoot,
      llmProvider: "openai",
    });
    expect(code).toBe(0);
    expect(executeNativeAcquireMock).toHaveBeenCalledOnce();
    const acquireOpts = executeNativeAcquireMock.mock.calls[0]![0] as {
      acquire: { subtitleZh?: string; subtitleBilingual?: string };
      llm?: unknown;
      llmModel?: string;
    };
    expect(acquireOpts.acquire.subtitleZh).toBe("off");
    expect(acquireOpts.acquire.subtitleBilingual).toBe("burned");
    expect(acquireOpts.llm).toBeDefined();
    expect(acquireOpts.llmModel).toBe("test");
    expect(ensureDubPreflightMock).not.toHaveBeenCalled();
    expect(executeNativeDubMock).not.toHaveBeenCalled();
  });

  it("returns the LLM resolution failure's exit code and never calls executeNativeAcquire when a --deliver tier needing translation has no usable LLM config", async () => {
    resolveNativeLlmMock.mockReturnValueOnce({
      ok: false,
      exitCode: 5,
      reason: "no LLM API key configured",
    });
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-llm-fail-"));
    const articleOutRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-llm-fail-articles-"));
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "bilingual-burned",
      outDir: outRoot,
      articleOutDir: articleOutRoot,
      llmProvider: "openai",
    });
    expect(code).toBe(5);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });

  it("skips acquire entirely when --video-id is given without --urls", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-skip-acquire-"));
    await mkdir(path.join(outRoot, "existingVid1"), { recursive: true });
    await writeFile(path.join(outRoot, "existingVid1", "metadata.json"), JSON.stringify({ id: "existingVid1" }));

    const articleOutRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-skip-acquire-articles-"));
    const code = await executeNativeVideo({
      videoId: ["existingVid1"],
      deliver: "zh-srt",
      outDir: outRoot,
      articleOutDir: articleOutRoot,
      llmProvider: "openai",
    });
    expect(code).toBe(0);
    expect(executeNativeAcquireMock).not.toHaveBeenCalled();
  });
});

describe("executeNativeVideo — dub wiring", () => {
  it("runs the dub preflight and per-video dub for --deliver dubbed, resolving --from to local-words", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-dubbed-"));
    const articleOutRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-dubbed-articles-"));
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "dubbed",
      outDir: outRoot,
      articleOutDir: articleOutRoot,
      llmProvider: "openai",
    });
    expect(code).toBe(0);
    expect(executeNativeAcquireMock).toHaveBeenCalledOnce();
    const acquireOpts = executeNativeAcquireMock.mock.calls[0]![0] as {
      acquire: { subtitleZh?: string; subtitleBilingual?: string };
    };
    expect(acquireOpts.acquire.subtitleZh).toBe("off");
    expect(acquireOpts.acquire.subtitleBilingual).toBe("off");
    expect(ensureDubPreflightMock).toHaveBeenCalledOnce();
    expect(ensureDubPreflightMock.mock.calls[0]![0]).toMatchObject({ commandLabel: "yt2x video" });
    expect(executeNativeDubMock).toHaveBeenCalledOnce();
    expect(executeNativeDubMock.mock.calls[0]![0]).toMatchObject({ videoId: "abc123def45" });
  });

  it("returns the preflight's exit code and never calls executeNativeDub when preflight fails", async () => {
    ensureDubPreflightMock.mockResolvedValueOnce({ ok: false, exitCode: 4 });
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-dubbed-preflight-fail-"));
    const articleOutRoot = await mkdtemp(
      path.join(os.tmpdir(), "native-video-dubbed-preflight-fail-articles-"),
    );
    const code = await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "dubbed",
      outDir: outRoot,
      articleOutDir: articleOutRoot,
      llmProvider: "openai",
    });
    expect(code).toBe(4);
    expect(executeNativeDubMock).not.toHaveBeenCalled();
  });

  it("continues past a failed dub under --error-strategy skip, but still returns a non-zero exit code overall", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-dub-skip-"));
    const articleOutRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-dub-skip-articles-"));
    await mkdir(path.join(outRoot, "vidA"), { recursive: true });
    await writeFile(path.join(outRoot, "vidA", "metadata.json"), JSON.stringify({ id: "vidA" }));
    await mkdir(path.join(outRoot, "vidB"), { recursive: true });
    await writeFile(path.join(outRoot, "vidB", "metadata.json"), JSON.stringify({ id: "vidB" }));

    // vidA's dub fails; vidB's dub succeeds. --error-strategy skip must still process vidB
    // and the final exit code must reflect vidA's failure — not silently report success.
    executeNativeDubMock.mockImplementationOnce(async () => 7);
    executeNativeDubMock.mockImplementationOnce(async () => 0);

    const code = await executeNativeVideo({
      videoId: ["vidA", "vidB"],
      deliver: "dubbed",
      outDir: outRoot,
      articleOutDir: articleOutRoot,
      errorStrategy: "skip",
      llmProvider: "openai",
    });

    expect(executeNativeDubMock).toHaveBeenCalledTimes(2);
    expect(executeNativeDubMock.mock.calls[0]![0]).toMatchObject({ videoId: "vidA" });
    expect(executeNativeDubMock.mock.calls[1]![0]).toMatchObject({ videoId: "vidB" });
    expect(code).not.toBe(0);
    expect(code).toBe(7);
  });
});

describe("executeNativeVideo — --video-id-only subtitle generation for non-dubbed tiers", () => {
  it("calls executeNativeSubtitle once per video for a non-dubbed --deliver tier on the --video-id-only path", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-"));
    await mkdir(path.join(outRoot, "existingVid1"), { recursive: true });
    await writeFile(path.join(outRoot, "existingVid1", "metadata.json"), JSON.stringify({ id: "existingVid1" }));

    const code = await executeNativeVideo({
      videoId: ["existingVid1"],
      deliver: "zh-burned",
      outDir: outRoot,
      llmProvider: "openai",
    });

    expect(code).toBe(0);
    expect(executeNativeSubtitleMock).toHaveBeenCalledOnce();
    expect(executeNativeSubtitleMock.mock.calls[0]![0]).toMatchObject({
      videoId: "existingVid1",
      outDir: outRoot,
      subtitleZh: "burned",
      subtitleBilingual: "off",
    });
    expect(executeNativeDubMock).not.toHaveBeenCalled();
  });

  it("maps bilingual-burned correctly on the --video-id-only path", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-bilingual-"));
    await mkdir(path.join(outRoot, "existingVid1"), { recursive: true });
    await writeFile(path.join(outRoot, "existingVid1", "metadata.json"), JSON.stringify({ id: "existingVid1" }));

    await executeNativeVideo({
      videoId: ["existingVid1"],
      deliver: "bilingual-burned",
      outDir: outRoot,
      llmProvider: "openai",
    });

    expect(executeNativeSubtitleMock.mock.calls[0]![0]).toMatchObject({
      subtitleZh: "off",
      subtitleBilingual: "burned",
    });
  });

  it("does not call executeNativeSubtitle for --deliver none (true no-op)", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-none-"));
    await mkdir(path.join(outRoot, "existingVid1"), { recursive: true });
    await writeFile(path.join(outRoot, "existingVid1", "metadata.json"), JSON.stringify({ id: "existingVid1" }));

    const code = await executeNativeVideo({
      videoId: ["existingVid1"],
      deliver: "none",
      outDir: outRoot,
    });

    expect(code).toBe(0);
    expect(executeNativeSubtitleMock).not.toHaveBeenCalled();
  });

  it("does not call executeNativeSubtitle for --deliver dubbed (dub burns its own subtitles)", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-dubbed-"));
    await mkdir(path.join(outRoot, "existingVid1", "video"), { recursive: true });
    await writeFile(path.join(outRoot, "existingVid1", "metadata.json"), JSON.stringify({ id: "existingVid1" }));

    await executeNativeVideo({
      videoId: ["existingVid1"],
      deliver: "dubbed",
      outDir: outRoot,
      llmProvider: "openai",
    });

    expect(executeNativeSubtitleMock).not.toHaveBeenCalled();
    expect(executeNativeDubMock).toHaveBeenCalledOnce();
  });

  it("does not call executeNativeSubtitle on the fresh-acquire (--urls) path — prepareYoutubeVideo already handles it", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-freshacquire-"));
    await executeNativeVideo({
      urls: ["https://www.youtube.com/watch?v=abc123def45"],
      deliver: "zh-burned",
      outDir: outRoot,
      llmProvider: "openai",
    });
    expect(executeNativeSubtitleMock).not.toHaveBeenCalled();
    expect(executeNativeAcquireMock).toHaveBeenCalledOnce();
  });

  it("continues past a failed subtitle call under --error-strategy skip and returns a non-zero code", async () => {
    executeNativeSubtitleMock.mockResolvedValueOnce(9).mockResolvedValueOnce(0);
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-skip-"));
    for (const id of ["vidA", "vidB"]) {
      await mkdir(path.join(outRoot, id), { recursive: true });
      await writeFile(path.join(outRoot, id, "metadata.json"), JSON.stringify({ id }));
    }

    const code = await executeNativeVideo({
      videoId: ["vidA", "vidB"],
      deliver: "zh-srt",
      outDir: outRoot,
      llmProvider: "openai",
      errorStrategy: "skip",
    });

    expect(executeNativeSubtitleMock).toHaveBeenCalledTimes(2);
    expect(code).toBe(9);
  });

  it("stops at the first failure under the default --error-strategy stop", async () => {
    executeNativeSubtitleMock.mockResolvedValueOnce(9);
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-subonly-stop-"));
    for (const id of ["vidA", "vidB"]) {
      await mkdir(path.join(outRoot, id), { recursive: true });
      await writeFile(path.join(outRoot, id, "metadata.json"), JSON.stringify({ id }));
    }

    const code = await executeNativeVideo({
      videoId: ["vidA", "vidB"],
      deliver: "zh-srt",
      outDir: outRoot,
      llmProvider: "openai",
    });

    expect(code).toBe(9);
    expect(executeNativeSubtitleMock).toHaveBeenCalledOnce();
  });
});

describe("executeNativeVideo — video-id scoping after acquire", () => {
  it("does not sweep in unrelated pre-existing videos under --out-dir when acquiring via --search", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-scoping-"));
    const articleOutRoot = await mkdtemp(path.join(os.tmpdir(), "native-video-scoping-articles-"));

    // Simulates a video left over under --out-dir from a completely unrelated earlier run —
    // its metadata.json exists *before* executeNativeVideo is ever called, and it is not one
    // of the videos this run's --search is meant to acquire.
    await mkdir(path.join(outRoot, "preExisting99"), { recursive: true });
    await writeFile(
      path.join(outRoot, "preExisting99", "metadata.json"),
      JSON.stringify({ id: "preExisting99" }),
    );

    // --search (not --urls) means sourceVideoIdsFromUrls() has nothing to fall back on, so the
    // only thing that can correctly scope videoIds down to just the newly-acquired video is the
    // initialVideoIds/newlyDiscoveredVideoIds snapshot taken before acquire runs.
    const code = await executeNativeVideo({
      search: "some query",
      deliver: "dubbed",
      outDir: outRoot,
      articleOutDir: articleOutRoot,
      llmProvider: "openai",
    });

    expect(code).toBe(0);
    expect(ensureDubPreflightMock).toHaveBeenCalledOnce();
    const preflightOpts = ensureDubPreflightMock.mock.calls[0]![0] as { videoIds: readonly string[] };
    expect(preflightOpts.videoIds).toEqual(["abc123def45"]);
    expect(preflightOpts.videoIds).not.toContain("preExisting99");
    expect(executeNativeDubMock).toHaveBeenCalledOnce();
    expect(executeNativeDubMock.mock.calls[0]![0]).toMatchObject({ videoId: "abc123def45" });
  });
});
