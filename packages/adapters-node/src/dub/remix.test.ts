import { describe, expect, it } from "vitest";
import type { ProcessResult, ProcessRunner, ProcessSpec } from "../process/index.js";
import {
  buildMuxDubbedVideoArgs,
  computeDubbedOutputDurationMs,
  mixVoiceAndBgmFilterComplex,
} from "./remix.js";

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
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
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

    expect(specs).toHaveLength(1);
    const args = specs[0]!.args ?? [];
    expect(args[args.indexOf("-t") + 1]).toBe("125.000");
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("apad=whole_dur=125.000");
    expect(filter.match(/apad=whole_dur=125\.000/g)?.length).toBe(2);
  });
});
