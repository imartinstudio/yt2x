import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import type { ProcessRunner } from "../process/index.js";

vi.mock("./burn-zh-subtitles-for-video.js", () => ({
  burnZhSubtitlesForVideo: vi.fn().mockResolvedValue({
    burned: true,
    skipped: false,
  }),
}));

vi.mock("./resolve-python.js", () => ({
  resolvePythonWithPillow: vi.fn().mockResolvedValue("python3"),
  resolvePythonWithTorchaudio: vi.fn().mockResolvedValue(undefined),
  resolvePythonWithFasterWhisper: vi.fn().mockResolvedValue(undefined),
}));

import {
  cleanupSrt,
  convertSubtitleTextToSrt,
  detectSubtitleLanguage,
  parseSubtitleBlocks,
  prepareSourceSubtitle,
  runSubtitlePipeline,
  transcribeLocal,
} from "./video-subtitles.js";
import { burnZhSubtitlesForVideo } from "./burn-zh-subtitles-for-video.js";
import { resolvePythonWithFasterWhisper, resolvePythonWithTorchaudio } from "./resolve-python.js";

/** Shared runner helper: satisfies burn-bilingual-subtitles.ts's --measure calls with a trivial "fit" verdict. */
const writeMeasureOutputIfRequested = async (spec: {
  args?: readonly string[];
}): Promise<void> => {
  if (!spec.args?.includes("--measure")) return;
  const outputIndex = spec.args.indexOf("--output");
  const output = spec.args[outputIndex + 1];
  const srtPath = spec.args.find((a) => a.endsWith(".srt")) ?? "";
  let blockCount = 1;
  try {
    const srtContent = await readFile(srtPath, "utf8");
    blockCount = srtContent.split("\n\n").filter((b) => b.trim().length > 0).length || 1;
  } catch { /* keep default */ }
  await writeFile(output!, JSON.stringify(
    Array.from({ length: blockCount }, (_, i) => ({
      cueIndex: i + 1,
      zhWidth: 200,
      fitWidth: 1024,
      lineCount: 1,
      severity: "fit" as const,
      resolvedFonts: { zh: "PingFang", en: "Lexend Deca" },
    })),
  ));
};

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

  it("uses the requested source language when both English and Chinese YouTube subtitles exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-source-language-"));
    await writeFile(
      path.join(root, "Demo.video123.en.vtt"),
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEnglish source\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "Demo.video123.zh-CN.vtt"),
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n中文字幕\n",
      "utf8",
    );

    const result = await prepareSourceSubtitle({
      videoDir: root,
      sourceLang: "en",
      targetLang: "zh-CN",
      source: "youtube",
      preferSourceLanguage: true,
    });

    expect(result.manifest.source_language).toBe("en");
    await expect(readFile(path.join(root, "video", "full.en.srt"), "utf8")).resolves.toContain("English source");
  });

  it("does not substitute Chinese subtitles for a missing bilingual source language", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-bilingual-source-missing-"));
    await writeFile(
      path.join(root, "Demo.video123.zh-CN.vtt"),
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n中文字幕\n",
      "utf8",
    );

    const result = await prepareSourceSubtitle({
      videoDir: root,
      sourceLang: "en",
      targetLang: "zh-CN",
      source: "youtube",
      preferSourceLanguage: true,
    });

    expect(result.sourceSubtitle).toBeUndefined();
    expect(result.manifest.warnings).toEqual(["no YouTube subtitle file found (tried: en)"]);
  });

  it("falls back to local transcription when auto cannot find the bilingual source language", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-auto-transcribe-"));
    await mkdir(path.join(root, "video"), { recursive: true });
    await writeFile(path.join(root, "video", "full.mp4"), "fake video");

    const result = await prepareSourceSubtitle({
      videoDir: root,
      sourceLang: "en",
      targetLang: "zh-CN",
      source: "auto",
      preferSourceLanguage: true,
      runner: {
        run: async (spec) => {
          if (spec.command === "whisper-cli") {
            const outputIndex = spec.args!.indexOf("-of");
            await writeFile(`${spec.args![outputIndex + 1]}.srt`, "1\n00:00:00,000 --> 00:00:01,000\nEnglish source\n");
          }
          return { exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 0, command: spec.command, args: spec.args ?? [] };
        },
      },
    });

    expect(result.manifest.source_method).toBe("local_transcription");
    await expect(readFile(path.join(root, "video", "full.en.srt"), "utf8")).resolves.toContain("English source");
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
  it("fails bilingual delivery without a downloaded source subtitle and leaves downloads unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-strict-missing-source-"));
    const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-strict-article-"));
    await mkdir(path.join(root, "video"), { recursive: true });
    await writeFile(path.join(root, "video", "full.mp4"), "source video", "utf8");
    const commands: string[] = [];
    const runner: ProcessRunner = {
      run: async (spec) => {
        commands.push(spec.command);
        if (spec.command === "whisper-cli") {
          const outputIndex = spec.args!.indexOf("-of");
          await writeFile(
            `${spec.args![outputIndex + 1]}.srt`,
            "1\n00:00:00,000 --> 00:00:01,000\nEnglish source\n",
            "utf8",
          );
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
    };

    await expect(
      runSubtitlePipeline({
        videoDir: root,
        subtitle: {
          mode: "srt",
          sourceLang: "en",
          targetLang: "zh-CN",
          source: "auto",
        },
        subtitleBilingual: "all",
        llm: {
          chat: async () => ({
            content: JSON.stringify([{ index: 1, text: "中文翻译" }]),
            model: "test",
            finishReason: "stop",
          }),
        },
        llmModel: "test",
        burnedVideoOutDir: articleRoot,
        runner,
      }),
    ).rejects.toThrow(/downloaded source subtitle.*required/iu);

    expect(commands).toEqual([]);
    await expect(readdir(path.join(root, "video"))).resolves.toEqual(["full.mp4"]);
  });

  it("reads an auto-discovered source without changing the downloads tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-semantic-source-"));
    const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-semantic-article-"));
    const sourceSrt = path.join(root, "source.en.srt");
    const originalSource = `1
00:00:00,000 --> 00:00:01,500
First sentence.

2
00:00:01,500 --> 00:00:03,000
Second sentence.
`;
    await mkdir(path.join(root, "video"), { recursive: true });
    await writeFile(sourceSrt, originalSource);
    // 3-phase pipeline: repunct → translate → split.
    const llm: LlmPort = {
      chat: vi.fn(async (request: ChatRequest) => {
        const userContent = request.messages[1]!.content as string;

        // Phase 0 repunct: JSON array request → return punctuated cues
        if (request.jsonMode === true && userContent.startsWith("[")) {
          const inputCues = JSON.parse(userContent) as string[];
          return {
            content: JSON.stringify({ cues: inputCues.map((t) => `${t}.`) }),
            model: "test",
            finishReason: "stop",
          };
        }

        // Phase 1 translate: sentence text → return Chinese
        const lc = userContent.toLowerCase();
        if (lc.includes("first sentence")) return { content: "第一句。", model: "test", finishReason: "stop" };
        return { content: "第二句。", model: "test", finishReason: "stop" };
      }),
    };

    const runner: ProcessRunner = {
      run: async (spec) => {
        if (spec.args?.includes("--measure")) {
          const outputIndex = spec.args?.indexOf("--output") ?? -1;
          const output = spec.args?.[outputIndex + 1];
          // Read the SRT file to determine how many cues to produce measurements for.
          const srtPath = spec.args?.find((a) => a.endsWith(".srt")) ?? "";
          let blockCount = 1;
          try {
            const srtContent = await readFile(srtPath, "utf8");
            blockCount = srtContent.split("\n\n").filter((b) => b.trim().length > 0).length;
          } catch { /* keep default */ }
          await writeFile(output!, JSON.stringify(
            Array.from({ length: blockCount }, (_, i) => ({
              cueIndex: i + 1,
              zhWidth: 200,
              fitWidth: 1024,
              lineCount: 1,
              severity: "fit" as const,
              resolvedFonts: { zh: "PingFang", en: "Lexend Deca" },
            })),
          ));
        }
        return {
          exitCode: 0, signal: null, stdout: "", stderr: "",
          stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
          command: spec.command, args: spec.args ?? [],
        };
      },
    };
    const pipelineOptions = {
      videoDir: root,
      subtitle: {
        mode: "srt" as const,
        sourceLang: "en",
        targetLang: "zh-CN",
        source: "auto" as const,
      },
      subtitleBilingual: "srt" as const,
      llm,
      llmModel: "test",
      burnedVideoOutDir: articleRoot,
      runner,
    };
    const result = await runSubtitlePipeline(pipelineOptions);

    const articleVideoDir = path.join(articleRoot, path.basename(root), "video");
    await expect(readFile(sourceSrt, "utf8")).resolves.toBe(originalSource);
    await expect(readFile(path.join(articleVideoDir, "full.en.srt"), "utf8"))
      .resolves.toContain("First sentence.");
    await expect(readFile(path.join(articleVideoDir, "full.zh.srt"), "utf8"))
      .resolves.toContain("第一句");
    await expect(readFile(path.join(articleVideoDir, "full.bilingual.srt"), "utf8"))
      .resolves.toContain("第一句。");
    const readyManifest = JSON.parse(
      await readFile(path.join(articleVideoDir, "full.bilingual.semantic.json"), "utf8"),
    ) as { kind: string; status: string; stages: Record<string, string> };
    expect(readyManifest).toMatchObject({
      kind: "semantic-bilingual",
      status: "ready",
      stages: {
        translation: "done",
        alignment: "done",
        segmentation: "done",
        layout: "done",
      },
    });
    await expect(readdir(root)).resolves.toEqual(["source.en.srt", "video"]);
    await expect(readdir(path.join(root, "video"))).resolves.toEqual([]);
    expect(result.manifest.bilingual_subtitle).toBe("video/full.bilingual.srt");

    await runSubtitlePipeline(pipelineOptions);
    // Second run hits cache → no new LLM calls. Total stays at 3.
    expect(llm.chat).toHaveBeenCalledTimes(3);
  });

  it("never probes for torchaudio when enableForcedAlignment is not set", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-align-off-"));
    const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-align-off-article-"));
    await mkdir(path.join(root, "video"), { recursive: true });
    await writeFile(
      path.join(root, "source.en.srt"),
      "1\n00:00:00,000 --> 00:00:02,000\nOne sentence here.\n",
    );
    vi.mocked(resolvePythonWithTorchaudio).mockClear();

    await runSubtitlePipeline({
      videoDir: root,
      subtitle: { mode: "srt", sourceLang: "en", targetLang: "zh-CN", source: "auto" },
      subtitleBilingual: "srt",
      llm: {
        chat: async (request: ChatRequest) =>
          request.jsonMode === true
            ? { content: JSON.stringify({ cues: [] }), model: "test", finishReason: "stop" }
            : { content: "翻译。", model: "test", finishReason: "stop" },
      },
      llmModel: "test",
      burnedVideoOutDir: articleRoot,
      runner: {
        run: async (spec) => {
          await writeMeasureOutputIfRequested(spec);
          return {
            exitCode: 0, signal: null, stdout: "", stderr: "",
            stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
            command: spec.command, args: spec.args ?? [],
          };
        },
      },
    });

    expect(resolvePythonWithTorchaudio).not.toHaveBeenCalled();
  });

  it("skips forced alignment gracefully when torchaudio isn't found, even with the flag on", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-align-missing-"));
    const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-align-missing-article-"));
    await mkdir(path.join(root, "video"), { recursive: true });
    await writeFile(
      path.join(root, "source.en.srt"),
      "1\n00:00:00,000 --> 00:00:02,000\nOne sentence here.\n",
    );
    vi.mocked(resolvePythonWithTorchaudio).mockResolvedValueOnce(undefined);

    const result = await runSubtitlePipeline({
      videoDir: root,
      subtitle: { mode: "srt", sourceLang: "en", targetLang: "zh-CN", source: "auto" },
      subtitleBilingual: "srt",
      enableForcedAlignment: true,
      llm: {
        chat: async (request: ChatRequest) =>
          request.jsonMode === true
            ? { content: JSON.stringify({ cues: [] }), model: "test", finishReason: "stop" }
            : { content: "翻译。", model: "test", finishReason: "stop" },
      },
      llmModel: "test",
      burnedVideoOutDir: articleRoot,
      runner: {
        run: async (spec) => {
          await writeMeasureOutputIfRequested(spec);
          return {
            exitCode: 0, signal: null, stdout: "", stderr: "",
            stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
            command: spec.command, args: spec.args ?? [],
          };
        },
      },
    });

    expect(resolvePythonWithTorchaudio).toHaveBeenCalled();
    expect(result.manifest.bilingual_subtitle).toBe("video/full.bilingual.srt");
  });

  it("runs ffmpeg audio extraction and the forced-align script when the flag is on and torchaudio is found", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-align-on-"));
    const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-align-on-article-"));
    await mkdir(path.join(root, "video"), { recursive: true });
    await writeFile(path.join(root, "video", "full.mp4"), "fake video bytes");
    await writeFile(
      path.join(root, "source.en.srt"),
      "1\n00:00:00,000 --> 00:00:02,000\nOne sentence here.\n",
    );
    vi.mocked(resolvePythonWithTorchaudio).mockResolvedValueOnce("python3");

    const commandsRun: string[] = [];
    const runner: ProcessRunner = {
      run: async (spec) => {
        commandsRun.push(spec.command);
        if (spec.args?.some((a) => a.endsWith("forced-align.py"))) {
          const outputIndex = spec.args.indexOf("--output");
          await writeFile(
            spec.args[outputIndex + 1]!,
            JSON.stringify([
              { word: "one", start: 0.0, end: 0.5 },
              { word: "sentence", start: 0.5, end: 1.2 },
              { word: "here", start: 1.2, end: 1.8 },
            ]),
          );
        }
        await writeMeasureOutputIfRequested(spec);
        return {
          exitCode: 0, signal: null, stdout: "", stderr: "",
          stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
          command: spec.command, args: spec.args ?? [],
        };
      },
    };

    const result = await runSubtitlePipeline({
      videoDir: root,
      subtitle: { mode: "srt", sourceLang: "en", targetLang: "zh-CN", source: "auto" },
      subtitleBilingual: "srt",
      enableForcedAlignment: true,
      llm: {
        chat: async (request: ChatRequest) =>
          request.jsonMode === true
            ? { content: JSON.stringify({ cues: [] }), model: "test", finishReason: "stop" }
            : { content: "翻译。", model: "test", finishReason: "stop" },
      },
      llmModel: "test",
      burnedVideoOutDir: articleRoot,
      runner,
    });

    expect(commandsRun).toContain("ffmpeg");
    expect(commandsRun).toContain("python3");
    expect(result.manifest.bilingual_subtitle).toBe("video/full.bilingual.srt");
  });

  describe("transcribeLocal", () => {
    it("returns undefined when faster-whisper isn't found, without touching disk", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-local-missing-"));
      await mkdir(path.join(root, "video"), { recursive: true });
      await writeFile(path.join(root, "video", "full.mp4"), "fake video bytes");
      vi.mocked(resolvePythonWithFasterWhisper).mockResolvedValueOnce(undefined);

      const result = await transcribeLocal({
        videoDir: root,
        language: "en",
        runner: { run: async () => { throw new Error("must not be called"); } },
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined when no downloaded video is found", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-local-novideo-"));
      await mkdir(path.join(root, "video"), { recursive: true });
      vi.mocked(resolvePythonWithFasterWhisper).mockResolvedValueOnce("python3");

      const result = await transcribeLocal({
        videoDir: root,
        language: "en",
        runner: { run: async () => { throw new Error("must not be called"); } },
      });

      expect(result).toBeUndefined();
    });

    it("writes full.local.<lang>.srt and .words.json next to (not over) the existing source", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-local-ok-"));
      await mkdir(path.join(root, "video"), { recursive: true });
      await writeFile(path.join(root, "video", "full.mp4"), "fake video bytes");
      await writeFile(
        path.join(root, "video", "full.en.srt"),
        "1\n00:00:00,000 --> 00:00:02,000\nExisting YouTube caption.\n",
      );
      vi.mocked(resolvePythonWithFasterWhisper).mockResolvedValueOnce("python3");

      const commandsRun: string[] = [];
      const result = await transcribeLocal({
        videoDir: root,
        language: "en",
        runner: {
          run: async (spec) => {
            commandsRun.push(spec.command);
            if (spec.args?.some((a) => a.endsWith("transcribe-local.py"))) {
              const srtOut = spec.args[spec.args.indexOf("--srt-output") + 1]!;
              const wordsOut = spec.args[spec.args.indexOf("--words-output") + 1]!;
              await writeFile(
                srtOut,
                "1\n00:00:00,000 --> 00:00:03,000\nNaturally segmented sentence.\n",
              );
              await writeFile(
                wordsOut,
                JSON.stringify([{ word: "Naturally", start: 0, end: 0.5 }]),
              );
            }
            return {
              exitCode: 0, signal: null, stdout: "", stderr: "",
              stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
              command: spec.command, args: spec.args ?? [],
            };
          },
        },
      });

      expect(commandsRun).toContain("ffmpeg");
      expect(commandsRun).toContain("python3");
      expect(result?.cueCount).toBe(1);
      expect(result?.srtPath).toBe(path.join(root, "video", "full.local.en.srt"));
      // The pre-existing YouTube-caption source is untouched.
      await expect(readFile(path.join(root, "video", "full.en.srt"), "utf8")).resolves.toContain(
        "Existing YouTube caption.",
      );
      await expect(readFile(result!.srtPath, "utf8")).resolves.toContain(
        "Naturally segmented sentence.",
      );
    });

    it("throws when the transcription script exits non-zero", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-local-fail-"));
      await mkdir(path.join(root, "video"), { recursive: true });
      await writeFile(path.join(root, "video", "full.mp4"), "fake video bytes");
      vi.mocked(resolvePythonWithFasterWhisper).mockResolvedValueOnce("python3");

      await expect(
        transcribeLocal({
          videoDir: root,
          language: "en",
          runner: {
            run: async (spec) => ({
              exitCode: spec.command === "python3" ? 1 : 0,
              signal: null, stdout: "", stderr: "model failed to load",
              stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
              command: spec.command, args: spec.args ?? [],
            }),
          },
        }),
      ).rejects.toThrow(/local transcription failed/);
    });
  });

  describe("--subtitle-source local", () => {
    it("reads full.local.<lang>.srt and never falls back to the YouTube-caption source", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-source-local-"));
      const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-source-local-article-"));
      await mkdir(path.join(root, "video"), { recursive: true });
      await writeFile(
        path.join(root, "video", "full.en.srt"),
        "1\n00:00:00,000 --> 00:00:02,000\nYouTube caption text.\n",
      );
      await writeFile(
        path.join(root, "video", "full.local.en.srt"),
        "1\n00:00:00,000 --> 00:00:02,000\nLocal transcription text.\n",
      );

      let seenSourceText = "";
      const result = await runSubtitlePipeline({
        videoDir: root,
        subtitle: { mode: "srt", sourceLang: "en", targetLang: "zh-CN", source: "local" },
        subtitleBilingual: "srt",
        llm: {
          chat: async (request: ChatRequest) => {
            if (request.jsonMode === true) {
              const userContent = request.messages[1]!.content as string;
              seenSourceText += userContent;
              return { content: JSON.stringify({ cues: [] }), model: "test", finishReason: "stop" };
            }
            return { content: "翻译。", model: "test", finishReason: "stop" };
          },
        },
        llmModel: "test",
        burnedVideoOutDir: articleRoot,
        runner: {
          run: async (spec) => {
            await writeMeasureOutputIfRequested(spec);
            return {
              exitCode: 0, signal: null, stdout: "", stderr: "",
              stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
              command: spec.command, args: spec.args ?? [],
            };
          },
        },
      });

      expect(seenSourceText).toContain("Local");
      expect(seenSourceText).not.toContain("YouTube");
      expect(result.manifest.bilingual_subtitle).toBe("video/full.bilingual.srt");
    });

    it("loads word timings from the local .words.json sidecar instead of probing torchaudio", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-source-local-words-"));
      const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-source-local-words-article-"));
      await mkdir(path.join(root, "video"), { recursive: true });
      await writeFile(
        path.join(root, "video", "full.local.en.srt"),
        "1\n00:00:00,000 --> 00:00:03,000\nOne sentence here.\n",
      );
      await writeFile(
        path.join(root, "video", "full.local.en.words.json"),
        JSON.stringify([
          { word: "One", start: 0.0, end: 0.5 },
          { word: "sentence", start: 0.5, end: 1.2 },
          { word: "here.", start: 1.2, end: 1.8 },
        ]),
      );
      vi.mocked(resolvePythonWithTorchaudio).mockClear();

      const result = await runSubtitlePipeline({
        videoDir: root,
        subtitle: { mode: "srt", sourceLang: "en", targetLang: "zh-CN", source: "local" },
        subtitleBilingual: "srt",
        llm: {
          chat: async (request: ChatRequest) =>
            request.jsonMode === true
              ? { content: JSON.stringify({ cues: [] }), model: "test", finishReason: "stop" }
              : { content: "翻译。", model: "test", finishReason: "stop" },
        },
        llmModel: "test",
        burnedVideoOutDir: articleRoot,
        runner: {
          run: async (spec) => {
            await writeMeasureOutputIfRequested(spec);
            return {
              exitCode: 0, signal: null, stdout: "", stderr: "",
              stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
              command: spec.command, args: spec.args ?? [],
            };
          },
        },
      });

      expect(resolvePythonWithTorchaudio).not.toHaveBeenCalled();
      expect(result.manifest.bilingual_subtitle).toBe("video/full.bilingual.srt");
    });

    it("does not pick up a coexisting full.local.<lang>.srt when source is auto", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-source-auto-ignores-local-"));
      const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-source-auto-ignores-local-article-"));
      await mkdir(path.join(root, "video"), { recursive: true });
      await writeFile(
        path.join(root, "video", "full.en.srt"),
        "1\n00:00:00,000 --> 00:00:02,000\nYouTube caption text.\n",
      );
      await writeFile(
        path.join(root, "video", "full.local.en.srt"),
        "1\n00:00:00,000 --> 00:00:02,000\nLocal transcription text.\n",
      );

      // What matters here is which file `findReadOnlyBilingualSource` picks —
      // decided in Phase 0, before the (unrelated) quality gate runs — so a
      // gate-blocked delivery for this minimal fixture doesn't invalidate
      // the assertion below; only a wrong-source read would.
      let seenSourceText = "";
      await runSubtitlePipeline({
        videoDir: root,
        subtitle: { mode: "srt", sourceLang: "en", targetLang: "zh-CN", source: "auto" },
        subtitleBilingual: "srt",
        llm: {
          chat: async (request: ChatRequest) => {
            if (request.jsonMode === true) {
              const userContent = request.messages[1]!.content as string;
              seenSourceText += userContent;
              return { content: JSON.stringify({ cues: [] }), model: "test", finishReason: "stop" };
            }
            return { content: "翻译。", model: "test", finishReason: "stop" };
          },
        },
        llmModel: "test",
        burnedVideoOutDir: articleRoot,
        runner: {
          run: async (spec) => {
            await writeMeasureOutputIfRequested(spec);
            return {
              exitCode: 0, signal: null, stdout: "", stderr: "",
              stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
              command: spec.command, args: spec.args ?? [],
            };
          },
        },
      }).catch(() => {});

      expect(seenSourceText).toContain("YouTube");
      expect(seenSourceText).not.toContain("Local");
    });
  });

  it("records a failed semantic manifest when the repunct LLM response is invalid JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-strict-invalid-semantic-"));
    const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-strict-invalid-article-"));
    await mkdir(path.join(root, "video"), { recursive: true });
    await writeFile(
      path.join(root, "source.en.srt"),
      [
        "1\n00:00:00,000 --> 00:00:02,000\nFirst cue here",
        "2\n00:00:02,000 --> 00:00:04,000\nSecond cue here",
      ].join("\n\n") + "\n",
      "utf8",
    );
    await writeFile(path.join(root, "video", "full.mp4"), "source video", "utf8");
    const articleVideoDir = path.join(articleRoot, path.basename(root), "video");

    await expect(
      runSubtitlePipeline({
        videoDir: root,
        subtitle: {
          mode: "srt",
          sourceLang: "en",
          targetLang: "zh-CN",
          source: "auto",
        },
        subtitleBilingual: "all",
        llm: {
          // Phase 0 repunct: jsonMode request with no "cues" array → invalid-json.
          chat: async () => ({ content: "{}", model: "test", finishReason: "stop" }),
        },
        llmModel: "test",
        burnedVideoOutDir: articleRoot,
        runner: {
          run: async (spec) => ({
            exitCode: 0, signal: null, stdout: "", stderr: "",
            stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
            command: spec.command, args: spec.args ?? [],
          }),
        },
      }),
    ).rejects.toThrow(/repunct: invalid response/iu);

    const manifest = JSON.parse(
      await readFile(path.join(articleVideoDir, "full.bilingual.semantic.json"), "utf8"),
    ) as { kind: string; status: string; error?: { code?: string } };
    expect(manifest).toMatchObject({
      kind: "semantic-bilingual",
      status: "failed",
      error: { code: "invalid-json" },
    });
  });

  it("blocks burned delivery when a hard cue has no safe internal timing boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-strict-hard-layout-"));
    const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-strict-hard-article-"));
    await mkdir(path.join(root, "video"), { recursive: true });
    await writeFile(
      path.join(root, "source.en.srt"),
      "1\n00:00:00,000 --> 00:00:02,000\nOne source cue without a safe internal timing boundary.\n",
      "utf8",
    );
    const articleVideoDir = path.join(articleRoot, path.basename(root), "video");

    await expect(runSubtitlePipeline({
      videoDir: root,
      subtitle: {
        mode: "srt",
        sourceLang: "en",
        targetLang: "zh-CN",
        source: "auto",
      },
      subtitleBilingual: "burned",
      llm: {
        chat: async (request: ChatRequest) => {
          const userContent = request.messages[1]!.content as string;
          if (request.jsonMode === true && userContent.startsWith("[")) {
            const inputCues = JSON.parse(userContent) as string[];
            return {
              content: JSON.stringify({ cues: inputCues.map((t) => `${t}.`) }),
              model: "test",
              finishReason: "stop",
            };
          }
          return { content: "无法安全拆分的长句因为只有一个源字幕", model: "test", finishReason: "stop" };
        },
      },
      llmModel: "test",
      burnedVideoOutDir: articleRoot,
      runner: {
        run: async (spec) => {
          if (spec.args?.includes("--measure")) {
            const outputIndex = spec.args.indexOf("--output");
            const srtPath = spec.args.find((a) => a.endsWith(".srt")) ?? "";
            const srtContent = await readFile(srtPath, "utf8").catch(() => "");
            const blockCount = srtContent.split("\n\n").filter((b) => b.trim().length > 0).length || 1;
            await writeFile(spec.args[outputIndex + 1]!, JSON.stringify(
              Array.from({ length: blockCount }, (_, i) => ({
                cueIndex: i + 1,
                zhWidth: 1600,
                fitWidth: 1024,
                lineCount: 3,
                severity: "hard" as const,
                resolvedFonts: { zh: "PingFang SC", en: "Lexend Deca" },
              })),
            ));
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
    })).rejects.toThrow(/quality gate/iu);

    const manifest = JSON.parse(
      await readFile(path.join(articleVideoDir, "full.bilingual.semantic.json"), "utf8"),
    ) as { status: string; stages: { layout: string }; quality: { readyForBurn: boolean } };
    expect(manifest).toMatchObject({
      status: "failed",
      stages: { layout: "failed" },
      quality: { readyForBurn: false },
    });
    await expect(readFile(path.join(articleVideoDir, "full.bilingual.srt"), "utf8"))
      .resolves.toContain("无法安全拆分的长句因为只有一个源字幕");
  });

  it("uses the article Chinese SRT for a direct burned-subtitle run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-pipeline-article-burn-"));
    const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-sub-pipeline-article-out-"));
    const sourceSrt = path.join(root, "source.srt");
    const articleSrt = path.join(articleRoot, path.basename(root), "video", "full.zh.srt");
    await mkdir(path.join(root, "video"), { recursive: true });
    await mkdir(path.dirname(articleSrt), { recursive: true });
    await writeFile(path.join(root, "video", "full.mp4"), "fake video");
    await writeFile(sourceSrt, "1\n00:00:00,000 --> 00:00:01,000\n下载目录字幕\n");
    await writeFile(articleSrt, "1\n00:00:00,000 --> 00:00:01,000\n文章目录字幕\n");
    vi.mocked(burnZhSubtitlesForVideo).mockClear();

    await runSubtitlePipeline({
      videoDir: root,
      subtitle: { mode: "burned", sourceLang: "zh-CN", targetLang: "zh-CN", source: "file", file: sourceSrt },
      llm: { chat: async () => ({ content: "", model: "test", finishReason: "stop" }) },
      llmModel: "test",
      runner: { run: async (spec) => ({ exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 0, command: spec.command, args: spec.args ?? [] }) },
      burnedVideoOutDir: articleRoot,
      skipBurnIfChineseBurned: false,
    });

    expect(burnZhSubtitlesForVideo).toHaveBeenCalledWith(expect.objectContaining({
      srtPath: articleSrt,
    }));
  });

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
