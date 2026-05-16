import { describe, expect, it } from "vitest";
import {
  ArticleOutputTargetsSchema,
  parseArticleOutputTargets,
} from "./targets.js";

describe("parseArticleOutputTargets", () => {
  it("defaults to x-longform", () => {
    expect(parseArticleOutputTargets(undefined)).toEqual(["x-longform"]);
    expect(parseArticleOutputTargets("")).toEqual(["x-longform"]);
  });

  it("parses comma-separated targets", () => {
    expect(parseArticleOutputTargets("x-thread,x-short")).toEqual(["x-thread", "x-short"]);
  });

  it("expands all to every concrete target", () => {
    expect(parseArticleOutputTargets("all")).toEqual(["x-longform", "x-thread", "x-short"]);
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
      "x-longform",
      "x-short",
      "x-thread",
    ]);
  });
});
