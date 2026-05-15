import { describe, expect, it } from "vitest";
import {
  articleToLongPost,
  articleToThread,
  splitToChunks,
  stripMarkdown,
  threadNumber,
  truncateToWeightedLength,
  tweetLength,
} from "./thread.js";

describe("tweetLength", () => {
  it("counts ASCII as 1 each", () => {
    expect(tweetLength("abc")).toBe(3);
    expect(tweetLength("hello world")).toBe(11);
  });

  it("counts CJK characters as 2 each (X weighted length)", () => {
    expect(tweetLength("中文")).toBe(4);
    expect(tweetLength("你好")).toBe(4);
    expect(tweetLength("日本語")).toBe(6);
    expect(tweetLength("한국어")).toBe(6);
  });

  it("counts mixed text correctly", () => {
    expect(tweetLength("Hello世界")).toBe(9); // 5 ASCII + 2 CJK*2
    expect(tweetLength("a中文b")).toBe(6); // 2 ASCII + 2 CJK*2
    expect(tweetLength("🚀")).toBe(1);
    expect(tweetLength("a🚀b")).toBe(3);
  });

  it("counts fullwidth punctuation as 2", () => {
    expect(tweetLength("：")).toBe(2);
    expect(tweetLength("。")).toBe(2);
  });
});

describe("threadNumber", () => {
  it("returns circled glyphs for 0-19", () => {
    expect(threadNumber(0)).toBe("①");
    expect(threadNumber(14)).toBe("⑮");
    expect(threadNumber(19)).toBe("⑳");
  });
  it("falls back to parenthesized N+1 from index 20 onward", () => {
    expect(threadNumber(20)).toBe("(21)");
    expect(threadNumber(99)).toBe("(100)");
  });
});

describe("stripMarkdown", () => {
  it("removes images and link wrappers, keeps link text", () => {
    expect(stripMarkdown("![alt](x.jpg) keep [link](http://e.com) text")).toBe("keep link text");
  });
  it("strips heading hashes", () => {
    expect(stripMarkdown("# H1\n## H2 sub\ntext")).toBe("H1\nH2 sub\ntext");
  });
  it("removes inline emphasis chars", () => {
    expect(stripMarkdown("*bold* _ital_ `code` >quote")).toBe("bold ital code quote");
  });
  it("converts bullets to •", () => {
    expect(stripMarkdown("- a\n- b")).toBe("• a\n• b");
  });
  it("drops fenced code blocks entirely", () => {
    expect(stripMarkdown("before\n```\nx=1\ny=2\n```\nafter")).toBe("before\n\nafter");
  });
  it("collapses 3+ newlines to 2", () => {
    expect(stripMarkdown("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("splitToChunks", () => {
  it("returns [text] when within maxChars", () => {
    expect(splitToChunks("hello world", 100)).toEqual(["hello world"]);
  });
  it("splits at sentence boundaries (Chinese 。)", () => {
    const text = "第一句很短。第二句也短。第三句一样短。";
    const chunks = splitToChunks(text, 14);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(tweetLength(c)).toBeLessThanOrEqual(14);
  });
  it("hard-cuts a single sentence longer than maxChars (no infinite loop)", () => {
    const text = "a".repeat(50);
    const chunks = splitToChunks(text, 10);
    expect(chunks).toHaveLength(5);
    expect(chunks.every((c) => c.length === 10)).toBe(true);
  });
  it("returns [] for empty / whitespace input", () => {
    expect(splitToChunks("", 10)).toEqual([]);
    expect(splitToChunks("   \n  ", 10)).toEqual([]);
  });
  it("throws on non-positive maxChars", () => {
    expect(() => splitToChunks("x", 0)).toThrow();
    expect(() => splitToChunks("x", -1)).toThrow();
  });
});

describe("truncateToWeightedLength", () => {
  it("truncates by weighted length for CJK", () => {
    const text = "中".repeat(200);
    const out = truncateToWeightedLength(text, 10);
    expect(tweetLength(out)).toBeLessThanOrEqual(10);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("articleToLongPost", () => {
  it("returns stripped markdown as one body", () => {
    const post = articleToLongPost("# Title\n\nHello **world**.");
    expect(post).toContain("Hello world");
    expect(post).not.toContain("**");
  });

  it("truncates to weighted maxChars", () => {
    const long = "中".repeat(500);
    const post = articleToLongPost(long, { maxChars: 20 });
    expect(tweetLength(post)).toBeLessThanOrEqual(20);
  });
});

describe("articleToThread", () => {
  it("returns [] for empty / whitespace-only article", () => {
    expect(articleToThread("")).toEqual([]);
    expect(articleToThread("   \n  ")).toEqual([]);
  });

  it("treats short article as single tweet", () => {
    expect(articleToThread("Hello world")).toEqual(["Hello world"]);
  });

  it("splits long paragraph into multiple tweets respecting maxChars", () => {
    const long = "句子一。".repeat(50);
    const thread = articleToThread(long, { maxChars: 50 });
    expect(thread.length).toBeGreaterThan(1);
    for (const t of thread) expect(tweetLength(t)).toBeLessThanOrEqual(50);
  });

  it("preserves paragraph order across blank-line splits", () => {
    const article = "段落一段落一段落一段落一段落一。\n\n段落二段落二段落二段落二段落二。\n\n段落三段落三段落三段落三段落三。";
    const thread = articleToThread(article, { maxChars: 280 });
    expect(thread[0]).toContain("段落一");
    expect(thread[1]).toContain("段落二");
    expect(thread[2]).toContain("段落三");
  });

  it("filters out paragraphs shorter than 11 chars", () => {
    const article = "短。\n\n这是一段足够长的段落，会被保留下来。";
    const thread = articleToThread(article);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toContain("足够长");
  });

  it("deduplicates near-identical paragraphs by first 30 chars (lowercase)", () => {
    const article = "Same headline content here repeats.\n\nSame headline content here repeats.";
    const thread = articleToThread(article);
    expect(thread).toHaveLength(1);
  });

  it("caps total tweets to maxTweets", () => {
    const article = Array.from({ length: 50 }, (_, i) => `Paragraph number ${i} is here.`).join("\n\n");
    const thread = articleToThread(article, { maxTweets: 5 });
    expect(thread).toHaveLength(5);
  });

  it("prepends circled numbers when numbering is true and respects maxChars", () => {
    const article = "段一段一段一段一段一。\n\n段二段二段二段二段二。";
    const thread = articleToThread(article, { numbering: true, maxChars: 280 });
    expect(thread[0]?.startsWith("① ")).toBe(true);
    expect(thread[1]?.startsWith("② ")).toBe(true);
    for (const t of thread) expect(tweetLength(t)).toBeLessThanOrEqual(280);
  });

});
