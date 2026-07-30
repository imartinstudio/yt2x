import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DubNegotiatePlan, LlmPort, TtsPort, TtsResult } from "@yt2x/core";
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
    };
  },
});

const probeRunner = (durationSec: string): ProcessRunner => ({
  run: async (spec) => okResult(spec, `${durationSec}\n`),
});

const planFixture = (overrides?: Partial<DubNegotiatePlan["lines"][number]>): DubNegotiatePlan => ({
  version: 1,
  videoId: "vid",
  extendMs: 0,
  plannedDriftMs: 0,
  keepCount: 1,
  speedCount: 0,
  shortenCount: 0,
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

  it("shortens via LLM then synthesizes", async () => {
    const dubDir = await makeTmp();
    const llm: LlmPort = {
      chat: async () => ({
        content: JSON.stringify([{ index: 1, text: "短句" }]),
        model: "m",
        finishReason: "stop",
      }),
    };
    const { report } = await applyDubNegotiation({
      plan: planFixture({
        action: "shorten",
        naturalMs: 1500,
        shortenMaxChars: 4,
        text: "这是一句很长的需要被改短的句子",
      }),
      tts: fakeTts({ "1": 800 }),
      voice: "v",
      dubDir,
      existingAudioByIndex: new Map(),
      llm,
      model: "m",
      runner: probeRunner("0.8"),
    });
    expect(report.shortenCount).toBe(1);
    expect(report.lines[0]!.text).toBe("短句");
  });
});
