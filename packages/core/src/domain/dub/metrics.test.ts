import { describe, expect, it } from "vitest";
import { summarizeGaps, summarizeCueWidths } from "./metrics.js";

describe("summarizeGaps", () => {
  it("reports the shape of the distribution, not just an average", () => {
    // 平均值会被长尾拉高而掩盖「多数句子其实衔接得很紧」；压静默这件事盯的是长尾，
    // 所以 p90/p95/最大值必须单独给出。
    const gaps = [100, 150, 200, 250, 300, 3_000, 4_000];
    const s = summarizeGaps(gaps);
    expect(s.count).toBe(7);
    expect(s.medianMs).toBe(250);
    expect(s.maxMs).toBe(4_000);
    expect(s.meanMs).toBeGreaterThan(s.medianMs);
  });

  it("counts the long tail at the two thresholds the plan tracks", () => {
    const gaps = [200, 900, 1_100, 1_500, 2_100, 3_400];
    const s = summarizeGaps(gaps);
    expect(s.overOneSecondCount).toBe(4);
    expect(s.overTwoSecondsCount).toBe(2);
  });

  it("totals the silence so two runs can be compared as one number", () => {
    expect(summarizeGaps([1_000, 2_000, 500]).totalMs).toBe(3_500);
  });

  it("survives an empty gap list without inventing values", () => {
    const s = summarizeGaps([]);
    expect(s.count).toBe(0);
    expect(s.totalMs).toBe(0);
    expect(s.medianMs).toBeNull();
    expect(s.maxMs).toBeNull();
  });

  it("treats a single gap as its own median, p90 and max", () => {
    const s = summarizeGaps([700]);
    expect(s.medianMs).toBe(700);
    expect(s.p90Ms).toBe(700);
    expect(s.maxMs).toBe(700);
  });

  it("ignores negative gaps rather than letting them cancel real silence", () => {
    // 落点重叠会算出负间隔；把它当 0 计，否则总静默会被悄悄抵消掉一部分
    const s = summarizeGaps([-200, 1_000]);
    expect(s.totalMs).toBe(1_000);
  });
});

describe("summarizeCueWidths", () => {
  it("counts how many display cues exceed the width budget", () => {
    const s = summarizeCueWidths(["十个字的一句话啊", "这一条明显更长一些需要换行处理才行的句子"], 10);
    expect(s.count).toBe(2);
    expect(s.overBudgetCount).toBe(1);
    expect(s.maxWidth).toBeGreaterThan(10);
  });

  it("measures Latin characters at half a cell, matching the renderer", () => {
    // 与显示单元细分同一套单位：CJK 一格、半角拉丁半格
    const s = summarizeCueWidths(["abcd"], 20);
    expect(s.maxWidth).toBe(2);
  });

  it("survives an empty cue list", () => {
    const s = summarizeCueWidths([], 20);
    expect(s.count).toBe(0);
    expect(s.overBudgetCount).toBe(0);
    expect(s.maxWidth).toBeNull();
  });
});
