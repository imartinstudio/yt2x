import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupSrt,
  convertSubtitleTextToSrt,
  parseSubtitleBlocks,
  prepareSourceSubtitle,
} from "./video-subtitles.js";

describe("video subtitle SRT conversion", () => {
  it("converts VTT cues into numbered SRT blocks", () => {
    const srt = convertSubtitleTextToSrt(`WEBVTT

00:00:01.000 --> 00:00:03.500
Hello world

00:00:04.000 --> 00:00:06.000
Second line
continued
`);
    expect(srt).toBe(`1
00:00:01,000 --> 00:00:03,500
Hello world

2
00:00:04,000 --> 00:00:06,000
Second line
continued
`);
  });

  it("keeps SRT timecodes and block count readable", () => {
    const cues = parseSubtitleBlocks(`1
00:00:01,000 --> 00:00:02,000
One

2
00:00:03,000 --> 00:00:04,000
Two
`);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: "00:00:01,000", end: "00:00:02,000", text: ["One"] });
  });
});

describe("prepareSourceSubtitle", () => {
  it("copies a user-provided SRT to video/full.en.srt and writes a manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-file-"));
    const source = path.join(root, "source.srt");
    await writeFile(source, "1\n00:00:01,000 --> 00:00:02,000\nHello\n", "utf8");

    const result = await prepareSourceSubtitle({
      videoDir: root,
      sourceLang: "en",
      targetLang: "zh-CN",
      source: "file",
      file: source,
    });

    expect(result.sourceSubtitle).toBe(path.join(root, "video", "full.en.srt"));
    await expect(readFile(path.join(root, "video", "full.en.srt"), "utf8")).resolves.toContain("Hello");
    await expect(readFile(path.join(root, "video", "subtitle-manifest.json"), "utf8")).resolves.toContain(
      '"source_method": "file"',
    );
  });

  it("converts a YouTube VTT subtitle to video/full.en.srt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-vtt-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "Demo.video123.en.vtt"),
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n",
      "utf8",
    );

    const result = await prepareSourceSubtitle({
      videoDir: root,
      sourceLang: "en",
      targetLang: "zh-CN",
      source: "youtube",
    });

    expect(result.manifest.source_method).toBe("youtube_subtitles");
    await expect(readFile(path.join(root, "video", "full.en.srt"), "utf8")).resolves.toContain(
      "00:00:01,000 --> 00:00:02,000",
    );
  });

  it("writes a warning manifest when subtitles are missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-missing-"));

    const result = await prepareSourceSubtitle({
      videoDir: root,
      sourceLang: "en",
      targetLang: "zh-CN",
      source: "youtube",
    });

    expect(result.sourceSubtitle).toBeUndefined();
    expect(result.manifest.warnings).toEqual(["no en YouTube subtitle file found"]);
    await expect(readFile(path.join(root, "video", "subtitle-manifest.json"), "utf8")).resolves.toContain(
      "no en YouTube subtitle file found",
    );
  });
});

describe("cleanupSrt", () => {
  it("merges incremental duplicate cues (Whisper Flow pattern)", () => {
    const srt = `1
00:00:01,000 --> 00:00:01,500
Today we're going

2
00:00:01,500 --> 00:00:01,800
Today we're going to

3
00:00:01,800 --> 00:00:02,200
Today we're going to talk

4
00:00:02,200 --> 00:00:02,800
Today we're going to talk about AI
`;
    const result = cleanupSrt(srt);
    const cues = parseSubtitleBlocks(result);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.start).toBe("00:00:01,000");
    expect(cues[0]!.end).toBe("00:00:02,800");
    expect(cues[0]!.text.join(" ")).toBe("Today we're going to talk about AI");
  });

  it("merges ultra-short duration cues into adjacent", () => {
    const srt = `1
00:00:01,000 --> 00:00:01,050
Quick

2
00:00:01,050 --> 00:00:04,000
The full explanation follows here
`;
    const result = cleanupSrt(srt);
    const cues = parseSubtitleBlocks(result);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.start).toBe("00:00:01,000");
    expect(cues[0]!.end).toBe("00:00:04,000");
  });

  it("does not merge unrelated cues even without punctuation", () => {
    // Sentence continuation merging was removed — too aggressive for Chinese.
    const srt = `1
00:00:01,000 --> 00:00:03,000
This thought continues

2
00:00:03,000 --> 00:00:05,000
into the next subtitle block
`;
    const result = cleanupSrt(srt);
    const cues = parseSubtitleBlocks(result);
    expect(cues).toHaveLength(2);
  });

  it("does not merge when combined duration exceeds 8s cap", () => {
    const srt = `1
00:00:01,000 --> 00:00:05,000
Hello

2
00:00:05,000 --> 00:00:15,000
Hello world
`;
    const result = cleanupSrt(srt);
    const cues = parseSubtitleBlocks(result);
    // "Hello" is a substring of "Hello world" but merging would create 14s cue > 8s cap
    expect(cues).toHaveLength(2);
  });

  it("keeps well-formed cues untouched", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
First complete sentence.

2
00:00:04,000 --> 00:00:07,000
Second complete sentence!
`;
    const result = cleanupSrt(srt);
    const cues = parseSubtitleBlocks(result);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text.join(" ")).toBe("First complete sentence.");
    expect(cues[1]!.text.join(" ")).toBe("Second complete sentence!");
  });

  it("does not merge across sentence boundaries when durations are reasonable", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Hello world.

2
00:00:04,000 --> 00:00:07,000
Completely different topic here.
`;
    const result = cleanupSrt(srt);
    const cues = parseSubtitleBlocks(result);
    expect(cues).toHaveLength(2);
  });

  it("passes through single-cue input unchanged", () => {
    const srt = `1
00:00:01,000 --> 00:00:05,000
Only one cue.
`;
    const result = cleanupSrt(srt);
    expect(result).toBe(srt);
  });

  it("merges sliding-window cues up to max character limit", () => {
    // YouTube two-line subtitles: adjacent cues with line overlap merge,
    // but stops when combined text would exceed MAX_MERGED_CHARS (80).
    const srt = `1
00:00:01,000 --> 00:00:03,000
Tools like Codex are
taking over the world

2
00:00:03,000 --> 00:00:05,000
taking over the world
but no one's talking

3
00:00:05,000 --> 00:00:07,000
but no one's talking
about the tools you use
`;
    const result = cleanupSrt(srt);
    const cues = parseSubtitleBlocks(result);
    // First two merge (67 chars), third is blocked (would be 87 > 80)
    expect(cues).toHaveLength(2);
    expect(cues[0]!.start).toBe("00:00:01,000");
    expect(cues[0]!.end).toBe("00:00:05,000");
    expect(cues[0]!.text).toEqual([
      "Tools like Codex are",
      "taking over the world",
      "but no one's talking",
    ]);
  });

  it("handles empty input gracefully", () => {
    expect(cleanupSrt("")).toBe("");
  });
});
