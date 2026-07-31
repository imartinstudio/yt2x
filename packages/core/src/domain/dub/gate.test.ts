import { describe, expect, it } from "vitest";
import { DEFAULT_DUB_GATE_THRESHOLDS, evaluateDubGate } from "./gate.js";
import type { DubPlacementReport, DubScript, DubTimingReport } from "./types.js";

const timing = (overrides?: Partial<DubTimingReport>): DubTimingReport => ({
  version: 1,
  videoId: "vid",
  engine: "edge-tts",
  voice: "v",
  lineCount: 2,
  medianRatio: 1.0,
  overflowCount: 0,
  totalDriftMs: 0,
  lines: [
    {
      index: 1,
      targetDurationMs: 1000,
      synthesizedMs: 900,
      ratio: 0.9,
      charCount: 4,
      audioFile: "lines/0001.mp3",
    },
    {
      index: 2,
      targetDurationMs: 1000,
      synthesizedMs: 950,
      ratio: 0.95,
      charCount: 4,
      audioFile: "lines/0002.mp3",
    },
  ],
  ...overrides,
});

const placement = (overrides?: Partial<DubPlacementReport>): DubPlacementReport => ({
  version: 1,
  videoId: "vid",
  engine: "edge-tts",
  voice: "v",
  extendMs: 0,
  audioEndMs: 2000,
  keepCount: 2,
  speedCount: 0,
  shortenCount: 0,
  delayCount: 0,
  lines: [
    {
      index: 1,
      action: "keep",
      rate: 1,
      text: "你好世界",
      startMs: 0,
      endMs: 900,
      durationMs: 900,
      audioFile: "lines/0001.mp3",
    },
    {
      index: 2,
      action: "keep",
      rate: 1,
      text: "第二句话",
      startMs: 1_050,
      endMs: 2_000,
      durationMs: 950,
      audioFile: "lines/0002.mp3",
    },
  ],
  ...overrides,
});

const script = (): DubScript => ({
  version: 1,
  videoId: "vid",
  sourceSubtitle: "video/full.zh.srt",
  rewriteModel: "m",
  lines: [
    {
      index: 1,
      startMs: 0,
      endMs: 1000,
      targetDurationMs: 1000,
      text: "你好世界",
      sourceText: "你好世界",
      cueIndices: [1],
    },
    {
      index: 2,
      startMs: 1000,
      endMs: 2000,
      targetDurationMs: 1000,
      text: "第二句话",
      sourceText: "第二句话",
      cueIndices: [2],
    },
  ],
});

describe("evaluateDubGate", () => {
  it("passes a healthy placement", () => {
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing(),
      placement: placement(),
      script: script(),
    });
    expect(report.passed).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.issues).toEqual([]);
  });

  it("hard-blocks on excessive end freeze", () => {
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing(),
      placement: placement({ extendMs: DEFAULT_DUB_GATE_THRESHOLDS.maxExtendMs + 1 }),
    });
    expect(report.blocked).toBe(true);
    expect(report.issues.some((i) => i.code === "high-extend-ms" && i.severity === "hard")).toBe(
      true,
    );
  });

  it("hard-blocks on empty audio", () => {
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing(),
      placement: placement({
        lines: [
          {
            index: 1,
            action: "keep",
            rate: 1,
            text: "有字",
            startMs: 0,
            endMs: 0,
            durationMs: 0,
            audioFile: "",
          },
        ],
      }),
    });
    expect(report.blocked).toBe(true);
    expect(report.issues.some((i) => i.code === "empty-audio")).toBe(true);
  });

  it("hard-blocks on severe info loss after shorten", () => {
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing(),
      placement: placement({
        lines: [
          {
            index: 1,
            action: "shorten",
            rate: 1,
            text: "短",
            startMs: 0,
            endMs: 400,
            durationMs: 400,
            audioFile: "lines/0001.mp3",
          },
        ],
      }),
      script: {
        ...script(),
        lines: [
          {
            index: 1,
            startMs: 0,
            endMs: 1000,
            targetDurationMs: 1000,
            text: "短",
            sourceText: "这是一句很长很长很长很长的中文配音原文",
            cueIndices: [1],
          },
        ],
      },
    });
    expect(report.blocked).toBe(true);
    expect(report.issues.some((i) => i.code === "info-loss")).toBe(true);
  });

  it("records advisory issues without blocking", () => {
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing({ medianRatio: 1.5, overflowCount: 2, lineCount: 2 }),
      placement: placement(),
    });
    expect(report.blocked).toBe(false);
    expect(report.passed).toBe(true);
    expect(report.issues.some((i) => i.code === "high-median-ratio")).toBe(true);
    expect(report.issues.some((i) => i.code === "high-overflow-fraction")).toBe(true);
  });

  it("does not emit NaN overflowFraction when timing.lineCount is 0", () => {
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing({ lineCount: 0, overflowCount: 0, lines: [], medianRatio: 0 }),
      placement: placement({
        lines: [
          {
            index: 1,
            action: "keep",
            rate: 1,
            text: "有字",
            startMs: 0,
            endMs: 900,
            durationMs: 900,
            audioFile: "lines/0001.mp3",
          },
        ],
      }),
    });
    expect(Number.isFinite(report.metrics.overflowFraction)).toBe(true);
    expect(report.metrics.overflowFraction).toBe(0);
  });

  it("hard-blocks on zero inter-sentence gaps", () => {
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing(),
      placement: placement({
        lines: [
          {
            index: 1,
            action: "keep",
            rate: 1,
            text: "第一句",
            startMs: 0,
            endMs: 1000,
            durationMs: 1000,
            audioFile: "lines/0001.mp3",
          },
          {
            index: 2,
            action: "keep",
            rate: 1,
            text: "第二句",
            startMs: 1000,
            endMs: 2000,
            durationMs: 1000,
            audioFile: "lines/0002.mp3",
          },
        ],
      }),
    });
    expect(report.blocked).toBe(true);
    expect(report.metrics.zeroGapCount).toBe(1);
    expect(report.metrics.minObservedGapMs).toBe(0);
    expect(report.issues.some((i) => i.code === "zero-inter-sentence-pause")).toBe(true);
  });

  it("hard-blocks on gaps below the minimum pause", () => {
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing(),
      placement: placement({
        lines: [
          {
            index: 1,
            action: "keep",
            rate: 1,
            text: "第一句",
            startMs: 0,
            endMs: 900,
            durationMs: 900,
            audioFile: "lines/0001.mp3",
          },
          {
            index: 2,
            action: "keep",
            rate: 1,
            text: "第二句",
            startMs: 950,
            endMs: 1900,
            durationMs: 950,
            audioFile: "lines/0002.mp3",
          },
        ],
      }),
    });
    expect(report.blocked).toBe(true);
    expect(report.metrics.lowGapCount).toBe(1);
    expect(report.metrics.minObservedGapMs).toBe(50);
    expect(report.issues.some((i) => i.code === "low-inter-sentence-pause")).toBe(true);
  });
});
