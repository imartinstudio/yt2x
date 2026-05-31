import { describe, expect, it } from "vitest";
import {
  ArticleOutputTargetsSchema,
  parseArticleOutputTargets,
} from "./targets.js";

describe("parseArticleOutputTargets", () => {
  it("defaults to article", () => {
    expect(parseArticleOutputTargets(undefined)).toEqual(["article"]);
    expect(parseArticleOutputTargets("")).toEqual(["article"]);
  });

  it("parses comma-separated targets", () => {
    expect(parseArticleOutputTargets("x-thread,x-short")).toEqual(["x-thread", "x-short"]);
  });

  it("expands all to every concrete target", () => {
    expect(parseArticleOutputTargets("all")).toEqual(["article", "x-thread", "x-short", "x-video-short"]);
  });

  it("maps legacy x-longform to article", () => {
    expect(parseArticleOutputTargets("x-longform,x-short,article")).toEqual([
      "article",
      "x-short",
    ]);
  });

  it("deduplicates repeated targets while preserving order", () => {
    expect(parseArticleOutputTargets("x-thread,x-short,x-thread")).toEqual([
      "x-thread",
      "x-short",
    ]);
  });

  it("rejects invalid targets with a clear error", () => {
    expect(() => parseArticleOutputTargets("x-post")).toThrow(/Invalid --targets value/);
  });

  it("works through the zod schema", () => {
    expect(ArticleOutputTargetsSchema.parse(["x-longform,x-short", "x-thread"])).toEqual([
      "article",
      "x-short",
      "x-thread",
    ]);
  });
});
