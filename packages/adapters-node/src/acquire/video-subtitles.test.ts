import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import {
  cleanupSrt,
  convertSubtitleTextToSrt,
  detectSubtitleLanguage,
  parseSubtitleBlocks,
  prepareSourceSubtitle,
  runSubtitlePipeline,
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
  it("rejects a local transcription with a long consecutive run of duplicate cues", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-transcribe-repeat-"));
    const repeatedSrt = Array.from(
      { length: 18 },
      (_, index) => `${index + 1}\n00:00:${String(index * 2).padStart(2, "0")},000 --> 00:00:${String(index * 2 + 2).padStart(2, "0")},000\n我记得很棒，因为我非常喜欢那个演员。`,
    ).join("\n\n");

    await expect(
      prepareSourceSubtitle({
        videoDir: root,
        sourceLang: "zh",
        targetLang: "zh-CN",
        source: "transcribe",
        runner: {
          run: async (spec) => {
            if (spec.command === "whisper-cli") {
              const outputIndex = spec.args!.indexOf("-of");
              await writeFile(`${spec.args![outputIndex + 1]}.srt`, repeatedSrt, "utf8");
            }
            return {
              exitCode: 0,
              signal: null,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              durationMs: 0,
              command: spec.command,
              args: spec.args ?? [],
            };
          },
        },
      }),
    ).rejects.toThrow(/repeated subtitle cues/);
  });

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

  it("records the actual Chinese script variant from the YouTube subtitle filename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-hant-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "Demo.video123.zh-Hant.vtt"),
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n這是一段繁體字幕\n",
      "utf8",
    );

    const result = await prepareSourceSubtitle({
      videoDir: root,
      sourceLang: "en",
      targetLang: "zh-CN",
      source: "youtube",
    });

    expect(result.manifest.source_language).toBe("zh-Hant");
  });

  it("prefers Simplified Chinese subtitle files when multiple Chinese variants exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-zh-priority-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "Demo.video123.zh-Hant.srt"),
      "1\n00:00:01,000 --> 00:00:02,000\n這是繁體\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "Demo.video123.zh-CN.srt"),
      "1\n00:00:01,000 --> 00:00:02,000\n这是简体\n",
      "utf8",
    );

    const result = await prepareSourceSubtitle({
      videoDir: root,
      sourceLang: "en",
      targetLang: "zh-CN",
      source: "youtube",
    });

    expect(result.manifest.source_language).toBe("zh-CN");
    await expect(readFile(path.join(root, "video", "full.en.srt"), "utf8")).resolves.toContain(
      "这是简体",
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
    expect(result.manifest.warnings).toEqual(["no YouTube subtitle file found (tried: zh-CN, en)"]);
    await expect(readFile(path.join(root, "video", "subtitle-manifest.json"), "utf8")).resolves.toContain(
      "no YouTube subtitle file found (tried: zh-CN, en)",
    );
  });
});

describe("runSubtitlePipeline", () => {
  it("translates Traditional Chinese subtitles to Simplified Chinese before marking full.zh.srt ready", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-pipeline-hant-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "Demo.video123.zh-Hant.srt"),
      `1
00:00:01,000 --> 00:00:02,000
這是一段繁體字幕
`,
      "utf8",
    );

    const seenSystemPrompts: string[] = [];
    const llm: LlmPort = {
      chat: async (req: ChatRequest): Promise<ChatResponse> => {
        seenSystemPrompts.push(req.messages[0]!.content);
        return {
          content: JSON.stringify([{ index: 1, text: "这是一段简体字幕" }]),
          model: "test",
          finishReason: "stop",
        };
      },
    };

    const result = await runSubtitlePipeline({
      videoDir: root,
      subtitle: {
        mode: "srt",
        sourceLang: "en",
        targetLang: "zh-CN",
        source: "youtube",
      },
      llm,
      llmModel: "test",
      runner: {
        run: async (spec) => ({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 0,
          command: spec.command,
          args: spec.args ?? [],
        }),
      },
    });

    await expect(readFile(path.join(root, "video", "full.zh.srt"), "utf8")).resolves.toContain(
      "这是一段简体字幕",
    );
    expect(result.manifest.source_language).toBe("zh-Hant");
    expect(result.manifest.translation_method).toBe("llm");
    expect(seenSystemPrompts[0]).toMatch(/Translate from zh-Hant to zh-CN/);
    expect(seenSystemPrompts[0]).toMatch(/Simplified Chinese/);
    expect(seenSystemPrompts[0]).toMatch(/Traditional Chinese output is FORBIDDEN/);
  });

  it("translates when source_language is bare 'zh' but subtitle content is Traditional Chinese", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-pipeline-bare-zh-"));
    await mkdir(root, { recursive: true });
    // YouTube often exports subtitles with just "zh" language tag even when
    // the actual content is Traditional Chinese (zh-Hant).
    await writeFile(
      path.join(root, "Demo.video123.zh.srt"),
      `1
00:00:01,000 --> 00:00:02,000
這是一段被標記為 zh 的繁體中文字幕
`,
      "utf8",
    );

    const seenSystemPrompts: string[] = [];
    const llm: LlmPort = {
      chat: async (req: ChatRequest): Promise<ChatResponse> => {
        seenSystemPrompts.push(req.messages[0]!.content);
        return {
          content: JSON.stringify([{ index: 1, text: "这是一段被标记为 zh 的简体中文字幕" }]),
          model: "test",
          finishReason: "stop",
        };
      },
    };

    const result = await runSubtitlePipeline({
      videoDir: root,
      subtitle: {
        mode: "srt",
        sourceLang: "en",
        targetLang: "zh-CN",
        source: "youtube",
      },
      llm,
      llmModel: "test",
      runner: {
        run: async (spec) => ({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 0,
          command: spec.command,
          args: spec.args ?? [],
        }),
      },
    });

    await expect(readFile(path.join(root, "video", "full.zh.srt"), "utf8")).resolves.toContain(
      "这是一段被标记为 zh 的简体中文字幕",
    );
    expect(result.manifest.source_language).toBe("zh");
    // isAlreadyTargetLanguage now returns false for bare "zh" when target is zh-CN,
    // so translation is triggered by the language-code mismatch (not by opencc content detection).
    expect(result.manifest.translation_method).toBe("llm");
    expect(seenSystemPrompts[0]).toMatch(/Simplified Chinese/);
    expect(seenSystemPrompts[0]).toMatch(/Traditional Chinese output is FORBIDDEN/);
  });

  it("translates when source_language claims zh-CN but subtitle content is Traditional Chinese", async () => {
    // Defense-in-depth: even if the language tag says zh-CN, opencc-js detection
    // catches Traditional Chinese content and forces translation.
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-pipeline-fake-zhcn-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "Demo.video123.zh-CN.srt"),
      `1
00:00:01,000 --> 00:00:02,000
這是一段被錯誤標記為 zh-CN 的繁體中文字幕
`,
      "utf8",
    );

    const seenSystemPrompts: string[] = [];
    const llm: LlmPort = {
      chat: async (req: ChatRequest): Promise<ChatResponse> => {
        seenSystemPrompts.push(req.messages[0]!.content);
        return {
          content: JSON.stringify([{ index: 1, text: "这是一段被错误标记为 zh-CN 的简体中文字幕" }]),
          model: "test",
          finishReason: "stop",
        };
      },
    };

    const result = await runSubtitlePipeline({
      videoDir: root,
      subtitle: {
        mode: "srt",
        sourceLang: "en",
        targetLang: "zh-CN",
        source: "youtube",
      },
      llm,
      llmModel: "test",
      runner: {
        run: async (spec) => ({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 0,
          command: spec.command,
          args: spec.args ?? [],
        }),
      },
    });

    await expect(readFile(path.join(root, "video", "full.zh.srt"), "utf8")).resolves.toContain(
      "这是一段被错误标记为 zh-CN 的简体中文字幕",
    );
    expect(result.manifest.source_language).toBe("zh-CN");
    // opencc-js detected Traditional Chinese content → forced translation
    expect(result.manifest.translation_method).toBe("llm");
    expect(result.manifest.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Traditional Chinese"),
      ]),
    );
  });

  it("regenerates full.zh.srt instead of reusing it when force is set", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-pipeline-force-"));
    await mkdir(path.join(root, "video"), { recursive: true });
    await writeFile(path.join(root, "Demo.video123.en.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHello\n", "utf8");
    await writeFile(path.join(root, "video", "full.zh.srt"), "1\n00:00:01,000 --> 00:00:02,000\nstale subtitle\n", "utf8");

    await runSubtitlePipeline({
      videoDir: root,
      subtitle: { mode: "srt", sourceLang: "en", targetLang: "zh-CN", source: "youtube" },
      llm: {
        chat: async (): Promise<ChatResponse> => ({
          content: JSON.stringify([{ index: 1, text: "你好" }]),
          model: "test",
          finishReason: "stop",
        }),
      },
      llmModel: "test",
      force: true,
      runner: {
        run: async (spec) => ({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 0,
          command: spec.command,
          args: spec.args ?? [],
        }),
      },
    });

    await expect(readFile(path.join(root, "video", "full.zh.srt"), "utf8")).resolves.toContain("你好");
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

describe("detectSubtitleLanguage", () => {
  it("detects Chinese from CJK-dominant content", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
本周，Anthropic 发布了 Opus 4.8 模型

2
00:00:03,000 --> 00:00:06,000
他们称这是世界上最先进的人工智能模型
`;
    expect(detectSubtitleLanguage(srt)).toBe("zh");
  });

  it("detects English from Latin-dominant content", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
This Week Anthropic Released Opus 4.8

2
00:00:03,000 --> 00:00:06,000
which they say is the most advanced AI model
`;
    expect(detectSubtitleLanguage(srt)).toBe("en");
  });

  it("returns undefined for content without enough text", () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
  - -
`;
    expect(detectSubtitleLanguage(srt)).toBeUndefined();
  });

  it("detects Chinese even with mixed English technical terms", () => {
    // Common scenario: Chinese subtitles with English AI/product names
    const srt = `1
00:00:01,000 --> 00:00:05,000
本周 OpenAI 发布了 Codex 超级应用的重大更新

2
00:00:05,000 --> 00:00:09,000
其中一些更新他们甚至没有在公开场合宣布
`;
    expect(detectSubtitleLanguage(srt)).toBe("zh");
  });

  it("detects English from real-world transcription output", () => {
    // Simulates the actual bug scenario: whisper output labeled as "zh"
    const srt = `1
00:00:00,000 --> 00:00:03,080
This Week and Thropic Released Opus 4.8

2
00:00:03,080 --> 00:00:06,820
which they say is the most advanced AI model in the world

3
00:00:06,820 --> 00:00:11,160
However, others are saying that we've entered the iPhone era of AI models

4
00:00:11,160 --> 00:00:14,600
where you can't even tell the difference between each model upgrade
`;
    expect(detectSubtitleLanguage(srt)).toBe("en");
  });
});
