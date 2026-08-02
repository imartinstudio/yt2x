import { describe, expect, it } from "vitest";
import {
  containsTermCaseInsensitive,
  DUB_TERM_TRANSLATIONS,
  findMissingProtectedTerms,
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

describe("findMissingProtectedTerms", () => {
  it("returns terms present in the English source but absent from the Chinese translation", () => {
    // 真实全片复现过的丢词："grill me skills" 出现在源文本，译文却整句漏掉了 "Grill Me"
    const enText =
      "And the first failure mode I see with the grill me skills is trying to answer high fidelity questions during a grilling session.";
    const zhText = "我见到的首个失败模式：在追问环节试图回答高保真问题。";
    expect(findMissingProtectedTerms(enText, zhText)).toEqual(["Grill Me"]);
  });

  it("returns an empty array when every present term survived into the translation", () => {
    const enText = "My grill me skills and grill with docs have been out there for a while now.";
    const zhText = "我的 Grill Me 技能和 Grill with Docs 已经发布一段时间了。";
    expect(findMissingProtectedTerms(enText, zhText)).toEqual([]);
  });

  it("does not report a term that never occurred in the English source", () => {
    expect(findMissingProtectedTerms("nothing relevant here", "无关内容")).toEqual([]);
  });
});

describe("DUB_TERM_TRANSLATIONS", () => {
  const lookup = (source: string): string | undefined =>
    DUB_TERM_TRANSLATIONS.find((t) => t.source === source)?.zh;

  it("locks the grill family to the 追问 (question relentlessly) reading, not 评审 (review)", () => {
    expect(lookup("grill")).toBe("追问");
    expect(lookup("grilling")).toBe("追问");
    expect(lookup("grilling session")).toBe("追问环节");
    expect(lookup("grillable")).toBe("可追问");
    expect(lookup("ungrillable")).toBe("不可追问");
  });

  it("locks fidelity to a single rendering instead of 保真/精确/精度 mixed across the film", () => {
    expect(lookup("fidelity")).toBe("保真度");
    expect(lookup("high fidelity")).toBe("高保真");
    expect(lookup("low fidelity")).toBe("低保真");
  });

  it("orders longer source phrases before the bare words they contain", () => {
    // "grilling session" 必须排在裸词 "grilling" 之前，否则提示词里读到裸词条目时
    // 模型可能提前套用短译法，看不到更具体的短语形式
    const grillingSessionIdx = DUB_TERM_TRANSLATIONS.findIndex(
      (t) => t.source === "grilling session",
    );
    const grillingIdx = DUB_TERM_TRANSLATIONS.findIndex((t) => t.source === "grilling");
    expect(grillingSessionIdx).toBeLessThan(grillingIdx);

    const highFidelityIdx = DUB_TERM_TRANSLATIONS.findIndex((t) => t.source === "high fidelity");
    const fidelityIdx = DUB_TERM_TRANSLATIONS.findIndex((t) => t.source === "fidelity");
    expect(highFidelityIdx).toBeLessThan(fidelityIdx);
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
