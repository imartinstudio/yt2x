import { describe, expect, it } from "vitest";
import {
  parseSearchQuery,
  resolveSearchFetchCount,
  sortSearchResults,
  type SearchResult,
} from "./search.js";

const row = (url: string, views: number | null): SearchResult => ({
  url,
  title: url,
  channel: "ch",
  duration: 100,
  viewCount: views,
});

describe("parseSearchQuery", () => {
  it("parses keywords:count", () => {
    expect(parseSearchQuery("AI Coding:2")).toEqual({ keywords: "AI Coding", count: 2 });
  });

  it("defaults count to 3", () => {
    expect(parseSearchQuery("AI Coding")).toEqual({ keywords: "AI Coding", count: 3 });
  });
});

describe("resolveSearchFetchCount", () => {
  it("uses pool size for views sort", () => {
    expect(resolveSearchFetchCount(2, "views")).toBe(20);
    expect(resolveSearchFetchCount(10, "views")).toBe(50);
  });

  it("uses take count when no sort", () => {
    expect(resolveSearchFetchCount(2, undefined)).toBe(2);
  });
});

describe("sortSearchResults", () => {
  it("sorts by view count desc and takes top N", () => {
    const input = [
      row("https://youtu.be/a", 100),
      row("https://youtu.be/b", 9_000),
      row("https://youtu.be/c", 500),
    ];
    const out = sortSearchResults(input, "views", 2);
    expect(out.map((r) => r.url)).toEqual(["https://youtu.be/b", "https://youtu.be/c"]);
  });

  it("keeps yt-dlp order when sort is undefined", () => {
    const input = [row("https://youtu.be/a", 1), row("https://youtu.be/b", 2)];
    expect(sortSearchResults(input, undefined, 1).map((r) => r.url)).toEqual(["https://youtu.be/a"]);
  });
});
