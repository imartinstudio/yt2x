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
  version: 2,
  videoId: "vid",
  engine: "edge-tts",
  voice: "v",
  extendMs: 0,
  audioEndMs: 2000,
  keepCount: 2,
  speedCount: 0,
  stretchCount: 0,
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

const script = (overrides?: Partial<DubScript>): DubScript => ({
  version: 2,
  videoId: "vid",
  sourceWords: "video/full.local.en.words.json",
  rewriteModel: "m",
  droppedCount: 0,
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
  ...overrides,
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

  it("hard-blocks when the script silently dropped untranslated utterances", () => {
    // 20 句丢 6 句这类场景：droppedCount 不体现在 lineCount / placement 里，
    // 门禁必须单独读 script.droppedCount 才能发现。
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing(),
      placement: placement(),
      script: script({ droppedCount: 6 }),
    });
    expect(report.blocked).toBe(true);
    expect(report.metrics.droppedCount).toBe(6);
    const issue = report.issues.find((i) => i.code === "dropped-utterances");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("hard");
  });

  it("does not flag dropped-utterances when no script is provided", () => {
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing(),
      placement: placement(),
    });
    expect(report.metrics.droppedCount).toBe(0);
    expect(report.issues.some((i) => i.code === "dropped-utterances")).toBe(false);
  });

  it("flags severe under-use of the time budget as advisory, without blocking", () => {
    // targetDurationMs=8720 → budget ≈ 59 chars（真实素材的量级）；
    // 译文只有 1 字，占用比 ≈ 0.02，远低于 0.3 的 advisory 阈值。
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing(),
      placement: placement({
        lines: [
          {
            index: 1,
            action: "delay",
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
            endMs: 8720,
            targetDurationMs: 8720,
            text: "短",
            sourceText:
              "This utterance had plenty to say but the translation came back suspiciously short for its budget.",
            cueIndices: [1],
          },
        ],
      },
    });
    // 信息损失指标不再拦成片（跨语言下"源/译码点比"语义已失效，改为占用时长预算的
    // advisory 提示，见 docs/DUB-TASK.md 的 info-loss 处置）。
    expect(report.blocked).toBe(false);
    expect(report.passed).toBe(true);
    const issue = report.issues.find((i) => i.code === "info-loss");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("advisory");
    expect(report.metrics.infoLossCount).toBe(1);
  });

  it("does not flag translations that use most of their time budget", () => {
    // targetDurationMs=8340 → budget ≈ 56 chars；32 字译文占用比 ≈ 0.57，
    // 与真实素材（0.42–1.08）同量级，不应触发 advisory。
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing(),
      placement: placement({
        lines: [
          {
            index: 1,
            action: "keep",
            rate: 1,
            text: "但有时我听到用户反馈，说这个功能问了两百个问题，我有点尴尬",
            startMs: 0,
            endMs: 8000,
            durationMs: 8000,
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
            endMs: 8340,
            targetDurationMs: 8340,
            text: "但有时我听到用户反馈，说这个功能问了两百个问题，我有点尴尬",
            sourceText:
              "However, I sometimes hear from people using them like, this issue just asks me 200 questions and I kind of wince a little bit.",
            cueIndices: [1],
          },
        ],
      },
    });
    expect(report.blocked).toBe(false);
    expect(report.issues.some((i) => i.code === "info-loss")).toBe(false);
  });

  it("skips info-loss evaluation entirely when the time budget itself is unusable, instead of scoring against a clamped budget of 1", () => {
    // dubTranslateCharBudget clamps its return value to >=1 even when the raw available
    // duration is below the fixed TTS overhead (1873ms) — a structurally unusable budget.
    // Before the fix, the guard compared against that clamped value (always >0) and never
    // skipped, so an empty translation on one of these short lines picked up a spurious
    // "info-loss" advisory on top of the (correct) hard empty-text issue. The budget being
    // unusable means there's nothing meaningful to score, so no info-loss issue should fire.
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing(),
      placement: placement({
        lines: [
          {
            index: 1,
            action: "keep",
            rate: 1,
            text: "",
            startMs: 0,
            endMs: 1000,
            durationMs: 1000,
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
            text: "",
            sourceText: "Um.",
            cueIndices: [1],
          },
        ],
      },
    });
    expect(report.issues.some((i) => i.code === "empty-text")).toBe(true);
    expect(report.issues.some((i) => i.code === "info-loss")).toBe(false);
    expect(report.metrics.infoLossCount).toBe(0);
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

  it("keeps maxDelayFraction at 0.35, not the over-tightened 0.3", () => {
    // 复审用滑窗统计证明 0.3 是纯粹的误拦（见 DEFAULT_DUB_GATE_THRESHOLDS 注释）：
    // 一个 delayFraction=0.32 的样本必须放行，而不是被 0.3 拦下。
    expect(DEFAULT_DUB_GATE_THRESHOLDS.maxDelayFraction).toBe(0.35);
    const report = evaluateDubGate({
      videoId: "vid",
      timing: timing({ lineCount: 25 }),
      placement: placement({
        delayCount: 8,
        lines: Array.from({ length: 25 }, (_, i) => ({
          index: i + 1,
          action: "keep" as const,
          rate: 1,
          text: "有字",
          startMs: i * 1000,
          endMs: i * 1000 + 700,
          durationMs: 700,
          audioFile: `lines/${i + 1}.mp3`,
        })),
      }),
    });
    expect(report.metrics.delayFraction).toBeCloseTo(0.32, 5);
    expect(report.blocked).toBe(false);
    expect(report.issues.some((i) => i.code === "high-delay-fraction")).toBe(false);
  });
});
