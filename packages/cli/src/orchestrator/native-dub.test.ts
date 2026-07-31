import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as AdaptersNode from "@yt2x/adapters-node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const probeDemucsMock = vi.hoisted(() => vi.fn(async () => "/usr/bin/python3"));
const generateDubScriptMock = vi.hoisted(() => vi.fn());
const synthesizeDubLinesMock = vi.hoisted(() => vi.fn());
const separateDemucsMock = vi.hoisted(() => vi.fn());
const remixDubbedVideoMock = vi.hoisted(() => vi.fn());
const guardMock = vi.hoisted(() =>
  vi.fn(async () => {
    throw Object.assign(new Error("hard subs"), {
      name: "DubHardSubtitleError",
      code: "DUB_HARD_SUBTITLE_SOURCE",
    });
  }),
);

vi.mock("@yt2x/adapters-node", async (importOriginal) => {
  const actual = await importOriginal<typeof AdaptersNode>();
  return {
    ...actual,
    createLlmAdapter: vi.fn(() => ({ chat: vi.fn() })),
    probeDemucs: probeDemucsMock,
    generateDubScript: generateDubScriptMock,
    synthesizeDubLines: synthesizeDubLinesMock,
    separateDemucs: separateDemucsMock,
    remixDubbedVideo: remixDubbedVideoMock,
    guardDubSourceAgainstHardSubtitles: guardMock,
  };
});

import { executeNativeDub } from "./native-dub.js";

beforeEach(() => {
  probeDemucsMock.mockClear();
  generateDubScriptMock.mockClear();
  synthesizeDubLinesMock.mockClear();
  separateDemucsMock.mockClear();
  remixDubbedVideoMock.mockClear();
  guardMock.mockClear();
  guardMock.mockImplementation(async () => {
    throw Object.assign(new Error("hard subs"), {
      name: "DubHardSubtitleError",
      code: "DUB_HARD_SUBTITLE_SOURCE",
      message:
        "Source video already has burned Chinese hard subtitles. Use an unburned original.",
    });
  });
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
});

describe("executeNativeDub hard-subtitle guard", () => {
  it("refuses before Demucs, LLM translation, or TTS when the source has Chinese hard subs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-dub-guard-"));
    const outRoot = path.join(root, "downloads");
    const articleRoot = path.join(root, "articles");
    const videoId = "abc12345678";
    await mkdir(path.join(outRoot, videoId, "video"), { recursive: true });
    await mkdir(path.join(articleRoot, videoId, "video"), { recursive: true });
    await writeFile(path.join(outRoot, videoId, "video", "full.mp4"), "original");

    const code = await executeNativeDub({
      videoId,
      outDir: outRoot,
      articleOutDir: articleRoot,
    });

    expect(code).toBeGreaterThan(0);
    expect(guardMock).toHaveBeenCalledOnce();
    expect(probeDemucsMock).not.toHaveBeenCalled();
    expect(generateDubScriptMock).not.toHaveBeenCalled();
    expect(synthesizeDubLinesMock).not.toHaveBeenCalled();
    expect(separateDemucsMock).not.toHaveBeenCalled();
    expect(remixDubbedVideoMock).not.toHaveBeenCalled();
  });
});

describe("executeNativeDub time range", () => {
  it("translates only utterances inside --start-ms/--end-ms and ignores a full-run script cache", async () => {
    guardMock.mockResolvedValue({
      hasBurnedSubtitles: false,
      hasChineseBurnedSubtitles: false,
      shouldSkipBurn: false,
    });
    generateDubScriptMock.mockResolvedValue({
      script: {
        version: 1,
        videoId: "abc12345678",
        sourceWords: "video/full.local.en.words.json",
        rewriteModel: "test-model",
        lines: [
          {
            index: 1,
            startMs: 1_000,
            endMs: 2_000,
            targetDurationMs: 1_000,
            text: "窗内句",
            sourceText: "Inside the window.",
            cueIndices: [1],
          },
        ],
      },
      warnings: [],
      translatedCount: 1,
      droppedCount: 0,
    });

    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-dub-range-"));
    const outRoot = path.join(root, "downloads");
    const articleRoot = path.join(root, "articles");
    const videoId = "abc12345678";
    const dubDir = path.join(articleRoot, videoId, "dub");
    await mkdir(path.join(outRoot, videoId, "video"), { recursive: true });
    await mkdir(path.join(articleRoot, videoId, "video"), { recursive: true });
    await mkdir(dubDir, { recursive: true });
    // 词级时间戳：一句落在窗内（1.0-2.0s），一句远在窗外（180s）——两句都以句末
    // 标点收尾，segmentUtterances 会切成两个独立话语单元，交给时间窗过滤。
    await writeFile(
      path.join(outRoot, videoId, "video", "full.local.en.words.json"),
      JSON.stringify([
        { word: "Inside", start: 1.0, end: 1.3 },
        { word: "the", start: 1.3, end: 1.5 },
        { word: "window.", start: 1.5, end: 2.0 },
        { word: "Outside", start: 180.0, end: 180.3 },
        { word: "the", start: 180.3, end: 180.5 },
        { word: "window.", start: 180.5, end: 182.0 },
      ]),
      "utf8",
    );
    // Full-run cache that would silently skip filtering if reused.
    await writeFile(
      path.join(dubDir, "dub-script.json"),
      JSON.stringify({
        version: 1,
        videoId,
        sourceWords: "video/full.local.en.words.json",
        rewriteModel: "cached",
        lines: [
          {
            index: 1,
            startMs: 1_000,
            endMs: 2_000,
            targetDurationMs: 1_000,
            text: "窗内句",
            sourceText: "Inside the window.",
            cueIndices: [1],
          },
          {
            index: 2,
            startMs: 180_000,
            endMs: 182_000,
            targetDurationMs: 2_000,
            text: "窗外句不应进入配音稿",
            sourceText: "Outside the window.",
            cueIndices: [2],
          },
        ],
      }),
      "utf8",
    );

    const code = await executeNativeDub({
      videoId,
      outDir: outRoot,
      articleOutDir: articleRoot,
      scriptOnly: true,
      startMs: "0",
      endMs: "5000",
    });

    expect(code).toBe(0);
    expect(generateDubScriptMock).toHaveBeenCalledOnce();
    const utterances = generateDubScriptMock.mock.calls[0]![0].utterances as Array<{
      text: string;
      endMs: number;
    }>;
    expect(utterances).toHaveLength(1);
    expect(utterances[0]?.text).toBe("Inside the window.");
    expect(utterances.every((u) => u.endMs <= 5_000)).toBe(true);
    expect(synthesizeDubLinesMock).not.toHaveBeenCalled();
  });
});
