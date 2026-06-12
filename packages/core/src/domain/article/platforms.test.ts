import { describe, expect, it } from "vitest";
import {
  getPlatformArticleSpec,
  parsePlatformArticleTargets,
  PlatformArticleTargetsSchema,
  PLATFORM_ARTICLE_SPECS,
  PLATFORM_ARTICLE_TARGETS,
} from "./platforms.js";

describe("PLATFORM_ARTICLE_SPECS", () => {
  it("defines the first cross-platform targets without changing X target parsing", () => {
    expect(PLATFORM_ARTICLE_TARGETS).toEqual(["xiaohongshu", "wechat", "bilibili"]);
  });

  it("captures the confirmed non-default choices", () => {
    expect(PLATFORM_ARTICLE_SPECS.xiaohongshu.tone).toContain("种草型");
    expect(PLATFORM_ARTICLE_SPECS.xiaohongshu.tags).toEqual({
      enabled: true,
      min: 3,
      max: 5,
    });
    expect(PLATFORM_ARTICLE_SPECS.bilibili.tone).toContain("强冲突");
  });

  it("keeps every platform source-bound to article by default", () => {
    for (const target of PLATFORM_ARTICLE_TARGETS) {
      const spec = getPlatformArticleSpec(target);
      expect(spec.source).toBe("article");
      expect(spec.sourcePolicy).toBe("source-only");
      expect(spec.adaptationMode).toBe("preserve-claims");
      expect(spec.outputs.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("parsePlatformArticleTargets", () => {
  it("defaults to no platform adaptations", () => {
    expect(parsePlatformArticleTargets(undefined)).toEqual([]);
    expect(parsePlatformArticleTargets("")).toEqual([]);
  });

  it("parses comma-separated platform targets", () => {
    expect(parsePlatformArticleTargets("xiaohongshu,wechat")).toEqual(["xiaohongshu", "wechat"]);
  });

  it("expands all-platforms", () => {
    expect(parsePlatformArticleTargets("all-platforms")).toEqual(["xiaohongshu", "wechat", "bilibili"]);
  });

  it("deduplicates repeated platform targets while preserving order", () => {
    expect(parsePlatformArticleTargets("wechat,xiaohongshu,wechat")).toEqual(["wechat", "xiaohongshu"]);
  });

  it("rejects invalid platform targets with a clear error", () => {
    expect(() => parsePlatformArticleTargets("douyin")).toThrow(/Invalid --platform-targets value/);
  });

  it("works through the zod schema", () => {
    expect(PlatformArticleTargetsSchema.parse(["xiaohongshu,wechat", "bilibili"])).toEqual([
      "xiaohongshu",
      "wechat",
      "bilibili",
    ]);
  });
});
