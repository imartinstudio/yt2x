import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DubScript, DubScriptLine, TtsPort, TtsRequest } from "@yt2x/core";
import { SYNTHESIS_RATE, median, probeAudioDurationMs, synthesizeDubLines } from "./synthesize.js";
import type { ProcessResult, ProcessRunner, ProcessSpec } from "../process/index.js";

const okResult = (spec: ProcessSpec, stdout: string): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 1,
  command: spec.command,
  args: spec.args ?? [],
});

const line = (index: number, targetDurationMs: number, text: string): DubScriptLine => ({
  index,
  startMs: (index - 1) * 10_000,
  endMs: (index - 1) * 10_000 + targetDurationMs,
  targetDurationMs,
  text,
  sourceText: text,
  cueIndices: [index],
});

const scriptOf = (lines: DubScriptLine[]): DubScript => ({
  version: 1,
  videoId: "<videoId>",
  sourceSubtitle: "video/full.zh.srt",
  rewriteModel: "test-model",
  lines,
});

const stubTts = (
  overrides: {
    rate?: number;
    audio?: Uint8Array;
    /** Per-call speech durations (ms). Default 1000 each. speechStart=0 so no trim. */
    speechDurationsMs?: readonly number[];
    omitSpeechTiming?: boolean;
  } = {},
): { tts: TtsPort; requests: TtsRequest[] } => {
  const requests: TtsRequest[] = [];
  const tts: TtsPort = {
    id: "stub-tts",
    rateRange: { min: 0.5, max: 2 },
    synthesize: async (req) => {
      const call = requests.length;
      requests.push(req);
      const speechDurationMs = overrides.speechDurationsMs?.[call] ?? 1_000;
      return {
        audio: overrides.audio ?? new Uint8Array([1, 2, 3, requests.length]),
        format: "mp3",
        voice: req.voice,
        rate: overrides.rate ?? req.rate ?? 1,
        ...(overrides.omitSpeechTiming === true
          ? {}
          : {
              speechTiming: {
                speechStartMs: 0,
                speechEndMs: speechDurationMs,
                speechDurationMs,
              },
            }),
      };
    },
  };
  return { tts, requests };
};

/** durations 按调用顺序返回秒数字符串，模拟 ffprobe 的 csv=p=0 输出。 */
const probeRunner = (durations: readonly string[]): { runner: ProcessRunner; specs: ProcessSpec[] } => {
  const specs: ProcessSpec[] = [];
  const runner: ProcessRunner = {
    run: async (spec) => {
      specs.push(spec);
      return okResult(spec, `${durations[specs.length - 1] ?? "1.0"}\n`);
    },
  };
  return { runner, specs };
};

const tmpDubDir = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "yt2x-dub-"));

describe("median", () => {
  it("returns 0 for an empty list", () => {
    expect(median([])).toBe(0);
  });

  it("takes the middle value for odd counts", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for even counts", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("does not mutate the input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("probeAudioDurationMs", () => {
  it("calls ffprobe with the format=duration csv shape and converts to ms", async () => {
    const { runner, specs } = probeRunner(["2.4567"]);
    const ms = await probeAudioDurationMs({ filePath: "/tmp/a.mp3", runner });
    expect(ms).toBe(2_457);
    expect(specs[0]?.command).toBe("ffprobe");
    expect(specs[0]?.args).toEqual([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      "/tmp/a.mp3",
    ]);
  });

  it("honours a custom ffprobe path", async () => {
    const { runner, specs } = probeRunner(["1.0"]);
    await probeAudioDurationMs({ filePath: "/tmp/a.mp3", runner, ffprobePath: "/opt/bin/ffprobe" });
    expect(specs[0]?.command).toBe("/opt/bin/ffprobe");
  });

  it("throws when ffprobe returns nothing usable", async () => {
    const { runner } = probeRunner(["N/A"]);
    await expect(probeAudioDurationMs({ filePath: "/tmp/a.mp3", runner })).rejects.toThrow(
      /no usable duration/u,
    );
  });

  it("throws on a zero duration", async () => {
    const { runner } = probeRunner(["0.000000"]);
    await expect(probeAudioDurationMs({ filePath: "/tmp/a.mp3", runner })).rejects.toThrow();
  });
});

describe("synthesizeDubLines", () => {
  it("always synthesizes at rate 1.0 so the timing sample stays comparable", async () => {
    const dubDir = await tmpDubDir();
    const { tts, requests } = stubTts();
    const { runner } = probeRunner(["1.0", "1.0"]);

    await synthesizeDubLines({
      tts,
      script: scriptOf([line(1, 2_000, "第一句"), line(2, 2_000, "第二句")]),
      voice: "zh-CN-YunxiNeural",
      dubDir,
      runner,
    });

    expect(SYNTHESIS_RATE).toBe(1);
    expect(requests.map((r) => r.rate)).toEqual([1, 1]);
    expect(requests.every((r) => r.format === "mp3")).toBe(true);
    expect(requests.every((r) => r.voice === "zh-CN-YunxiNeural")).toBe(true);
  });

  it("writes zero-padded per-line audio and records relative paths", async () => {
    const dubDir = await tmpDubDir();
    const { tts } = stubTts();
    const { runner } = probeRunner(["1.0", "1.0"]);

    const { report } = await synthesizeDubLines({
      tts,
      script: scriptOf([line(1, 2_000, "第一句"), line(2, 2_000, "第二句")]),
      voice: "v",
      dubDir,
      runner,
    });

    expect(await readdir(path.join(dubDir, "lines"))).toEqual(["0001.mp3", "0002.mp3"]);
    expect(report.lines.map((l) => l.audioFile)).toEqual(["lines/0001.mp3", "lines/0002.mp3"]);
    expect(new Uint8Array(await readFile(path.join(dubDir, "lines", "0001.mp3")))).toEqual(
      new Uint8Array([1, 2, 3, 1]),
    );
  });

  it("summarizes ratio, overflow count and total drift", async () => {
    const dubDir = await tmpDubDir();
    // 目标 2s/2s/2s，引擎语音 1.0s / 2.0s / 3.0s → ratio 0.5 / 1.0 / 1.5
    const { tts } = stubTts({ speechDurationsMs: [1_000, 2_000, 3_000] });
    const { runner } = probeRunner(["1.0", "2.0", "3.0"]);

    const { report, warnings } = await synthesizeDubLines({
      tts,
      script: scriptOf([line(1, 2_000, "短"), line(2, 2_000, "刚好"), line(3, 2_000, "太长了")]),
      voice: "v",
      dubDir,
      runner,
    });

    expect(warnings).toEqual([]);
    expect(report).toMatchObject({
      version: 1,
      videoId: "<videoId>",
      engine: "stub-tts",
      voice: "v",
      lineCount: 3,
      medianRatio: 1,
      overflowCount: 1,
      totalDriftMs: 0,
    });
    expect(report.lines.map((l) => l.ratio)).toEqual([0.5, 1, 1.5]);
    expect(report.lines.map((l) => l.charCount)).toEqual([1, 2, 3]);
  });

  it("reports positive total drift when the dub runs long", async () => {
    const dubDir = await tmpDubDir();
    const { tts } = stubTts({ speechDurationsMs: [3_000, 3_000] });
    const { runner } = probeRunner(["3.0", "3.0"]);

    const { report } = await synthesizeDubLines({
      tts,
      script: scriptOf([line(1, 2_000, "一"), line(2, 2_000, "二")]),
      voice: "v",
      dubDir,
      runner,
    });

    expect(report.totalDriftMs).toBe(2_000);
    expect(report.overflowCount).toBe(2);
  });

  it("uses engine speechDurationMs rather than whole-file ffprobe duration", async () => {
    const dubDir = await tmpDubDir();
    const tts: TtsPort = {
      id: "stub-tts",
      rateRange: { min: 0.5, max: 2 },
      synthesize: async (req) => ({
        audio: new Uint8Array([1, 2, 3]),
        format: "mp3",
        voice: req.voice,
        rate: 1,
        speechTiming: {
          speechStartMs: 200,
          speechEndMs: 1_200,
          speechDurationMs: 1_000,
        },
      }),
    };
    const { runner, specs } = probeRunner(["1.5", "1.0"]);
    const ffmpegCalls: ProcessSpec[] = [];
    const combined: ProcessRunner = {
      run: async (spec) => {
        if (spec.command === "ffmpeg" || spec.command.endsWith("ffmpeg")) {
          ffmpegCalls.push(spec);
          const args = spec.args ?? [];
          const outPath = args[args.length - 1]!;
          await mkdir(path.dirname(outPath), { recursive: true });
          await writeFile(outPath, new Uint8Array([9, 9, 9]));
          return okResult(spec, "");
        }
        return runner.run(spec);
      },
    };

    const { report } = await synthesizeDubLines({
      tts,
      script: scriptOf([line(1, 2_000, "带 padding")]),
      voice: "v",
      dubDir,
      runner: combined,
    });

    expect(report.lines[0]?.synthesizedMs).toBe(1_000);
    expect(report.lines[0]?.ratio).toBe(0.5);
    expect(specs.length).toBe(2); // cross-check + post-trim measure
    expect(ffmpegCalls.length).toBeGreaterThanOrEqual(1);
    expect(new Uint8Array(await readFile(path.join(dubDir, "lines", "0001.mp3")))).toEqual(
      new Uint8Array([9, 9, 9]),
    );
  });

  it("fails explicitly when TTS returns no speechTiming", async () => {
    const dubDir = await tmpDubDir();
    const { tts } = stubTts({ omitSpeechTiming: true });
    const { runner } = probeRunner(["1.0"]);

    await expect(
      synthesizeDubLines({
        tts,
        script: scriptOf([line(1, 2_000, "无时间戳")]),
        voice: "v",
        dubDir,
        runner,
      }),
    ).rejects.toThrow(/speechTiming/iu);
  });

  it("fails when engine speech end exceeds the audio file duration", async () => {
    const dubDir = await tmpDubDir();
    const tts: TtsPort = {
      id: "stub-tts",
      rateRange: { min: 0.5, max: 2 },
      synthesize: async (req) => ({
        audio: new Uint8Array([1]),
        format: "mp3",
        voice: req.voice,
        rate: 1,
        speechTiming: {
          speechStartMs: 0,
          speechEndMs: 2_000,
          speechDurationMs: 2_000,
        },
      }),
    };
    const { runner } = probeRunner(["1.0"]);

    await expect(
      synthesizeDubLines({
        tts,
        script: scriptOf([line(1, 2_000, "错位")]),
        voice: "v",
        dubDir,
        runner,
      }),
    ).rejects.toThrow(/exceeds audio file duration/iu);
  });

  it("records ratio 0 rather than Infinity for a zero-length target", async () => {
    const dubDir = await tmpDubDir();
    const { tts } = stubTts();
    const { runner } = probeRunner(["1.0"]);

    const { report } = await synthesizeDubLines({
      tts,
      script: scriptOf([line(1, 0, "时间戳异常")]),
      voice: "v",
      dubDir,
      runner,
    });

    expect(report.lines[0]?.ratio).toBe(0);
    expect(Number.isFinite(report.lines[0]?.ratio ?? Number.NaN)).toBe(true);
  });

  it("warns when the engine refuses rate 1.0", async () => {
    const dubDir = await tmpDubDir();
    const { tts } = stubTts({ rate: 1.5 });
    const { runner } = probeRunner(["1.0"]);

    const { warnings } = await synthesizeDubLines({
      tts,
      script: scriptOf([line(1, 2_000, "一")]),
      voice: "v",
      dubDir,
      runner,
    });

    expect(warnings[0]).toContain("engine used rate 1.5");
    expect(warnings[0]).toContain("not comparable");
  });

  it("reports progress per finished line", async () => {
    const dubDir = await tmpDubDir();
    const { tts } = stubTts();
    const { runner } = probeRunner(["1.0", "1.0", "1.0"]);
    const seen: Array<[number, number]> = [];

    await synthesizeDubLines({
      tts,
      script: scriptOf([line(1, 2_000, "一"), line(2, 2_000, "二"), line(3, 2_000, "三")]),
      voice: "v",
      dubDir,
      runner,
      onLineDone: (done, total) => seen.push([done, total]),
    });

    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("produces an empty report for an empty script", async () => {
    const dubDir = await tmpDubDir();
    const { tts } = stubTts();
    const { runner, specs } = probeRunner([]);

    const { report } = await synthesizeDubLines({
      tts,
      script: scriptOf([]),
      voice: "v",
      dubDir,
      runner,
    });

    expect(specs).toHaveLength(0);
    expect(report).toMatchObject({
      lineCount: 0,
      medianRatio: 0,
      overflowCount: 0,
      totalDriftMs: 0,
    });
    expect(report.lines).toEqual([]);
  });

  it("propagates a TTS failure instead of silently skipping the line", async () => {
    const dubDir = await tmpDubDir();
    const failing: TtsPort = {
      id: "stub-tts",
      rateRange: { min: 0.5, max: 2 },
      synthesize: async () => {
        throw new Error("engine down");
      },
    };
    const { runner } = probeRunner(["1.0"]);

    await expect(
      synthesizeDubLines({ tts: failing, script: scriptOf([line(1, 2_000, "一")]), voice: "v", dubDir, runner }),
    ).rejects.toThrow(/engine down/u);
  });
});
