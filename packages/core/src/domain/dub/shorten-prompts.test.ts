import { describe, expect, it } from "vitest";
import {
  DUB_SHORTEN_RULES,
  buildDubShortenRepairPrompt,
  buildDubShortenUserPrompt,
  getDubShortenSystemPrompt,
} from "./shorten-prompts.js";

describe("getDubShortenSystemPrompt", () => {
  const prompt = getDubShortenSystemPrompt();

  it("states that this is a shorten pass, not a re-translation", () => {
    expect(prompt).toMatch(/Shorten/i);
    expect(prompt).toMatch(/Do NOT re-translate/i);
  });

  it("includes every shorten rule", () => {
    for (const rule of DUB_SHORTEN_RULES) {
      expect(prompt).toContain(rule);
    }
  });
});

describe("buildDubShortenUserPrompt", () => {
  it("serializes index/text/maxChars only", () => {
    expect(buildDubShortenUserPrompt([{ index: 3, text: "偏长的句子", maxChars: 4 }])).toBe(
      JSON.stringify([{ index: 3, text: "偏长的句子", maxChars: 4 }]),
    );
  });
});

describe("buildDubShortenRepairPrompt", () => {
  it("pins the missing indices into the instruction", () => {
    const prompt = buildDubShortenRepairPrompt([2, 5]);
    expect(prompt).toContain("2, 5");
    expect(prompt).toMatch(/EXACTLY one object per index/i);
  });
});
