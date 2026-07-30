import { describe, expect, it } from "vitest";
import type { ProcessResult, ProcessRunner, ProcessSpec } from "../process/index.js";
import {
  assertConcatEntriesHomogeneous,
  assertFfmpegStderrClean,
  assertRenderedDurationMs,
  buildMuxDubbedVideoArgs,
  computeDubbedOutputDurationMs,
  DUB_RENDER_DURATION_TOLERANCE_MS,
  mixVoiceAndBgmFilterComplex,
} from "./remix.js";

describe("assertConcatEntriesHomogeneous", () => {
  it("allows an all-wav concat list (scheme C)", () => {
    expect(() =>
      assertConcatEntriesHomogeneous(["/tmp/s0.wav", "/tmp/l1.wav", "/tmp/s1.wav"]),
    ).not.toThrow();
  });

  it("rejects mixed mp3 + wav (the silent-drop bug)", () => {
    expect(() =>
      assertConcatEntriesHomogeneous(["/tmp/s0.wav", "/tmp/lines/0001.mp3", "/tmp/s1.wav"]),
    ).toThrow(/must share one extension/i);
  });
});

describe("assertRenderedDurationMs", () => {
  it("passes within the 50ms tolerance used by the voice-track feedback loop", () => {
    expect(() =>
      assertRenderedDurationMs({
        actualMs: 93_824,
        expectedMs: 93_824 - (DUB_RENDER_DURATION_TOLERANCE_MS - 1),
        label: "voice.wav",
      }),
    ).not.toThrow();
  });

  it("fails when silence was dropped (exact dubSmoke90 gap)", () => {
    expect(() =>
      assertRenderedDurationMs({
        actualMs: 86_160,
        expectedMs: 93_824,
        label: "voice.wav",
      }),
    ).toThrow(/VOICE TRACK LENGTH MISMATCH|duration mismatch/i);
  });
});

describe("assertFfmpegStderrClean", () => {
  it("throws when concat demuxer swallowed bad packets with exit 0", () => {
    expect(() =>
      assertFfmpegStderrClean(
        "[aist#0:0/mp3] Error submitting packet to decoder: Invalid data found when processing input",
      ),
    ).toThrow(/Error submitting packet to decoder/i);
  });

  it("allows clean stderr", () => {
    expect(() => assertFfmpegStderrClean("frame=  10 fps=0.0")).not.toThrow();
  });
});

describe("computeDubbedOutputDurationMs", () => {
  it("keeps the full source video when speech ends early (BGM/credits must survive)", () => {
    // 人声 90s，原片 120s，无漂移 → 成片必须是 120s，不能砍到 90s
    expect(
      computeDubbedOutputDurationMs({ voiceEndMs: 90_000, videoDurationMs: 120_000, extendMs: 0 }),
    ).toBe(120_000);
  });

  it("extends past the source video when residual drift requires a freeze", () => {
    // 决策 #11：冻结末帧延长画面，成片 = 视频长 + extendMs
    expect(
      computeDubbedOutputDurationMs({
        voiceEndMs: 125_000,
        videoDurationMs: 120_000,
        extendMs: 5_000,
      }),
    ).toBe(125_000);
  });

  it("uses the longer of voiceEnd and video+extend", () => {
    expect(
      computeDubbedOutputDurationMs({
        voiceEndMs: 130_000,
        videoDurationMs: 120_000,
        extendMs: 5_000,
      }),
    ).toBe(130_000);
    expect(
      computeDubbedOutputDurationMs({
        voiceEndMs: 100_000,
        videoDurationMs: 120_000,
        extendMs: 5_000,
      }),
    ).toBe(125_000);
  });
});

describe("mixVoiceAndBgmFilterComplex", () => {
  it("pads both voice and BGM to the output duration (not voice-only)", () => {
    const filter = mixVoiceAndBgmFilterComplex(125.0);
    // 人声也必须 apad——否则 amix duration=first 仍以短人声为准
    expect(filter).toMatch(/\[0:a\].*apad=whole_dur=125\.000/);
    expect(filter).toMatch(/\[1:a\].*apad=whole_dur=125\.000/);
    expect(filter).toMatch(/amix=inputs=2:duration=first/);
  });
});

describe("buildMuxDubbedVideoArgs", () => {
  it("pads video with tpad and locks -t to the full output length (never -shortest)", () => {
    const args = buildMuxDubbedVideoArgs({
      videoPath: "/v.mp4",
      audioPath: "/a.m4a",
      outputPath: "/out.mp4",
      videoPadMs: 5_000,
      outputDurationMs: 125_000,
    });
    expect(args.join(" ")).toContain("tpad=stop_mode=clone:stop_duration=5.000");
    expect(args).not.toContain("-shortest");
    expect(args[args.indexOf("-t") + 1]).toBe("125.000");
  });

  it("still avoids -shortest when there is no pad", () => {
    const args = buildMuxDubbedVideoArgs({
      videoPath: "/v.mp4",
      audioPath: "/a.m4a",
      outputPath: "/out.mp4",
      videoPadMs: 0,
      outputDurationMs: 120_000,
    });
    expect(args.join(" ")).not.toContain("tpad=");
    expect(args).not.toContain("-shortest");
    expect(args[args.indexOf("-t") + 1]).toBe("120.000");
  });
});

describe("mixVoiceAndBgm ffmpeg args", () => {
  it("passes -t equal to the output duration, not the voice-only length", async () => {
    const specs: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      run: async (spec): Promise<ProcessResult> => {
        specs.push(spec);
        const isFfprobe = (spec.command === "ffprobe" || spec.command.endsWith("ffprobe"));
        return {
          exitCode: 0,
          signal: null,
          stdout: isFfprobe ? "125.000" : "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 1,
          command: spec.command,
          args: spec.args ?? [],
        };
      },
    };

    const { mixVoiceAndBgm } = await import("./remix.js");
    await mixVoiceAndBgm({
      voicePath: "/voice.wav",
      noVocalsPath: "/bgm.wav",
      outputPath: "/mixed.m4a",
      durationMs: 125_000,
      runner,
      ffmpegPath: "ffmpeg",
    });

    const ffmpegSpecs = specs.filter((s) => s.command === "ffmpeg");
    expect(ffmpegSpecs).toHaveLength(1);
    const args = ffmpegSpecs[0]!.args ?? [];
    expect(args[args.indexOf("-t") + 1]).toBe("125.000");
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("apad=whole_dur=125.000");
    expect(filter.match(/apad=whole_dur=125\.000/g)?.length).toBe(2);
  });
});
