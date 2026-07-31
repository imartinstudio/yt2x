import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineArgsSchema } from "../args/pipeline.js";

const executeNativeNotesMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("./native-notes.js", () => ({
  executeNativeNotes: executeNativeNotesMock,
}));

const executeNativeArticleMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("./native-article.js", () => ({
  executeNativeArticle: executeNativeArticleMock,
}));

const executeNativePublishMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("./native-publish.js", () => ({
  executeNativePublish: executeNativePublishMock,
}));

vi.mock("./native-stage-common.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    resolveNativeLlm: () => ({
      ok: true,
      adapter: { chat: async () => ({ content: "", model: "test", finishReason: "stop" }) },
      model: "test",
    }),
  };
});

const executeNativeDubMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./native-dub.js", () => ({
  executeNativeDub: executeNativeDubMock,
}));

const executeNativeAcquireMock = vi.hoisted(() => vi.fn(async (opts: { outDir: string }) => {
  const videoId = "abc123def45";
  await mkdir(path.join(opts.outDir, videoId), { recursive: true });
  await writeFile(path.join(opts.outDir, videoId, "metadata.json"), JSON.stringify({ id: videoId }));
  return 0;
}));
const burnZhSubtitlesForVideoMock = vi.hoisted(() => vi.fn(async () => ({ burned: true, skipped: false })));
const transcribeLocalMock = vi.hoisted(() =>
  vi.fn(async () => ({ srtPath: "video/full.local.en.srt", wordsPath: "video/full.local.en.words.json", cueCount: 1 })),
);

vi.mock("@yt2x/adapters-node", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    executeNativeAcquire: executeNativeAcquireMock,
    burnZhSubtitlesForVideo: burnZhSubtitlesForVideoMock,
    transcribeLocal: transcribeLocalMock,
  };
});

import { mergePipelineExitCode, runNativePipeline } from "./native-pipeline.js";

const buildArgs = (overrides: Record<string, unknown>) =>
  PipelineArgsSchema.parse({
    sources: { urls: ["https://youtu.be/abc123def45"] },
    stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    acquire: {},
    article: {},
    publish: {},
    control: {},
    llm: { provider: "openai" },
    flags: {},
    ...overrides,
  });

beforeEach(() => {
  executeNativeNotesMock.mockClear();
  executeNativeArticleMock.mockClear();
  executeNativePublishMock.mockClear();
  executeNativeAcquireMock.mockClear();
  burnZhSubtitlesForVideoMock.mockClear();
  executeNativeDubMock.mockClear();
  transcribeLocalMock.mockClear();
  transcribeLocalMock.mockImplementation(async () => ({
    srtPath: "video/full.local.en.srt",
    wordsPath: "video/full.local.en.words.json",
    cueCount: 1,
  }));
});

describe("mergePipelineExitCode", () => {
  it("keeps the highest non-zero exit code", () => {
    expect(mergePipelineExitCode(0, 4)).toBe(4);
    expect(mergePipelineExitCode(1, 4)).toBe(4);
    expect(mergePipelineExitCode(4, 0)).toBe(4);
  });
});

describe("runNativePipeline", () => {
  it("keeps the normal burn path for bilingual burned subtitles", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-bilingual-burn-"));
    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "auto", notes: "skip", article: "skip", publish: "skip" },
      acquire: { subtitleZh: "burned", subtitleBilingual: "burned" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });

    expect(code).toBe(0);
    expect(executeNativeAcquireMock).toHaveBeenCalledWith(expect.objectContaining({
      acquire: expect.objectContaining({
        subtitleZh: "burned",
        subtitleBilingual: "burned",
      }),
    }));
    expect(burnZhSubtitlesForVideoMock).not.toHaveBeenCalled();
  });

  it("with --acquire skip calls executeNativeNotes per video when pipeline-state manifest exists as dirs", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-"));
    for (const id of ["aaa", "bbb"]) {
      await mkdir(path.join(outRoot, id), { recursive: true });
      await writeFile(path.join(outRoot, id, "metadata.json"), JSON.stringify({ id, title: id }));
    }

    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    });

    const code = await runNativePipeline({
      args,
      monorepoRoot: "/tmp/yt2x-monorepo",
    });

    expect(code).toBe(0);
    expect(executeNativeNotesMock).toHaveBeenCalledTimes(2);
    expect(executeNativeArticleMock).not.toHaveBeenCalled();
    expect(executeNativePublishMock).not.toHaveBeenCalled();
  });

  it("returns 1 when acquire skip and no video dirs", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-empty-"));
    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    });
    const code = await runNativePipeline({ args, monorepoRoot: "/tmp" });
    expect(code).toBe(1);
    expect(executeNativeNotesMock).not.toHaveBeenCalled();
  });

  it("with --acquire skip discovers videos via metadata.json when no root state file", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-meta-"));
    const vid = "metaVid1";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "t" }));

    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(executeNativeNotesMock).toHaveBeenCalledTimes(1);
  });

  it("ignores status-only directories when building the pipeline work queue", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-status-only-"));
    await mkdir(path.join(outRoot, "__missing__"), { recursive: true });
    await writeFile(
      path.join(outRoot, "__missing__", "process-status.json"),
      JSON.stringify({ version: 1, videoId: "__missing__", steps: {} }),
    );
    const vid = "realVideo1";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "real" }));

    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(executeNativeNotesMock).toHaveBeenCalledTimes(1);
    expect(executeNativeNotesMock.mock.calls[0]![0]).toMatchObject({
      videoId: [vid],
    });
  });

  it("returns partial exit code when error-strategy is skip and notes fail", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-skip-"));
    const vid = "aaa";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));

    executeNativeNotesMock.mockResolvedValueOnce(4);

    const args = buildArgs({
      control: { outDir: outRoot, errorStrategy: "skip" },
      stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(4);
  });

  it("treats publish review as dry-run preview instead of real posting", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-pub-review-"));
    const vid = "pubReview1";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));

    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "skip", notes: "skip", article: "skip", publish: "review" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(executeNativePublishMock).toHaveBeenCalledOnce();
    expect(executeNativePublishMock.mock.calls[0]![0]).toMatchObject({
      videoId: vid,
      dryRun: true,
      publishDryRun: true,
    });
  });

  it("passes article targets to native article stage", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-targets-"));
    const vid = "targetVid1";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));

    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "skip", notes: "skip", article: "auto", publish: "skip" },
      article: { targets: "x-thread,x-short" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(executeNativeArticleMock).toHaveBeenCalledOnce();
    expect(executeNativeArticleMock.mock.calls[0]![0]).toMatchObject({
      videoId: [vid],
      targets: "x-thread,x-short",
    });
  });

  it("passes platform article targets to native article stage", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-platform-targets-"));
    const vid = "platformVid1";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));

    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "skip", notes: "skip", article: "auto", publish: "skip" },
      article: { targets: "article", platformTargets: "xiaohongshu,wechat" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(executeNativeArticleMock).toHaveBeenCalledOnce();
    expect(executeNativeArticleMock.mock.calls[0]![0]).toMatchObject({
      videoId: [vid],
      targets: "article",
      platformTargets: "xiaohongshu,wechat",
    });
  });

  it("runs dub after article and skips deferred zh burn when --dub is set", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-dub-"));
    const vid = "dubVid1";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));

    burnZhSubtitlesForVideoMock.mockClear();
    executeNativeDubMock.mockClear();

    const args = buildArgs({
      control: { outDir: outRoot, dub: true, dubEngine: "elevenlabs" },
      stages: { acquire: "skip", notes: "skip", article: "skip", publish: "skip" },
      acquire: { subtitleZh: "burned" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(burnZhSubtitlesForVideoMock).not.toHaveBeenCalled();
    expect(executeNativeDubMock).toHaveBeenCalledOnce();
    expect(executeNativeDubMock.mock.calls[0]![0]).toMatchObject({
      videoId: vid,
      dubEngine: "elevenlabs",
    });
  });

  it("forces bilingual burn off during acquire when --dub is set", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-dub-bilingual-"));
    executeNativeAcquireMock.mockClear();
    executeNativeDubMock.mockClear();
    burnZhSubtitlesForVideoMock.mockClear();

    const args = buildArgs({
      control: { outDir: outRoot, dub: true },
      stages: { acquire: "auto", notes: "skip", article: "skip", publish: "skip" },
      acquire: { subtitleZh: "burned", subtitleBilingual: "burned" },
      sources: { urls: ["https://www.youtube.com/watch?v=abc123def45"] },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(executeNativeAcquireMock).toHaveBeenCalled();
    const acquireOpts = executeNativeAcquireMock.mock.calls[0]![0] as {
      acquire: { subtitleZh?: string; subtitleBilingual?: string };
    };
    expect(acquireOpts.acquire.subtitleZh).toBe("srt");
    expect(acquireOpts.acquire.subtitleBilingual).toBe("off");
    expect(burnZhSubtitlesForVideoMock).not.toHaveBeenCalled();
    expect(executeNativeDubMock).toHaveBeenCalled();
  });

  it("does not force zh subtitle translation for --dub when subtitleZh is off (no consumer left)", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-dub-no-forced-translate-"));

    const args = buildArgs({
      control: { outDir: outRoot, dub: true, dubEngine: "edge-tts" },
      stages: { acquire: "auto", notes: "skip", article: "skip", publish: "skip" },
      acquire: { subtitleZh: "off" },
      sources: { urls: ["https://www.youtube.com/watch?v=abc123def45"] },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(executeNativeAcquireMock).toHaveBeenCalled();
    const acquireOpts = executeNativeAcquireMock.mock.calls[0]![0] as {
      acquire: { subtitleZh?: string };
      llm?: unknown;
    };
    // --dub 不再消费 full.zh.srt：subtitleZh 保持用户的 off，不再被强制翻译。
    expect(acquireOpts.acquire.subtitleZh).toBe("off");
    expect(acquireOpts.llm).toBeUndefined();
  });

  it("transcribes the local words.json before notes/article when --dub is set and no transcript exists", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-dub-transcribe-"));
    const vid = "dubVid2";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));

    const args = buildArgs({
      control: { outDir: outRoot, dub: true, dubEngine: "edge-tts" },
      stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(transcribeLocalMock).toHaveBeenCalledOnce();
    expect(transcribeLocalMock.mock.calls[0]![0]).toMatchObject({
      videoDir: path.join(outRoot, vid),
      language: "en",
    });
    // 转写必须先于 notes，否则花完 notes/article 的钱才失败就晚了。
    expect(transcribeLocalMock.mock.invocationCallOrder[0]).toBeLessThan(
      executeNativeNotesMock.mock.invocationCallOrder[0]!,
    );
  });

  it("skips local transcription when a local transcript already exists", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-dub-skip-transcribe-"));
    const vid = "dubVid3";
    await mkdir(path.join(outRoot, vid, "video"), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));
    await writeFile(
      path.join(outRoot, vid, "video", "full.local.en.words.json"),
      JSON.stringify([{ word: "hi", start: 0, end: 0.2 }]),
    );

    const args = buildArgs({
      control: { outDir: outRoot, dub: true, dubEngine: "edge-tts" },
      stages: { acquire: "skip", notes: "skip", article: "skip", publish: "skip" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(transcribeLocalMock).not.toHaveBeenCalled();
    expect(executeNativeDubMock).toHaveBeenCalledOnce();
  });

  it("fails fast before notes/article when local transcription is unavailable", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-dub-transcribe-unavailable-"));
    const vid = "dubVid4";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));
    transcribeLocalMock.mockImplementation(async () => undefined);

    const args = buildArgs({
      control: { outDir: outRoot, dub: true, dubEngine: "edge-tts" },
      stages: { acquire: "skip", notes: "auto", article: "auto", publish: "skip" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(2); // NATIVE_EXIT.CONFIG_MISSING
    expect(executeNativeNotesMock).not.toHaveBeenCalled();
    expect(executeNativeArticleMock).not.toHaveBeenCalled();
    expect(executeNativeDubMock).not.toHaveBeenCalled();
  });
});
