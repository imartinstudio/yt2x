import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DubPlacementReport, DubScript, DubTimingReport } from "@yt2x/core";
import {
  DUB_PLACEMENT_FILE,
  DUB_SCRIPT_FILE,
  DUB_TIMING_FILE,
  dubDirFor,
  dubLineAudioName,
  parseDubWords,
  readDubWords,
  readDubPlacementReport,
  readDubScript,
  readDubTimingReport,
  resolveDubSourceVideo,
  resolveDubWordsPath,
  writeDubLineAudio,
  writeDubPlacement,
  writeDubScript,
  writeDubTimingReport,
} from "./file-store.js";

const tmpRoot = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "yt2x-dub-store-"));

const seedWords = async (root: string, videoId: string, content: string): Promise<string> => {
  const dir = path.join(root, videoId, "video");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "full.local.en.words.json");
  await writeFile(filePath, content, "utf8");
  return filePath;
};

const WORDS = JSON.stringify([
  { word: "We", start: 1.0, end: 1.2 },
  { word: "look", start: 1.2, end: 1.5 },
  { word: "first.", start: 1.5, end: 3.5 },
  { word: "How", start: 3.5, end: 3.8 },
  { word: "it", start: 3.8, end: 4.0 },
  { word: "works.", start: 4.0, end: 6.0 },
]);

const script: DubScript = {
  version: 3,
  videoId: "<videoId>",
  sourceWords: "video/full.local.en.words.json",
  rewriteModel: "test-model",
  technicalTermProfileFingerprint: "fnv1a-test-profile",
  lines: [
    {
      index: 1,
      startMs: 1_000,
      endMs: 3_500,
      targetDurationMs: 2_500,
      text: "我们先看一下",
      sourceText: "we look first",
      cueIndices: [1],
    },
  ],
  droppedCount: 0,
};

const report: DubTimingReport = {
  version: 1,
  videoId: "<videoId>",
  engine: "edge-tts",
  voice: "zh-CN-YunxiNeural",
  lineCount: 1,
  medianRatio: 1,
  overflowCount: 0,
  totalDriftMs: 0,
  lines: [
    {
      index: 1,
      targetDurationMs: 2_500,
      synthesizedMs: 2_500,
      ratio: 1,
      charCount: 6,
      audioFile: "lines/0001.mp3",
    },
  ],
};

const placement: DubPlacementReport = {
  version: 3,
  runId: "run-abc123",
  generatedAt: "2026-01-01T00:00:00.000Z",
  videoId: "<videoId>",
  engine: "edge-tts",
  voice: "zh-CN-YunxiNeural",
  lines: [
    {
      index: 1,
      action: "keep",
      rate: 1,
      text: "我们先看一下",
      startMs: 0,
      endMs: 2_500,
      durationMs: 2_500,
      audioFile: "lines/0001.mp3",
    },
  ],
  extendMs: 0,
  audioEndMs: 2_500,
  speedCount: 0,
  stretchCount: 0,
  delayCount: 0,
  keepCount: 1,
};

describe("dubDirFor", () => {
  it("puts dub artifacts under files/articles/<videoId>/dub", () => {
    expect(dubDirFor("files/articles", "<videoId>")).toBe(
      path.join("files/articles", "<videoId>", "dub"),
    );
  });
});

describe("dubLineAudioName", () => {
  it("zero-pads to four digits so lexical order equals playback order", () => {
    expect(dubLineAudioName(1, "mp3")).toBe("0001.mp3");
    expect(dubLineAudioName(42, "mp3")).toBe("0042.mp3");
    expect(dubLineAudioName(1234, "wav")).toBe("1234.wav");
    expect(dubLineAudioName(12345, "mp3")).toBe("12345.mp3");
  });
});

describe("resolveDubWordsPath", () => {
  it("resolves the local transcript under the downloads root", async () => {
    const root = await tmpRoot();
    const outRoot = path.join(root, "downloads");
    const expected = await seedWords(outRoot, "<videoId>", WORDS);

    expect(await resolveDubWordsPath({ outRoot, videoId: "<videoId>" })).toBe(expected);
  });

  it("respects a non-default source language", async () => {
    const root = await tmpRoot();
    const outRoot = path.join(root, "downloads");
    const dir = path.join(outRoot, "<videoId>", "video");
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "full.local.ja.words.json");
    await writeFile(filePath, WORDS, "utf8");

    expect(
      await resolveDubWordsPath({ outRoot, videoId: "<videoId>", language: "ja" }),
    ).toBe(filePath);
  });

  it("names the missing candidate when nothing is found", async () => {
    const root = await tmpRoot();
    const outRoot = path.join(root, "downloads");

    await expect(
      resolveDubWordsPath({ outRoot, videoId: "<videoId>" }),
    ).rejects.toThrow(/full\.local\.en\.words\.json/u);
  });
});

const seedSourceMp4 = async (root: string, videoId: string, marker: string): Promise<string> => {
  const dir = path.join(root, videoId, "video");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "full.mp4");
  await writeFile(filePath, marker, "utf8");
  return filePath;
};

describe("resolveDubSourceVideo", () => {
  it("selects the downloads original when both directories have a source video", async () => {
    const root = await tmpRoot();
    const articleRoot = path.join(root, "articles");
    const outRoot = path.join(root, "downloads");
    await seedSourceMp4(articleRoot, "<videoId>", "article-processed");
    const downloadsPath = await seedSourceMp4(outRoot, "<videoId>", "downloads-original");

    const resolved = await resolveDubSourceVideo({
      articleRoot,
      outRoot,
      videoId: "<videoId>",
    });

    expect(resolved.videoPath).toBe(downloadsPath);
    expect(await readFile(resolved.videoPath, "utf8")).toBe("downloads-original");
  });

  it("errors when the original is missing instead of silently using the article copy", async () => {
    const root = await tmpRoot();
    const articleRoot = path.join(root, "articles");
    const outRoot = path.join(root, "downloads");
    await seedSourceMp4(articleRoot, "<videoId>", "article-processed");

    await expect(
      resolveDubSourceVideo({ articleRoot, outRoot, videoId: "<videoId>" }),
    ).rejects.toThrow(/No source video found.*downloads/isu);
  });
});

describe("parseDubWords", () => {
  it("converts start/end seconds to millisecond integers once, at the boundary", () => {
    expect(parseDubWords(WORDS)).toEqual([
      { word: "We", startMs: 1_000, endMs: 1_200 },
      { word: "look", startMs: 1_200, endMs: 1_500 },
      { word: "first.", startMs: 1_500, endMs: 3_500 },
      { word: "How", startMs: 3_500, endMs: 3_800 },
      { word: "it", startMs: 3_800, endMs: 4_000 },
      { word: "works.", startMs: 4_000, endMs: 6_000 },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseDubWords("[]")).toEqual([]);
  });

  it("rejects malformed entries instead of silently dropping fields", () => {
    expect(() => parseDubWords(JSON.stringify([{ word: "x" }]))).toThrow();
  });

  it("reads from disk", async () => {
    const root = await tmpRoot();
    const wordsPath = await seedWords(root, "<videoId>", WORDS);
    expect(await readDubWords(wordsPath)).toHaveLength(6);
  });
});

describe("writers", () => {
  it("writes and reads back the dub script without leaving temp files", async () => {
    const dubDir = path.join(await tmpRoot(), "dub");
    const written = await writeDubScript(dubDir, script);

    expect(written).toBe(path.join(dubDir, DUB_SCRIPT_FILE));
    expect(await readdir(dubDir)).toEqual([DUB_SCRIPT_FILE]);
    expect(await readDubScript(dubDir)).toEqual(script);
    expect((await readFile(written, "utf8")).endsWith("\n")).toBe(true);
  });

  it("writes the timing report as pretty JSON", async () => {
    const dubDir = path.join(await tmpRoot(), "dub");
    const written = await writeDubTimingReport(dubDir, report);

    expect(written).toBe(path.join(dubDir, DUB_TIMING_FILE));
    const parsed = JSON.parse(await readFile(written, "utf8")) as DubTimingReport;
    expect(parsed).toEqual(report);
  });

  it("rejects a corrupt timing report so callers can treat it as a cache miss", async () => {
    const dubDir = path.join(await tmpRoot(), "dub");
    await mkdir(dubDir, { recursive: true });
    await writeFile(
      path.join(dubDir, DUB_TIMING_FILE),
      JSON.stringify({ version: 1, videoId: "x", lines: [] }),
      "utf8",
    );
    await expect(readDubTimingReport(dubDir)).rejects.toThrow(/Invalid dub-timing\.json/);
  });

  it("rejects a legacy version-1 dub-script.json instead of silently reusing it", async () => {
    const dubDir = path.join(await tmpRoot(), "dub");
    await mkdir(dubDir, { recursive: true });
    // 旧链路的产物：sourceSubtitle/中文 sourceText，字段形状与新 schema 不兼容。
    await writeFile(
      path.join(dubDir, DUB_SCRIPT_FILE),
      JSON.stringify({
        version: 1,
        videoId: "x",
        sourceSubtitle: "video/full.zh.srt",
        rewriteModel: "m",
        lines: [],
      }),
      "utf8",
    );
    await expect(readDubScript(dubDir)).rejects.toThrow(
      /legacy dubbing cache from before the current technical-term profile/,
    );
  });

  it("rejects a dub-script.json that fails schema validation even at version 2", async () => {
    const dubDir = path.join(await tmpRoot(), "dub");
    await mkdir(dubDir, { recursive: true });
    await writeFile(
      path.join(dubDir, DUB_SCRIPT_FILE),
      JSON.stringify({ version: 2, videoId: "x", lines: [] }), // missing sourceWords/rewriteModel/droppedCount
      "utf8",
    );
    await expect(readDubScript(dubDir)).rejects.toThrow(/Invalid or incompatible dub-script\.json/);
  });

  it("rejects a complete version 2 script as a cache miss after the terminology schema bump", async () => {
    const dubDir = path.join(await tmpRoot(), "dub");
    await mkdir(dubDir, { recursive: true });
    await writeFile(
      path.join(dubDir, DUB_SCRIPT_FILE),
      JSON.stringify({ ...script, version: 2 }),
      "utf8",
    );
    await expect(readDubScript(dubDir)).rejects.toThrow(/expected schema version 3/);
  });

  it("overwrites an existing artifact atomically", async () => {
    const dubDir = path.join(await tmpRoot(), "dub");
    await writeDubScript(dubDir, script);
    await writeDubScript(dubDir, { ...script, rewriteModel: "second-model" });

    expect(await readdir(dubDir)).toEqual([DUB_SCRIPT_FILE]);
    expect((await readDubScript(dubDir)).rewriteModel).toBe("second-model");
  });

  it("writes the placement report with its run identifier and generation time, and reads it back", async () => {
    // issue #110：写入单测——断言产出的报告包含运行标识与生成时间，且这些值
    // 经过 write → read 的往返后原样可用（不是被写入逻辑丢掉或篡改）。
    const dubDir = path.join(await tmpRoot(), "dub");
    const written = await writeDubPlacement(dubDir, placement);

    expect(written).toBe(path.join(dubDir, DUB_PLACEMENT_FILE));
    const readBack = await readDubPlacementReport(dubDir);
    expect(readBack).toEqual(placement);
    expect(readBack.runId).toBe("run-abc123");
    expect(readBack.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects a placement report truncated down to only its total-duration field", async () => {
    // 校验单测——复现真实事故的残缺形态：文件被覆写成只剩 audioEndMs，
    // 断言读回拒绝它，并且错误信息能定位到文件与目录（口径与 dub-timing.json 一致）。
    const dubDir = path.join(await tmpRoot(), "dub");
    await mkdir(dubDir, { recursive: true });
    await writeFile(
      path.join(dubDir, DUB_PLACEMENT_FILE),
      JSON.stringify({ audioEndMs: 2_500 }),
      "utf8",
    );
    await expect(readDubPlacementReport(dubDir)).rejects.toThrow(/Invalid dub-placement\.json/);
    await expect(readDubPlacementReport(dubDir)).rejects.toThrow(/videoId/);
  });

  it("tells an out-of-date placement report apart from a damaged one", async () => {
    // 两类失败的处置完全不同：版本旧的文件内容完好，重跑一次就有；被覆写成残缺的
    // 才是 #110 事故本身。压成同一条 "Invalid ..." 会让人对着一份好文件去查代码——
    // 正是这道校验本该消除的那类误判。
    const dubDir = path.join(await tmpRoot(), "dub");
    await mkdir(dubDir, { recursive: true });
    await writeFile(
      path.join(dubDir, DUB_PLACEMENT_FILE),
      JSON.stringify({ ...placement, version: 2, runId: undefined, generatedAt: undefined }),
      "utf8",
    );
    await expect(readDubPlacementReport(dubDir)).rejects.toThrow(/older schema/u);
    await expect(readDubPlacementReport(dubDir)).rejects.toThrow(/re-run/u);
    await expect(readDubPlacementReport(dubDir)).rejects.toThrow(/not damaged/u);
    // 而残缺的那条仍然报 Invalid，两者措辞不重叠
    await expect(readDubPlacementReport(dubDir)).rejects.not.toThrow(
      /Invalid dub-placement\.json/u,
    );
  });

  it("writes line audio into lines/ and returns both path forms", async () => {
    const dubDir = path.join(await tmpRoot(), "dub");
    const bytes = new Uint8Array([0x49, 0x44, 0x33]);
    const written = await writeDubLineAudio(dubDir, 7, bytes, "mp3");

    expect(written.relativePath).toBe("lines/0007.mp3");
    expect(written.absolutePath).toBe(path.join(dubDir, "lines", "0007.mp3"));
    expect(new Uint8Array(await readFile(written.absolutePath))).toEqual(bytes);
    expect(await readdir(path.join(dubDir, "lines"))).toEqual(["0007.mp3"]);
  });
});
