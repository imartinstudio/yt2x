import { describe, expect, it } from "vitest";
import {
  findProtectedSpans,
  PROTECTED_GLOSSARY_TERMS,
  PROTECTED_NAMES,
  PROTECTED_TERMS,
} from "./glossary.js";

describe("PROTECTED_TERMS", () => {
  it("combines glossary terms and names", () => {
    expect(PROTECTED_TERMS).toEqual([...PROTECTED_GLOSSARY_TERMS, ...PROTECTED_NAMES]);
  });

  it("carries the skill names the dub translation prompt must never translate", () => {
    expect(PROTECTED_GLOSSARY_TERMS).toContain("Grill Me");
    expect(PROTECTED_GLOSSARY_TERMS).toContain("Grill with Docs");
  });
});

describe("findProtectedSpans", () => {
  it("protects a known glossary term that contains a space", () => {
    const text = "先进行带文档的评审 Grill with Docs 环节";
    const spans = findProtectedSpans(text, ["Grill with Docs"]);
    const idx = text.indexOf("Grill with Docs");
    expect(spans).toContainEqual([idx, idx + "Grill with Docs".length]);
  });

  it("protects bare Latin/digit runs even when not in the glossary", () => {
    const spans = findProtectedSpans("你好Agents世界", []);
    const idx = "你好Agents世界".indexOf("Agents");
    expect(spans).toContainEqual([idx, idx + "Agents".length]);
  });

  it("protects multi-character Chinese words so a split never lands mid-word", () => {
    const spans = findProtectedSpans("范围，可能", []);
    // "范围" 与 "可能" 都是双字词，内部不应留下可切分点
    expect(spans.some(([s, e]) => e - s > 1)).toBe(true);
  });
});
