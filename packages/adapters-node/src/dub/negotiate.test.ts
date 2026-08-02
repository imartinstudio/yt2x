import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DubNegotiatePlan, TtsPort, TtsResult } from "@yt2x/core";
import type { ProcessResult, ProcessRunner, ProcessSpec } from "../process/index.js";
import { applyDubNegotiation } from "./negotiate.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const makeTmp = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "yt2x-dub-neg-"));
  tmpDirs.push(dir);
  return dir;
};

const okResult = (spec: ProcessSpec, stdout = "1.000\n"): ProcessResult => ({
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

const fakeTts = (durationByRate: Record<string, number> = { "1": 1000 }): TtsPort => ({
  id: "fake",
  rateRange: { min: 0.5, max: 2.0 },
  synthesize: async (req): Promise<TtsResult> => {
    const rate = req.rate ?? 1;
    const key = String(rate);
    const durationMs = durationByRate[key] ?? Math.round(1000 / rate);
    return {
      audio: new Uint8Array([1, 2, 3]),
      format: "mp3",
      durationMs,
      voice: req.voice,
      rate,
      speechTiming: {
        speechStartMs: 0,
        speechEndMs: durationMs,
        speechDurationMs: durationMs,
      },
    };
  },
});

const probeRunner = (durationSec: string): ProcessRunner => ({
  run: async (spec) => okResult(spec, `${durationSec}\n`),
});

const planFixture = (overrides?: Partial<DubNegotiatePlan["lines"][number]>): DubNegotiatePlan => ({
  version: 3,
  videoId: "vid",
  extendMs: 0,
  plannedDriftMs: 0,
  keepCount: 1,
  speedCount: 0,
  stretchCount: 0,
  delayCount: 0,
  lines: [
    {
      index: 1,
      action: "keep",
      rate: 1,
      originalStartMs: 0,
      originalEndMs: 1000,
      targetDurationMs: 1000,
      naturalMs: 900,
      plannedStartMs: 0,
      plannedEndMs: 900,
      text: "你好世界",
      ...overrides,
    },
  ],
});

describe("applyDubNegotiation", () => {
  it("reuses existing audio for keep lines", async () => {
    const dubDir = await makeTmp();
    const existing = new Map([[1, "lines/0001.mp3"]]);
    const { report } = await applyDubNegotiation({
      plan: planFixture(),
      tts: fakeTts(),
      voice: "v",
      dubDir,
      existingAudioByIndex: existing,
      runner: probeRunner("0.9"),
    });
    expect(report.keepCount).toBe(1);
    expect(report.lines[0]).toMatchObject({
      action: "keep",
      startMs: 0,
      endMs: 900,
      audioFile: "lines/0001.mp3",
    });
  });

  it("re-synthesizes speed lines and records the new audio", async () => {
    const dubDir = await makeTmp();
    const { report } = await applyDubNegotiation({
      plan: planFixture({ action: "speed", rate: 1.1, naturalMs: 1100, plannedEndMs: 1000 }),
      tts: fakeTts({ "1.1": 1000 }),
      voice: "v",
      dubDir,
      existingAudioByIndex: new Map(),
      runner: probeRunner("1.0"),
    });
    expect(report.speedCount).toBe(1);
    expect(report.lines[0]!.audioFile).toBe("lines/0001.mp3");
    const bytes = await readFile(path.join(dubDir, "lines", "0001.mp3"));
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("re-synthesizes stretch lines and records the new audio", async () => {
    // target 5000ms，自然合成 2000ms，规划器把它放慢到 0.95 填进目标区间
    const dubDir = await makeTmp();
    const { report } = await applyDubNegotiation({
      plan: planFixture({
        action: "stretch",
        rate: 0.95,
        naturalMs: 2000,
        targetDurationMs: 5000,
        originalEndMs: 5000,
        plannedEndMs: 2105,
      }),
      tts: fakeTts({ "0.95": 2105 }),
      voice: "v",
      dubDir,
      existingAudioByIndex: new Map(),
      runner: probeRunner("2.105"),
    });
    expect(report.stretchCount).toBe(1);
    expect(report.delayCount).toBe(0);
    expect(report.lines[0]).toMatchObject({ action: "stretch", audioFile: "lines/0001.mp3" });
  });

  it("demotes a stretch line to delay when the slowed-down synthesis still overflows", async () => {
    // 引擎的调速不总是线性——即使按规划的 rate 放慢，实测仍可能超出目标区间；
    // 与 speed 分支共用同一道安全网，超出时降级为 delay 而不是假装装得下
    const dubDir = await makeTmp();
    const { report, warnings } = await applyDubNegotiation({
      plan: planFixture({
        action: "stretch",
        rate: 0.95,
        naturalMs: 900,
        targetDurationMs: 1000,
        originalEndMs: 1000,
        plannedEndMs: 947,
      }),
      // fakeTts 在 rate 0.95 下实际吐出 1200ms，远超 1000ms 目标 + FIT_SLACK_MS
      tts: fakeTts({ "0.95": 1200 }),
      voice: "v",
      dubDir,
      existingAudioByIndex: new Map(),
      runner: probeRunner("1.2"),
    });
    expect(report.stretchCount).toBe(0);
    expect(report.delayCount).toBe(1);
    expect(report.lines[0]!.action).toBe("delay");
    expect(warnings[0]).toMatch(/still overflowed/);
  });
});
