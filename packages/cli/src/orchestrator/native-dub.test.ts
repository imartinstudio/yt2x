import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as AdaptersNode from "@yt2x/adapters-node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const probeDemucsMock = vi.hoisted(() => vi.fn(async () => "/usr/bin/python3"));
const generateDubScriptMock = vi.hoisted(() => vi.fn());
const synthesizeDubLinesMock = vi.hoisted(() => vi.fn());
const separateDemucsMock = vi.hoisted(() => vi.fn());
const remixDubbedAudioMock = vi.hoisted(() => vi.fn());
const evaluateDubBilingualGateMock = vi.hoisted(() => vi.fn());
const burnBilingualSubtitlesMock = vi.hoisted(() => vi.fn());
// Real window extraction shells out to ffmpeg; mocked here since these tests exercise
// reverse-SRT path routing, not ffmpeg trimming.
const extractDubSourceWindowMock = vi.hoisted(() => vi.fn(async () => undefined));
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
    remixDubbedAudio: remixDubbedAudioMock,
    evaluateDubBilingualGate: evaluateDubBilingualGateMock,
    burnBilingualSubtitles: burnBilingualSubtitlesMock,
    guardDubSourceAgainstHardSubtitles: guardMock,
    extractDubSourceWindow: extractDubSourceWindowMock,
  };
});

import { DEFAULT_MIN_DURATION_MS, executeNativeDub, segmentOptionsFrom } from "./native-dub.js";

beforeEach(() => {
  probeDemucsMock.mockClear();
  generateDubScriptMock.mockClear();
  synthesizeDubLinesMock.mockClear();
  separateDemucsMock.mockClear();
  remixDubbedAudioMock.mockClear();
  remixDubbedAudioMock.mockResolvedValue({
    videoForBurnPath: "/downloads/full.mp4",
    replaceAudioPath: "/tmp/mixed.m4a",
    voiceTrackPath: "/tmp/voice.wav",
    mixedAudioPath: "/tmp/mixed.m4a",
    outputDurationMs: 5_000,
    videoPadMs: 0,
    extendMs: 0,
  });
  evaluateDubBilingualGateMock.mockClear();
  evaluateDubBilingualGateMock.mockResolvedValue({ readyForBurn: true, issues: [] });
  burnBilingualSubtitlesMock.mockClear();
  burnBilingualSubtitlesMock.mockResolvedValue({ burned: true, skipped: false, warnings: [] });
  extractDubSourceWindowMock.mockClear();
  extractDubSourceWindowMock.mockImplementation(async () => undefined);
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

describe("segmentOptionsFrom", () => {
  it("defaults minDurationMs to 3000ms so sub-1.9s utterances stop clamping to a single char", () => {
    expect(segmentOptionsFrom({})).toEqual({ minDurationMs: DEFAULT_MIN_DURATION_MS });
  });

  it("honors --min-duration-ms when provided", () => {
    expect(segmentOptionsFrom({ minDurationMs: "5000" })).toEqual({ minDurationMs: 5_000 });
  });

  it("still passes through --max-duration-ms alongside the min-duration default", () => {
    expect(segmentOptionsFrom({ maxDurationMs: "8000" })).toEqual({
      maxDurationMs: 8_000,
      minDurationMs: DEFAULT_MIN_DURATION_MS,
    });
  });
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
    expect(remixDubbedAudioMock).not.toHaveBeenCalled();
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
        version: 2,
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
        droppedCount: 0,
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
        version: 2,
        videoId,
        sourceWords: "video/full.local.en.words.json",
        rewriteModel: "cached",
        droppedCount: 0,
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

  it("writes the time-window reverse SRT to dub/work/, not the full-run video/full.zh-dub.srt path", async () => {
    guardMock.mockResolvedValue({
      hasBurnedSubtitles: false,
      hasChineseBurnedSubtitles: false,
      shouldSkipBurn: false,
    });
    generateDubScriptMock.mockResolvedValue({
      script: {
        version: 2,
        videoId: "abc12345678",
        sourceWords: "video/full.local.en.words.json",
        rewriteModel: "test-model",
        droppedCount: 0,
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
    // ratio 1.0 (synthesizedMs === targetDurationMs) so the negotiation plan keeps this line
    // as-is and applyDubNegotiation reuses the existing audio file instead of calling the
    // (unmocked, real) TTS adapter.
    synthesizeDubLinesMock.mockResolvedValue({
      report: {
        version: 1,
        videoId: "abc12345678",
        engine: "edge-tts",
        voice: "test-voice",
        lineCount: 1,
        medianRatio: 1,
        overflowCount: 0,
        totalDriftMs: 0,
        lines: [
          {
            index: 1,
            targetDurationMs: 1_000,
            synthesizedMs: 1_000,
            ratio: 1,
            charCount: 3,
            audioFile: "lines/0001.mp3",
          },
        ],
      },
      warnings: [],
    });
    separateDemucsMock.mockResolvedValue({
      noVocalsPath: "/tmp/no_vocals.wav",
      skipped: false,
    });

    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-dub-window-srt-"));
    const outRoot = path.join(root, "downloads");
    const articleRoot = path.join(root, "articles");
    const videoId = "abc12345678";
    const dubDir = path.join(articleRoot, videoId, "dub");
    await mkdir(path.join(outRoot, videoId, "video"), { recursive: true });
    await mkdir(path.join(articleRoot, videoId, "video"), { recursive: true });
    await mkdir(dubDir, { recursive: true });
    await writeFile(path.join(outRoot, videoId, "video", "full.mp4"), "original");
    await writeFile(
      path.join(outRoot, videoId, "video", "full.local.en.words.json"),
      JSON.stringify([
        { word: "Inside", start: 1.0, end: 1.3 },
        { word: "the", start: 1.3, end: 1.5 },
        { word: "window.", start: 1.5, end: 2.0 },
      ]),
      "utf8",
    );

    const code = await executeNativeDub({
      videoId,
      outDir: outRoot,
      articleOutDir: articleRoot,
      startMs: "0",
      endMs: "5000",
    });

    expect(code).toBe(0);
    expect(burnBilingualSubtitlesMock).toHaveBeenCalledOnce();
    const burnCall = burnBilingualSubtitlesMock.mock.calls[0]![0] as { srtPath: string };
    const expectedWorkPath = path.join(dubDir, "work", "window-0-5000.zh-dub.srt");
    const fullRunPath = path.join(articleRoot, videoId, "video", "full.zh-dub.srt");
    expect(burnCall.srtPath).toBe(expectedWorkPath);
    expect(burnCall.srtPath).not.toBe(fullRunPath);
  });

  it("separates Demucs into dub/work/demucs for a time window, not the full-run dub/demucs dir", async () => {
    guardMock.mockResolvedValue({
      hasBurnedSubtitles: false,
      hasChineseBurnedSubtitles: false,
      shouldSkipBurn: false,
    });
    generateDubScriptMock.mockResolvedValue({
      script: {
        version: 2,
        videoId: "abc12345678",
        sourceWords: "video/full.local.en.words.json",
        rewriteModel: "test-model",
        droppedCount: 0,
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
    // ratio 1.0 (synthesizedMs === targetDurationMs) so the negotiation plan keeps this line
    // as-is and applyDubNegotiation reuses the existing audio file instead of calling the
    // (unmocked, real) TTS adapter.
    synthesizeDubLinesMock.mockResolvedValue({
      report: {
        version: 1,
        videoId: "abc12345678",
        engine: "edge-tts",
        voice: "test-voice",
        lineCount: 1,
        medianRatio: 1,
        overflowCount: 0,
        totalDriftMs: 0,
        lines: [
          {
            index: 1,
            targetDurationMs: 1_000,
            synthesizedMs: 1_000,
            ratio: 1,
            charCount: 3,
            audioFile: "lines/0001.mp3",
          },
        ],
      },
      warnings: [],
    });
    separateDemucsMock.mockResolvedValue({
      noVocalsPath: "/tmp/no_vocals.wav",
      skipped: false,
    });

    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-dub-window-demucs-"));
    const outRoot = path.join(root, "downloads");
    const articleRoot = path.join(root, "articles");
    const videoId = "abc12345678";
    const dubDir = path.join(articleRoot, videoId, "dub");
    await mkdir(path.join(outRoot, videoId, "video"), { recursive: true });
    await mkdir(path.join(articleRoot, videoId, "video"), { recursive: true });
    await mkdir(dubDir, { recursive: true });
    await writeFile(path.join(outRoot, videoId, "video", "full.mp4"), "original");
    await writeFile(
      path.join(outRoot, videoId, "video", "full.local.en.words.json"),
      JSON.stringify([
        { word: "Inside", start: 1.0, end: 1.3 },
        { word: "the", start: 1.3, end: 1.5 },
        { word: "window.", start: 1.5, end: 2.0 },
      ]),
      "utf8",
    );

    const code = await executeNativeDub({
      videoId,
      outDir: outRoot,
      articleOutDir: articleRoot,
      startMs: "0",
      endMs: "5000",
    });

    expect(code).toBe(0);
    expect(separateDemucsMock).toHaveBeenCalledOnce();
    const demucsCall = separateDemucsMock.mock.calls[0]![0] as { outDir: string };
    const expectedWorkDemucsDir = path.join(dubDir, "work", "demucs");
    const fullRunDemucsDir = path.join(dubDir, "demucs");
    expect(demucsCall.outDir).toBe(expectedWorkDemucsDir);
    expect(demucsCall.outDir).not.toBe(fullRunDemucsDir);
  });

  it("ignores a stale version-1 (pre-PR3) dub-script.json full-run cache instead of reusing it", async () => {
    guardMock.mockResolvedValue({
      hasBurnedSubtitles: false,
      hasChineseBurnedSubtitles: false,
      shouldSkipBurn: false,
    });
    generateDubScriptMock.mockResolvedValue({
      script: {
        version: 2,
        videoId: "abc12345678",
        sourceWords: "video/full.local.en.words.json",
        rewriteModel: "fresh-model",
        lines: [
          {
            index: 1,
            startMs: 1_000,
            endMs: 2_000,
            targetDurationMs: 1_000,
            text: "重新生成的句子",
            sourceText: "Inside the window.",
            cueIndices: [1],
          },
        ],
        droppedCount: 0,
      },
      warnings: [],
      translatedCount: 1,
      droppedCount: 0,
    });

    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-dub-stale-cache-"));
    const outRoot = path.join(root, "downloads");
    const articleRoot = path.join(root, "articles");
    const videoId = "abc12345678";
    const dubDir = path.join(articleRoot, videoId, "dub");
    await mkdir(path.join(outRoot, videoId, "video"), { recursive: true });
    await mkdir(path.join(articleRoot, videoId, "video"), { recursive: true });
    await mkdir(dubDir, { recursive: true });
    await writeFile(
      path.join(outRoot, videoId, "video", "full.local.en.words.json"),
      JSON.stringify([
        { word: "Inside", start: 1.0, end: 1.3 },
        { word: "the", start: 1.3, end: 1.5 },
        { word: "window.", start: 1.5, end: 2.0 },
      ]),
      "utf8",
    );
    // Pre-PR3 shape: sourceSubtitle instead of sourceWords, no droppedCount, version 1 —
    // must never be read back as-is (readDubScript rejects it; native-dub falls through
    // to regeneration rather than silently reusing the old Chinese-subtitle-era script).
    await writeFile(
      path.join(dubDir, "dub-script.json"),
      JSON.stringify({
        version: 1,
        videoId,
        sourceSubtitle: "video/full.zh.srt",
        rewriteModel: "stale-cached",
        lines: [
          {
            index: 1,
            startMs: 1_000,
            endMs: 2_000,
            targetDurationMs: 1_000,
            text: "旧链路缓存的句子",
            sourceText: "旧链路缓存的中文原文",
            cueIndices: [1],
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
    });

    expect(code).toBe(0);
    // 缓存版本不兼容必须被拒绝并重新生成，而不是静默复用旧链路的中文改写稿。
    expect(generateDubScriptMock).toHaveBeenCalledOnce();
  });

  it("does not reuse dub-timing.json (or its audio) once dub-script.json was rejected as stale", async () => {
    guardMock.mockResolvedValue({
      hasBurnedSubtitles: false,
      hasChineseBurnedSubtitles: false,
      shouldSkipBurn: false,
    });
    generateDubScriptMock.mockResolvedValue({
      script: {
        version: 2,
        videoId: "abc12345678",
        sourceWords: "video/full.local.en.words.json",
        rewriteModel: "fresh-model",
        lines: [
          {
            index: 1,
            startMs: 1_000,
            endMs: 2_000,
            targetDurationMs: 1_000,
            // Deliberately the same length as the stale cached line's text below, so a
            // charCount-only check would be fooled — only the scriptFromCache gate should
            // stop the stale dub-timing.json/audio from being reused here.
            text: "新链路生成的句子",
            sourceText: "Inside the window.",
            cueIndices: [1],
          },
        ],
        droppedCount: 0,
      },
      warnings: [],
      translatedCount: 1,
      droppedCount: 0,
    });
    synthesizeDubLinesMock.mockResolvedValue({
      report: {
        version: 1,
        videoId: "abc12345678",
        engine: "edge-tts",
        voice: "zh-CN-YunxiNeural",
        lineCount: 1,
        medianRatio: 1,
        overflowCount: 0,
        totalDriftMs: 0,
        lines: [
          {
            index: 1,
            targetDurationMs: 1_000,
            synthesizedMs: 1_000,
            ratio: 1,
            charCount: 8,
            audioFile: "lines/0001.mp3",
          },
        ],
      },
      warnings: [],
    });

    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-dub-stale-timing-"));
    const outRoot = path.join(root, "downloads");
    const articleRoot = path.join(root, "articles");
    const videoId = "abc12345678";
    const dubDir = path.join(articleRoot, videoId, "dub");
    await mkdir(path.join(outRoot, videoId, "video"), { recursive: true });
    await mkdir(path.join(articleRoot, videoId, "video"), { recursive: true });
    await mkdir(dubDir, { recursive: true });
    await writeFile(
      path.join(outRoot, videoId, "video", "full.local.en.words.json"),
      JSON.stringify([
        { word: "Inside", start: 1.0, end: 1.3 },
        { word: "the", start: 1.3, end: 1.5 },
        { word: "window.", start: 1.5, end: 2.0 },
      ]),
      "utf8",
    );
    // Pre-PR3 stale script (rejected by version-gate) sitting alongside a dub-timing.json
    // whose shape has never changed and therefore passes DubTimingReportSchema untouched.
    await writeFile(
      path.join(dubDir, "dub-script.json"),
      JSON.stringify({
        version: 1,
        videoId,
        sourceSubtitle: "video/full.zh.srt",
        rewriteModel: "stale-cached",
        lines: [
          {
            index: 1,
            startMs: 1_000,
            endMs: 2_000,
            targetDurationMs: 1_000,
            text: "旧链路缓存的句子",
            sourceText: "旧链路缓存的中文原文",
            cueIndices: [1],
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      path.join(dubDir, "dub-timing.json"),
      JSON.stringify({
        version: 1,
        videoId,
        engine: "edge-tts",
        voice: "zh-CN-YunxiNeural",
        lineCount: 1,
        medianRatio: 1,
        overflowCount: 0,
        totalDriftMs: 0,
        lines: [
          {
            index: 1,
            targetDurationMs: 1_000,
            synthesizedMs: 1_000,
            ratio: 1,
            charCount: 8,
            audioFile: "lines/0001.mp3",
          },
        ],
      }),
      "utf8",
    );
    await mkdir(path.join(dubDir, "lines"), { recursive: true });
    await writeFile(path.join(dubDir, "lines", "0001.mp3"), "stale-audio");

    const code = await executeNativeDub({
      videoId,
      outDir: outRoot,
      articleOutDir: articleRoot,
      timingOnly: true,
    });

    expect(code).toBe(0);
    expect(generateDubScriptMock).toHaveBeenCalledOnce();
    // The regression: once the stale script is rejected, the stale dub-timing.json (and by
    // extension the stale lines/0001.mp3 audio it points at) must never be reused — synthesis
    // must re-run against the freshly generated script.
    expect(synthesizeDubLinesMock).toHaveBeenCalledOnce();
    const synthArgs = synthesizeDubLinesMock.mock.calls[0]?.[0] as { script: { lines: Array<{ text: string }> } };
    expect(synthArgs.script.lines[0]?.text).toBe("新链路生成的句子");
  });
});
