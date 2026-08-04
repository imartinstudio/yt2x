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

// 无翻译时用不到真实 LLM 凭据；本文件里唯一需要翻译的场景
// （bilingual-burned acquire wiring）用这个 stub 避免依赖开发机/CI 上是否配置了真实 API key，
// 与 native-pipeline.test.ts 对 "./native-stage-common.js" 的 mock 手法一致。
vi.mock("./native-stage-common.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    resolveNativeLlm: () => ({
      ok: true,
      adapter: { chat: async () => ({ content: "", model: "test", finishReason: "stop" }) },
      provider: "openai",
      model: "test",
    }),
  };
});

import { executeNativeVideo } from "./native-video.js";

beforeEach(() => {
  executeNativeAcquireMock.mockClear();
  executeNativeDubMock.mockClear();
  ensureDubPreflightMock.mockClear();
  ensureDubPreflightMock.mockResolvedValue({ ok: true });
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
    };
    expect(acquireOpts.acquire.subtitleZh).toBe("off");
    expect(acquireOpts.acquire.subtitleBilingual).toBe("burned");
    expect(ensureDubPreflightMock).not.toHaveBeenCalled();
    expect(executeNativeDubMock).not.toHaveBeenCalled();
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
});
