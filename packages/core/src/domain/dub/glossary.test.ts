import { describe, expect, it } from "vitest";
import {
  containsTermCaseInsensitive,
  findPresentProtectedTerms,
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

describe("containsTermCaseInsensitive", () => {
  it("matches the lower-cased ASR transcript against the title-cased glossary entry", () => {
    // 真实转写稿是纯小写；术语表沿用 "Grill Me" 这种首字母大写拼写
    expect(containsTermCaseInsensitive("my grill me skills are great", "Grill Me")).toBe(true);
    expect(containsTermCaseInsensitive("grill with docs is also live", "Grill with Docs")).toBe(
      true,
    );
  });

  it("does not match an unrelated substring", () => {
    expect(containsTermCaseInsensitive("this has nothing to do with it", "Grill Me")).toBe(false);
  });
});

describe("findPresentProtectedTerms", () => {
  it("returns only the terms that actually occur in the source, case-insensitively", () => {
    const enText = "My grill me skills and grill with docs have been out there for a while now.";
    const present = findPresentProtectedTerms(enText, ["Grill Me", "Grill with Docs", "Codex"]);
    expect(present).toEqual(["Grill Me", "Grill with Docs"]);
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
