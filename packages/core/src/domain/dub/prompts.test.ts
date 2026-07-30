import { describe, expect, it } from "vitest";
import {
  DUB_REWRITE_RULES,
  buildDubRewritePayload,
  buildDubRewriteRepairPrompt,
  buildDubRewriteUserPrompt,
  dubRewriteCharBudget,
  getDubRewriteSystemPrompt,
} from "./prompts.js";
import type { DubSegment } from "./types.js";

const segment = (index: number, text: string): DubSegment => ({
  index,
  startMs: index * 1_000,
  endMs: index * 1_000 + 900,
  cueIndices: [index],
  text,
});

describe("dubRewriteCharBudget", () => {
  it("allows a small amount of slack over the source length", () => {
    expect(dubRewriteCharBudget("一二三四五六七八九十")).toBe(13);
    expect(dubRewriteCharBudget("短句")).toBe(5);
  });

  it("ignores surrounding whitespace", () => {
    expect(dubRewriteCharBudget("  短句  ")).toBe(dubRewriteCharBudget("短句"));
  });

  it("never returns a budget below the source length", () => {
    for (const text of ["a", "ab", "一二三", "这是一个比较长的中文句子用来测试预算"]) {
      expect(dubRewriteCharBudget(text)).toBeGreaterThanOrEqual(text.length);
    }
  });
});

describe("getDubRewriteSystemPrompt", () => {
  const prompt = getDubRewriteSystemPrompt();

  it("states that this is a read-aloud rewrite, not a re-translation", () => {
    expect(prompt).toContain("Do NOT re-translate");
    expect(prompt).toContain("do NOT add or drop any information point");
  });

  it("protects proper nouns, commands and code identifiers", () => {
    expect(prompt).toContain("Proper nouns");
    expect(prompt).toContain("code identifiers stay EXACTLY as written");
  });

  it("asks for spoken numbers but verbatim version numbers", () => {
    expect(prompt).toContain("百分之三十");
    expect(prompt).toContain("Claude 3.5");
  });

  it("forbids parentheticals and reader-facing asides", () => {
    expect(prompt).toContain("（如图）");
  });

  it("caps the rewritten length", () => {
    expect(prompt).toContain("maxChars");
    expect(prompt).toContain("MUST NOT be noticeably longer than the source");
  });

  it("pins the output shape to a bare JSON array", () => {
    expect(prompt).toContain('"index"');
    expect(prompt).toContain('"text"');
    expect(prompt).toContain("No commentary, no code fences");
  });

  it("requires Simplified Chinese", () => {
    expect(prompt).toContain("Traditional Chinese is forbidden");
  });

  it("carries every rule", () => {
    for (const rule of DUB_REWRITE_RULES) expect(prompt).toContain(rule);
  });
});

describe("buildDubRewriteRepairPrompt", () => {
  it("lists the missing indices verbatim", () => {
    const prompt = buildDubRewriteRepairPrompt([3, 7, 11]);
    expect(prompt).toContain("Rewrite these 3 sentences");
    expect(prompt).toContain("The indices are: 3, 7, 11");
  });

  it("keeps the same rewrite rules as the main prompt", () => {
    const prompt = buildDubRewriteRepairPrompt([1]);
    for (const rule of DUB_REWRITE_RULES) expect(prompt).toContain(rule);
  });
});

describe("buildDubRewriteUserPrompt", () => {
  it("emits one payload item per segment with its char budget", () => {
    const payload = buildDubRewritePayload([segment(1, "我们来看一下"), segment(2, "这是第二句")]);
    expect(payload).toEqual([
      { index: 1, text: "我们来看一下", maxChars: dubRewriteCharBudget("我们来看一下") },
      { index: 2, text: "这是第二句", maxChars: dubRewriteCharBudget("这是第二句") },
    ]);
  });

  it("does not leak timestamps into the prompt", () => {
    const prompt = buildDubRewriteUserPrompt([segment(1, "我们来看一下")]);
    expect(prompt).not.toContain("startMs");
    expect(prompt).not.toContain("endMs");
    expect(JSON.parse(prompt)).toHaveLength(1);
  });

  it("serializes an empty segment list as an empty array", () => {
    expect(buildDubRewriteUserPrompt([])).toBe("[]");
  });
});
