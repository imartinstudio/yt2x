import { describe, expect, it } from "vitest";
import {
  PREFERRED_RATE_MAX,
  buildNegotiateInputs,
  effectiveRateMax,
  planDubNegotiation,
  requiredRate,
  shortenCharBudget,
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

describe("shortenCharBudget", () => {
  it("scales by the duration ratio with a safety margin", () => {
    // 2000ms natural into 1000ms slot → ~47% of chars
    expect(shortenCharBudget("一二三四五六七八九十", 2000, 1000)).toBe(4);
  });

  it("never returns below 4 for non-empty text", () => {
    expect(shortenCharBudget("很长很长很长很长很长很长", 10_000, 100)).toBe(4);
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

  it("marks shorten when speed would exceed the preferred max", () => {
    // 1500 into 1000 → rate 1.5 > 1.15, and shorten budget < original length
    const long = "这是一句明显偏长需要被改短的中文配音句子内容";
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange,
      lines: [line(1, 0, 1000, 1500, long)],
    });
    expect(plan.shortenCount).toBe(1);
    expect(plan.lines[0]!.action).toBe("shorten");
    expect(plan.lines[0]!.shortenMaxChars).toBeLessThan(long.length);
  });

  it("delays when even shortening has no room", () => {
    // 单字压不短：budget 下限 4 ≥ 原文长度时走 delay
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
    // 溢出 400ms，gap 只有 100ms（可吸收 20ms）→ 残留 380
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange,
      lines: [line(1, 0, 1000, 1400, "短"), line(2, 1100, 2100, 900, "短二")],
    });
    expect(plan.lines[0]!.action).toBe("delay");
    expect(plan.lines[1]!.plannedStartMs).toBe(1100 + 380);
    expect(plan.extendMs).toBeGreaterThan(0);
  });

  it("respects a narrower engine rateRange", () => {
    // 需要 1.12，但引擎上限只有 1.05 → 不能 speed，改 shorten
    const long = "这是一句需要改短的中文配音句子用来测试引擎区间";
    const plan = planDubNegotiation({
      videoId: "vid",
      rateRange: { min: 0.8, max: 1.05 },
      lines: [line(1, 0, 1000, 1120, long)],
    });
    expect(plan.speedCount).toBe(0);
    expect(plan.shortenCount).toBe(1);
  });
});
