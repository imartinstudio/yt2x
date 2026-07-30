import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DubScript, DubTimingReport } from "@yt2x/core";
import {
  DUB_SCRIPT_FILE,
  DUB_TIMING_FILE,
  dubDirFor,
  dubLineAudioName,
  parseDubCues,
  readDubCues,
  readDubScript,
  readDubTimingReport,
  resolveZhSubtitlePath,
  writeDubLineAudio,
  writeDubScript,
  writeDubTimingReport,
} from "./file-store.js";

const tmpRoot = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "yt2x-dub-store-"));

const seedSrt = async (root: string, videoId: string, content: string): Promise<string> => {
  const dir = path.join(root, videoId, "video");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "full.zh.srt");
  await writeFile(filePath, content, "utf8");
  return filePath;
};

const SRT = `1
00:00:01,000 --> 00:00:03,500
我们先看一下

2
00:00:03,500 --> 00:00:06,000
这个工具怎么用
`;

const script: DubScript = {
  version: 1,
  videoId: "<videoId>",
  sourceSubtitle: "video/full.zh.srt",
  rewriteModel: "test-model",
  lines: [
    {
      index: 1,
      startMs: 1_000,
      endMs: 3_500,
      targetDurationMs: 2_500,
      text: "我们先看一下",
      sourceText: "我们先看一下",
      cueIndices: [1],
    },
  ],
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

describe("resolveZhSubtitlePath", () => {
  it("prefers the article directory", async () => {
    const root = await tmpRoot();
    const articleRoot = path.join(root, "articles");
    const outRoot = path.join(root, "downloads");
    const expected = await seedSrt(articleRoot, "<videoId>", SRT);
    await seedSrt(outRoot, "<videoId>", SRT);

    expect(await resolveZhSubtitlePath({ articleRoot, outRoot, videoId: "<videoId>" })).toBe(expected);
  });

  it("falls back to the download directory", async () => {
    const root = await tmpRoot();
    const articleRoot = path.join(root, "articles");
    const outRoot = path.join(root, "downloads");
    const expected = await seedSrt(outRoot, "<videoId>", SRT);

    expect(await resolveZhSubtitlePath({ articleRoot, outRoot, videoId: "<videoId>" })).toBe(expected);
  });

  it("names both candidates when nothing is found", async () => {
    const root = await tmpRoot();
    const articleRoot = path.join(root, "articles");
    const outRoot = path.join(root, "downloads");

    await expect(
      resolveZhSubtitlePath({ articleRoot, outRoot, videoId: "<videoId>" }),
    ).rejects.toThrow(/articles.*downloads/su);
  });
});

describe("parseDubCues", () => {
  it("converts timestamps to milliseconds once, at the boundary", () => {
    expect(parseDubCues(SRT)).toEqual([
      { index: 1, startMs: 1_000, endMs: 3_500, text: "我们先看一下" },
      { index: 2, startMs: 3_500, endMs: 6_000, text: "这个工具怎么用" },
    ]);
  });

  it("joins multi-line cues with a space", () => {
    const cues = parseDubCues(`1
00:00:01,000 --> 00:00:03,000
第一行
第二行
`);
    expect(cues[0]?.text).toBe("第一行 第二行");
  });

  it("returns an empty array for empty input", () => {
    expect(parseDubCues("")).toEqual([]);
  });

  it("reads from disk", async () => {
    const root = await tmpRoot();
    const srtPath = await seedSrt(root, "<videoId>", SRT);
    expect(await readDubCues(srtPath)).toHaveLength(2);
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

  it("overwrites an existing artifact atomically", async () => {
    const dubDir = path.join(await tmpRoot(), "dub");
    await writeDubScript(dubDir, script);
    await writeDubScript(dubDir, { ...script, rewriteModel: "second-model" });

    expect(await readdir(dubDir)).toEqual([DUB_SCRIPT_FILE]);
    expect((await readDubScript(dubDir)).rewriteModel).toBe("second-model");
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
