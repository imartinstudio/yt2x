import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as AdaptersNode from "@yt2x/adapters-node";
import {
  DEFAULT_STRETCH_MAX_OCCUPANCY,
  PREFERRED_RATE_MIN,
  dubTranslateCharBudget,
} from "@yt2x/core";
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

import {
  DEFAULT_MIN_DURATION_MS,
  executeNativeDub,
  negotiationOptionsFrom,
  parseOriginalVoiceVolume,
  resolveDubOutputPath,
  segmentOptionsFrom,
} from "./native-dub.js";

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
  it("defaults minDurationMs to 3000ms so sub-overhead utterances stop clamping to a single char", () => {
    expect(segmentOptionsFrom({})).toEqual({ minDurationMs: DEFAULT_MIN_DURATION_MS });
  });

  it("still leaves room for a full short sentence (>=10 chars) under the calibrated speech rate", () => {
    // 回归哨兵：TTS_FIXED_OVERHEAD_MS / TTS_MS_PER_CHINESE_CHAR 换音色重新标定时，
    // DEFAULT_MIN_DURATION_MS 的推导依据（见其上方注释）必须跟着复核。这条测试
    // 不校验具体常数，只校验派生结果——3000ms 换算出的预算仍要够写一个"简短但
    // 完整的分句"（约 10 个汉字），换算结果比这更紧就说明该重新审视 3000 这个默认值了。
    expect(dubTranslateCharBudget(DEFAULT_MIN_DURATION_MS)).toBeGreaterThanOrEqual(10);
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

describe("parseOriginalVoiceVolume", () => {
  it("returns undefined when --original-voice-volume is not passed (unchanged default behavior)", () => {
    expect(parseOriginalVoiceVolume(undefined)).toBeUndefined();
  });

  it("parses a fractional volume", () => {
    expect(parseOriginalVoiceVolume("0.35")).toBe(0.35);
  });

  it("accepts 0 as a valid value (caller falls back to a two-input mix)", () => {
    expect(parseOriginalVoiceVolume("0")).toBe(0);
  });

  it("rejects a negative value", () => {
    expect(() => parseOriginalVoiceVolume("-0.1")).toThrow(/non-negative/);
  });

  it("rejects a non-numeric value", () => {
    expect(() => parseOriginalVoiceVolume("loud")).toThrow(/non-negative/);
  });

  it("rejects a partially numeric value instead of silently truncating it", () => {
    expect(() => parseOriginalVoiceVolume("0.35oops")).toThrow(/non-negative/);
  });
});

describe("negotiationOptionsFrom", () => {
  it("parses the counterfactual speech-rate floor for a dub run", () => {
    expect(negotiationOptionsFrom({ preferredRateMin: "0.85" })).toEqual({
      preferredRateMin: 0.85,
    });
  });

  it("leaves the default negotiation floor untouched when the flag is omitted", () => {
    expect(negotiationOptionsFrom({})).toEqual({});
  });

  it("rejects an invalid speech-rate floor before the dub starts", () => {
    expect(() => negotiationOptionsFrom({ preferredRateMin: "0.85oops" })).toThrow(
      /positive number/,
    );
  });
});

describe("resolveDubOutputPath", () => {
  const articleRoot = path.resolve("files/articles");
  const videoId = "abc12345678";

  it("resolves an explicit path so separate auditions do not overwrite each other", () => {
    expect(
      resolveDubOutputPath(
        { outputPath: "./files/articles/abc12345678/video/rate-085.mp4" },
        { articleRoot, videoId, timeRange: {} },
      ),
    ).toBe(path.resolve("./files/articles/abc12345678/video/rate-085.mp4"));
  });

  it("keeps the default full-run output when no path is supplied", () => {
    expect(resolveDubOutputPath({}, { articleRoot, videoId, timeRange: {} })).toBe(
      path.join(articleRoot, videoId, "video", "full.zh-dubbed.mp4"),
    );
  });

  it("keeps time-window output isolated under dub/work", () => {
    expect(
      resolveDubOutputPath({}, { articleRoot, videoId, timeRange: { startMs: 0, endMs: 5_000 } }),
    ).toBe(
      path.join(
        articleRoot,
        videoId,
        "dub",
        "work",
        "window-0-5000.zh-dubbed.mp4",
      ),
    );
  });

  it("rejects an explicitly empty output path", () => {
    expect(() =>
      resolveDubOutputPath({ outputPath: "   " }, { articleRoot, videoId, timeRange: {} }),
    ).toThrow(/non-empty path/);
  });

  it("rejects paths outside the article video directory", () => {
    expect(() =>
      resolveDubOutputPath(
        { outputPath: path.join(articleRoot, "..", "downloads", videoId, "video", "bad.mp4") },
        { articleRoot, videoId, timeRange: {} },
      ),
    ).toThrow(/files\/downloads is read-only/);
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

describe("executeNativeDub audition output reuse", () => {
  it("records that an existing audition was reused when its manifest is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-dub-audition-reuse-"));
    const articleRoot = path.join(root, "articles");
    const videoId = "abc12345678";
    const outputPath = path.join(articleRoot, videoId, "video", "rate-085.mp4");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "existing");

    const code = await executeNativeDub({
      videoId,
      articleOutDir: articleRoot,
      outputPath,
      preferredRateMin: "0.85",
    });

    expect(code).toBe(0);
    const manifest = JSON.parse(await readFile(`${outputPath}.audition.json`, "utf8")) as {
      status: string;
      preferredRateMin: number;
      gates: null;
    };
    expect(manifest.status).toBe("reused-existing-output");
    expect(manifest.preferredRateMin).toBe(0.85);
    expect(manifest.gates).toBeNull();
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
    const auditionPath = path.join(articleRoot, videoId, "video", "window-audition.mp4");
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
      outputPath: auditionPath,
    });

    expect(code).toBe(0);
    expect(burnBilingualSubtitlesMock).toHaveBeenCalledOnce();
    const burnCall = burnBilingualSubtitlesMock.mock.calls[0]![0] as {
      outputPath: string;
      srtPath: string;
    };
    const expectedWorkPath = path.join(dubDir, "work", "window-0-5000.zh-dub.srt");
    const fullRunPath = path.join(articleRoot, videoId, "video", "full.zh-dub.srt");
    expect(burnCall.srtPath).toBe(expectedWorkPath);
    expect(burnCall.srtPath).not.toBe(fullRunPath);
    expect(burnCall.outputPath).toBe(auditionPath);
    const manifest = JSON.parse(await readFile(`${auditionPath}.audition.json`, "utf8")) as {
      outputPath: string;
      preferredRateMin: number;
      stretchMaxOccupancy: number;
      flags: { skipGate: boolean };
      gates: { dub: { passed: boolean }; bilingual: { readyForBurn: boolean } };
    };
    expect(manifest.outputPath).toBe(auditionPath);
    // 断言清单如实记录了当次使用的默认值，而不是钉死某个具体数字
    expect(manifest.preferredRateMin).toBe(PREFERRED_RATE_MIN);
    expect(manifest.stretchMaxOccupancy).toBe(DEFAULT_STRETCH_MAX_OCCUPANCY);
    expect(manifest.flags.skipGate).toBe(false);
    expect(manifest.gates.dub.passed).toBe(true);
    expect(manifest.gates.bilingual.readyForBurn).toBe(true);
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

describe("executeNativeDub --original-voice-volume", () => {
  const setupHappyPath = (): void => {
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
    // ratio 1.0 so the negotiation plan keeps the line as-is and the (unmocked, real) TTS
    // adapter is never called.
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
      vocalsPath: "/tmp/vocals.wav",
      skipped: false,
    });
  };

  const runDub = async (
    extra: Pick<Parameters<typeof executeNativeDub>[0], "originalVoiceVolume">,
  ): Promise<{ code: number }> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-dub-voice-volume-"));
    const outRoot = path.join(root, "downloads");
    const articleRoot = path.join(root, "articles");
    const videoId = "abc12345678";
    await mkdir(path.join(outRoot, videoId, "video"), { recursive: true });
    await mkdir(path.join(articleRoot, videoId, "video"), { recursive: true });
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

    // --start-ms/--end-ms 走窗口路径，避免真去 ffprobe 一个假的 full.mp4（时长探测
    // 直接用窗口长度算，不落到真实 ffprobe 调用）——与既有 "executeNativeDub time
    // range" 测试组一致的规避方式。
    const code = await executeNativeDub({
      videoId,
      outDir: outRoot,
      articleOutDir: articleRoot,
      startMs: "0",
      endMs: "5000",
      ...extra,
    });
    return { code };
  };

  it("threads --original-voice-volume through to the remix filter-chain call", async () => {
    setupHappyPath();
    const { code } = await runDub({ originalVoiceVolume: "0.5" });

    expect(code).toBe(0);
    expect(remixDubbedAudioMock).toHaveBeenCalledOnce();
    const remixCall = remixDubbedAudioMock.mock.calls[0]![0] as { originalVoiceVolume?: number };
    expect(remixCall.originalVoiceVolume).toBe(0.5);
  });

  it("does not pass originalVoiceVolume when the flag is omitted (unchanged default behavior)", async () => {
    setupHappyPath();
    const { code } = await runDub({});

    expect(code).toBe(0);
    expect(remixDubbedAudioMock).toHaveBeenCalledOnce();
    const remixCall = remixDubbedAudioMock.mock.calls[0]![0] as { originalVoiceVolume?: number };
    expect(remixCall.originalVoiceVolume).toBeUndefined();
  });

  it("rejects a negative --original-voice-volume before doing any work", async () => {
    setupHappyPath();
    const { code } = await runDub({ originalVoiceVolume: "-1" });

    expect(code).toBeGreaterThan(0);
    expect(guardMock).not.toHaveBeenCalled();
    expect(remixDubbedAudioMock).not.toHaveBeenCalled();
  });
});
