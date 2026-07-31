import { describe, expect, it } from "vitest";
import {
  buildDubTranslatePayload,
  buildDubTranslateRepairPrompt,
  buildDubTranslateUserPrompt,
  dubTranslateCharBudget,
  estimateSpokenMs,
  getDubTranslateSystemPrompt,
} from "./translate-prompts.js";
import type { Utterance } from "./types.js";

const utt = (index: number, startMs: number, endMs: number, text: string): Utterance => ({
  index,
  startMs,
  endMs,
  text,
  wordCount: text.split(" ").length,
});

describe("dubTranslateCharBudget", () => {
  it("charges the fixed overhead before allotting any characters", () => {
    const rate = { fixedOverheadMs: 2_000, msPerChar: 100 };
    // 2000ms 全被固定开销吃掉，只剩 1000ms 够 10 个字
    expect(dubTranslateCharBudget(3_000, rate)).toBe(10);
  });

  it("gives a slower voice fewer characters for the same slot", () => {
    const slow = dubTranslateCharBudget(6_000, { fixedOverheadMs: 1_000, msPerChar: 300 });
    const fast = dubTranslateCharBudget(6_000, { fixedOverheadMs: 1_000, msPerChar: 150 });
    expect(fast).toBeGreaterThan(slow);
  });

  it("still allots a character when the slot cannot even cover the overhead", () => {
    // 这类单元靠翻译压不进去，但产出空译文只会变成一段静音
    expect(dubTranslateCharBudget(500, { fixedOverheadMs: 2_000, msPerChar: 100 })).toBe(1);
  });

  it("round-trips against the duration estimate", () => {
    const budget = dubTranslateCharBudget(8_000);
    expect(estimateSpokenMs(budget)).toBeLessThanOrEqual(8_000);
    expect(estimateSpokenMs(budget + 1)).toBeGreaterThan(8_000);
  });

  it("never returns a budget below one character", () => {
    expect(dubTranslateCharBudget(0)).toBeGreaterThanOrEqual(1);
    expect(dubTranslateCharBudget(-500)).toBeGreaterThanOrEqual(1);
  });
});

describe("getDubTranslateSystemPrompt", () => {
  const prompt = getDubTranslateSystemPrompt();

  it("frames the task as translating to fit, not translating then cutting", () => {
    expect(prompt).toMatch(/fit/i);
    expect(prompt).toMatch(/maxChars/);
  });

  it("requires proper nouns and identifiers to survive verbatim", () => {
    expect(prompt).toMatch(/Proper nouns/i);
    expect(prompt).toMatch(/verbatim|EXACTLY/i);
  });

  it("tells the model to spend the budget on redundancy, not on content", () => {
    expect(prompt).toMatch(/filler|redundan/i);
    expect(prompt).toMatch(/fact|number|name/i);
  });

  it("forbids truncation markers, which are the signature of post-hoc cutting", () => {
    expect(prompt).toMatch(/等等|ellips|truncat/i);
  });

  it("demands Simplified Chinese and a JSON array reply", () => {
    expect(prompt).toMatch(/Simplified Chinese/);
    expect(prompt).toMatch(/JSON array/);
  });
});

describe("buildDubTranslatePayload", () => {
  it("carries the character budget derived from each utterance's own duration", () => {
    const payload = buildDubTranslatePayload([
      utt(1, 0, 3_000, "hello there"),
      utt(2, 3_000, 9_000, "a much longer stretch of speech"),
    ]);
    expect(payload[0]).toMatchObject({ index: 1, text: "hello there" });
    expect(payload[1]!.maxChars).toBeGreaterThan(payload[0]!.maxChars);
  });

  it("uses the utterance duration, not its word count", () => {
    const short = buildDubTranslatePayload([utt(1, 0, 1_000, "one two three four five six")]);
    const long = buildDubTranslatePayload([utt(1, 0, 8_000, "one two")]);
    expect(long[0]!.maxChars).toBeGreaterThan(short[0]!.maxChars);
  });
});

describe("buildDubTranslateUserPrompt", () => {
  it("serialises the payload as JSON", () => {
    const prompt = buildDubTranslateUserPrompt([utt(1, 0, 3_000, "hello")]);
    const parsed: unknown = JSON.parse(prompt);
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as { index: number }[])[0]?.index).toBe(1);
  });
});

describe("buildDubTranslateRepairPrompt", () => {
  it("pins the missing indices into the instruction", () => {
    const prompt = buildDubTranslateRepairPrompt([3, 7]);
    expect(prompt).toContain("3");
    expect(prompt).toContain("7");
    expect(prompt).toMatch(/EXACTLY|exactly/);
  });
});
