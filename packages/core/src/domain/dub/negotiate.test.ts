import { describe, expect, it } from "vitest";
import {
  PREFERRED_RATE_MAX,
  PREFERRED_RATE_MIN,
  DEFAULT_STRETCH_MAX_OCCUPANCY,
  DEFAULT_MIN_INTER_SENTENCE_PAUSE_MS,
  DEFAULT_STRETCH_MIN_UNDERRUN_MS,
  buildNegotiateInputs,
  effectiveRateMax,
  planDubNegotiation,
  requiredRate,
  type NegotiateLineInput,
} from "./negotiate.js";
import type { DubLineTiming, DubScriptLine } from "./types.js";

const rateRange = { min: 0.5, max: 2.0 };

const line = (
  index: number,
  startMs: number,
  endMs: number,
  naturalMs: number,
  text = `句子${index}`,
): NegotiateLineInput => ({
  index,
  startMs,
  endMs,
  targetDurationMs: endMs - startMs,
  text,
  naturalMs,
});

describe("planDubNegotiation: stretch must not spend drift repayment", () => {
  /**
   * A line that badly overruns, then a roomy line that could pay the debt back.
   * The roomy line's slack is the only way accumulated drift ever comes down:
   * `drift = max(0, drift + overflow)`, and a short line's negative overflow is
   * the repayment. Stretching it to fill its own slot spends that repayment on
   * silence instead.
   *
   * Measured on a real 8-minute dub: 37 stretched lines consumed 28.7s, every one
   * of them while the timeline was already ≥0.5s behind, against an extendMs of
   * 15.6s and a hard cap of 8s. The video had 84.7s of total slack against 62.4s
   * of overflow — it fits; the slack was just being burned.
   */
  const overrunThenRoom: NegotiateLineInput[] = [
    line(1, 0, 4000, 12000),
    line(2, 4000, 12000, 2000),
  ];

  const plan = (lines: NegotiateLineInput[]) =>
    planDubNegotiation({
      lines,
      rateRange,
      maxExtendMs: 8000,
      minInterSentencePauseMs: DEFAULT_MIN_INTER_SENTENCE_PAUSE_MS,
      stretchMinUnderrunMs: DEFAULT_STRETCH_MIN_UNDERRUN_MS,
      stretchMaxOccupancy: DEFAULT_STRETCH_MAX_OCCUPANCY,
    });

  it("leaves a roomy line at natural rate while the timeline is behind", () => {
    const result = plan(overrunThenRoom);
    const second = result.lines.find((l) => l.index === 2)!;
    expect(second.action).not.toBe("stretch");
  });

  it("pays the drift down instead of carrying it to the end freeze", () => {
    // 12s of speech in a 4s slot leaves 8s of debt; the next line has 6s spare.
    // Repaying leaves ~2s at the tail rather than the full 8s.
    expect(plan(overrunThenRoom).extendMs).toBeLessThan(4000);
  });

  it("still stretches when nothing is owed", () => {
    // The feature exists to cut dead air (a listening test took total silence
    // 67.7s -> 40.0s); suppressing it unconditionally would undo that.
    const onSchedule: NegotiateLineInput[] = [
      line(1, 0, 4000, 3900),
      line(2, 4000, 12000, 2000),
    ];
    expect(plan(onSchedule).lines.find((l) => l.index === 2)!.action).toBe("stretch");
  });
});

describe("requiredRate", () => {
  it("is natural / target", () => {
    expect(requiredRate(1200, 1000)).toBeCloseTo(1.2);
  });

  it("returns Infinity when target is zero", () => {
    expect(requiredRate(1000, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("effectiveRateMax", () => {
  it("takes the lower of preferred and engine max", () => {
    expect(effectiveRateMax({ min: 0.5, max: 2.0 })).toBe(PREFERRED_RATE_MAX);
    expect(effectiveRateMax({ min: 0.5, max: 1.1 })).toBe(1.1);
  });
});

describe("stretch defaults", () => {
  it("holds the 0.85 floor chosen by ear, with the trigger aligned to it", () => {
    // 两版成片只差这一个变量：0.85 把总静默从 67.7s 压到 40.0s，>2s 的停顿从 6 处
    // 降到 1 处，代价是约 58 行慢一成半——试听后判定可接受。触发阈值必须与地板同值，
    // 否则严于地板的那一侧会让参数恒被地板支配（历史上 0.85 vs 0.95 就是这么失效的）。
    expect(PREFERRED_RATE_MIN).toBe(0.85);
    expect(DEFAULT_STRETCH_MAX_OCCUPANCY).toBe(0.95);
  });
});

describe("buildNegotiateInputs", () => {
  it("joins script lines with matching timings and skips missing ones", () => {
    const script: DubScriptLine[] = [
      {
        index: 1,
        startMs: 0,
        endMs: 1000,
        targetDurationMs: 1000,
        text: "甲",
        sourceText: "甲",
        cueIndices: [1],
      },
      {
        index: 2,
        startMs: 1200,
        endMs: 2200,
        targetDurationMs: 1000,
        text: "乙",
        sourceText: "乙",
        cueIndices: [2],
      },
    ];
    const timings: DubLineTiming[] = [
      {
        index: 1,
        targetDurationMs: 1000,
        synthesizedMs: 900,
        ratio: 0.9,
        charCount: 1,
        audioFile: "lines/0001.mp3",
      },
    ];
    expect(buildNegotiateInputs(script, timings)).toEqual([
      {
        index: 1,
        startMs: 0,
        endMs: 1000,
        targetDurationMs: 1000,
        text: "甲",
        naturalMs: 900,
      },
    ]);
  });
});

describe("planDubNegotiation", () => {
  it("keeps lines that fit at natural rate", () => {
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange,
      lines: [line(1, 0, 1000, 900)],
    });
    expect(plan.keepCount).toBe(1);
    expect(plan.lines[0]!.action).toBe("keep");
    expect(plan.lines[0]!.plannedStartMs).toBe(0);
    expect(plan.lines[0]!.plannedEndMs).toBe(900);
    expect(plan.extendMs).toBe(0);
  });

  it("speeds up when the needed rate is within the preferred band", () => {
    // 1100 into 1000 → rate 1.1 ≤ 1.15
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange,
      lines: [line(1, 0, 1000, 1100)],
    });
    expect(plan.speedCount).toBe(1);
    expect(plan.lines[0]!.action).toBe("speed");
    expect(plan.lines[0]!.rate).toBeCloseTo(1.1);
    expect(plan.extendMs).toBe(0);
  });

  it("delays when speed would exceed the preferred max", () => {
    // 1500 into 1000 → rate 1.5 > 1.15，超出偏好加速上限，退到 delay
    // （原第三档 shorten 已删除：冗余现在由长度受限翻译在生成配音稿阶段挤掉）
    const long = "这是一句明显偏长需要被压缩的中文配音句子内容";
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange,
      lines: [line(1, 0, 1000, 1500, long)],
    });
    expect(plan.delayCount).toBe(1);
    expect(plan.lines[0]!.action).toBe("delay");
  });

  it("delays when there is no room at all", () => {
    // 单字装不下，走 delay
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange,
      lines: [line(1, 0, 1000, 2000, "短")],
    });
    expect(plan.delayCount).toBe(1);
    expect(plan.lines[0]!.action).toBe("delay");
    expect(plan.extendMs).toBe(1000);
  });

  it("absorbs cumulative drift into the next natural pause", () => {
    // 句1 溢出 200ms；句间 gap 500ms，保留 80ms → 可吸收 420ms，漂移清零
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange,
      lines: [line(1, 0, 1000, 1200, "短"), line(2, 1500, 2500, 900, "短二")],
    });
    // 1200 into 1000 with rate 1.2 > 1.15 and text "短" → delay, overflow 200
    expect(plan.lines[0]!.action).toBe("delay");
    expect(plan.lines[1]!.plannedStartMs).toBe(1500); // drift absorbed
    expect(plan.extendMs).toBe(0);
  });

  it("carries unabsorbed drift to extendMs at the end", () => {
    // 溢出 400ms，gap 只有 100ms（可吸收 20ms）→ 残留 380；再加最小句间停顿抬到 1550
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange,
      lines: [line(1, 0, 1000, 1400, "短"), line(2, 1100, 2100, 900, "短二")],
    });
    expect(plan.lines[0]!.action).toBe("delay");
    expect(plan.lines[0]!.plannedEndMs).toBe(1400);
    expect(plan.lines[1]!.plannedStartMs).toBe(1400 + DEFAULT_MIN_INTER_SENTENCE_PAUSE_MS);
    expect(plan.extendMs).toBeGreaterThan(0);
  });

  it("respects a narrower engine rateRange", () => {
    // 需要 1.12，但引擎上限只有 1.05 → 不能 speed，退到 delay
    const long = "这是一句用来测试引擎区间的中文配音句子";
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange: { min: 0.8, max: 1.05 },
      lines: [line(1, 0, 1000, 1120, long)],
    });
    expect(plan.speedCount).toBe(0);
    expect(plan.delayCount).toBe(1);
  });

  it("enforces a minimum pause between abutting sentences", () => {
    // 两句原片贴着（gap=0），自然语速都装得下；不得仍以 0ms 间隔落点
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange,
      minInterSentencePauseMs: 150,
      maxExtendMs: 10_000,
      lines: [line(1, 0, 1000, 900, "第一句"), line(2, 1000, 2000, 900, "第二句")],
    });
    expect(plan.lines[0]!.plannedEndMs).toBe(900);
    expect(plan.lines[1]!.plannedStartMs).toBe(900 + 150);
    expect(plan.lines[1]!.plannedStartMs - plan.lines[0]!.plannedEndMs).toBe(150);
  });

  it("prefers pause over further compression while under the extendMs cap", () => {
    // 句1 溢出走 delay；补 150ms 停顿推高漂移，但未触顶 → 不为此再加速
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange,
      minInterSentencePauseMs: 150,
      maxExtendMs: 5_000,
      lines: [line(1, 0, 1000, 1200, "短"), line(2, 1000, 2000, 900, "短二")],
    });
    expect(plan.lines[0]!.action).toBe("delay");
    expect(plan.lines[1]!.plannedStartMs).toBeGreaterThanOrEqual(
      plan.lines[0]!.plannedEndMs + 150,
    );
    expect(plan.extendMs).toBeLessThanOrEqual(5_000);
    expect(plan.speedCount).toBe(0);
  });

  it("still enforces the minimum pause once borrowing can no longer keep extendMs under the cap", () => {
    // 贴句 + 偏长：触顶后从槽内借时间压缩语速，但删除 shorten 档后借时间对已经
    // 超出偏好加速上限的行无能为力——它们退到 delay，extendMs 可能顶破 maxExtendMs。
    // 这是删除第三档后的已知取舍（见 docs/DUB-TASK.md）：extendMs 硬上限不再由
    // 规划器单独保证，改由下游门禁（gate）兜底。规划器唯一不可退让的是句间停顿。
    const lines = Array.from({ length: 8 }, (_, i) =>
      line(i + 1, i * 1000, i * 1000 + 1000, 1100, `这是第${i + 1}句偏长需要压缩的配音内容`),
    );
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange,
      minInterSentencePauseMs: 150,
      maxExtendMs: 400,
      lines,
    });
    for (let i = 0; i < plan.lines.length - 1; i += 1) {
      const gap = plan.lines[i + 1]!.plannedStartMs - plan.lines[i]!.plannedEndMs;
      expect(gap).toBeGreaterThanOrEqual(150);
    }
    expect(plan.extendMs).toBeGreaterThan(0);
  });

  describe("stretch (反向放慢填充富余)", () => {
    it("lets a candidate floor use the measured occupancy between the trigger ceiling and floor", () => {
      // target 5000ms，自然合成 4500ms，占用比 0.9：候选地板 0.85 应采用实际
      // 0.9，而不是因为触发阈值仍停在 0.85 而完全不触发。
      expect(DEFAULT_STRETCH_MAX_OCCUPANCY).toBeGreaterThan(0.9);
      const plan = planDubNegotiation({
        videoId: "vid",
        rateRange: { min: 0.5, max: 2.0 },
        preferredRateMin: 0.85,
        lines: [line(1, 0, 5000, 4500)],
      });
      expect(plan.lines[0]!.action).toBe("stretch");
      expect(plan.lines[0]!.rate).toBeCloseTo(0.9);
    });

    it("slows down when there is meaningful slack", () => {
      // target 5000ms，自然合成只用 2000ms，占用比 0.4 远低于阈值，富余 3000ms 远超阈值
      const plan = planDubNegotiation({
        videoId: "vid",
        rateRange: { min: 0.5, max: 2.0 },
        lines: [line(1, 0, 5000, 2000)],
      });
      expect(plan.stretchCount).toBe(1);
      expect(plan.lines[0]!.action).toBe("stretch");
      expect(plan.lines[0]!.rate).toBeLessThan(1);
      // 引用常量而不是字面量：默认地板是人耳试听后定的，改它不该让这条断言假失败
      expect(plan.lines[0]!.rate).toBeGreaterThanOrEqual(PREFERRED_RATE_MIN);
      // 放慢后时长变长（naturalMs / rate），但仍不超过目标区间
      expect(plan.lines[0]!.plannedEndMs).toBeGreaterThan(2000);
      expect(plan.lines[0]!.plannedEndMs).toBeLessThanOrEqual(5000);
      expect(plan.keepCount).toBe(0);
    });

    it("does not slow down when the slack is too small to matter", () => {
      // target 1000ms，自然合成用了 700ms：富余 300ms < 默认阈值 400ms，保持 keep
      expect(300).toBeLessThan(DEFAULT_STRETCH_MIN_UNDERRUN_MS);
      const plan = planDubNegotiation({
        videoId: "vid",
        rateRange: { min: 0.5, max: 2.0 },
        lines: [line(1, 0, 1000, 700)],
      });
      expect(plan.lines[0]!.action).toBe("keep");
      expect(plan.lines[0]!.rate).toBe(1);
      expect(plan.stretchCount).toBe(0);
      expect(plan.keepCount).toBe(1);
    });

    it("does not slow down when the occupancy ratio is already high enough", () => {
      // target 6000ms，自然合成 5700ms：占用比正好 0.95，达到触发阈值边界，不该被 stretch 碰到
      const plan = planDubNegotiation({
        videoId: "vid",
        rateRange: { min: 0.5, max: 2.0 },
        lines: [line(1, 0, 6000, 5700)],
      });
      expect(plan.lines[0]!.action).toBe("keep");
      expect(plan.stretchCount).toBe(0);
    });

    it("clamps the slow-down rate to the engine's reported rateRange lower bound", () => {
      // 引擎自报下限 0.92 比默认偏好下限 0.95 更宽松，但仍是约束（effectiveRateMin
      // 取引擎与偏好两者较严格的一侧——这里刻意让偏好比引擎更宽松，验证引擎下限生效）
      const plan = planDubNegotiation({
        videoId: "vid",
        rateRange: { min: 0.92, max: 2.0 },
        preferredRateMin: 0.8,
        lines: [line(1, 0, 5000, 1000)], // 理论所需 rate = 1000/5000 = 0.2，远低于 0.92
      });
      expect(plan.lines[0]!.action).toBe("stretch");
      expect(plan.lines[0]!.rate).toBeCloseTo(0.92);
      // 只放慢到地板，装不满整个 target（1000 / 0.92 ≈ 1087ms，仍远小于 5000ms）
      expect(plan.lines[0]!.plannedEndMs).toBeLessThan(5000);
    });

    it("falls back to keep when the engine cannot slow down at all", () => {
      // 引擎 rateRange.min = 1.0：effectiveRateMin = max(1.0, 0.95) = 1.0，不满足 rateMin < 1
      const plan = planDubNegotiation({
        videoId: "vid",
        rateRange: { min: 1.0, max: 2.0 },
        lines: [line(1, 0, 5000, 2000)], // 换成宽松引擎时本会 stretch 的富余
      });
      expect(plan.lines[0]!.action).toBe("keep");
      expect(plan.stretchCount).toBe(0);
      expect(plan.lines[0]!.plannedEndMs).toBe(2000);
    });
  });
});
