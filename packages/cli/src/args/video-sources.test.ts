import { describe, expect, it } from "vitest";
import { hasVideoSources, VideoSourcesFieldsSchema } from "./video-sources.js";

describe("VideoSourcesFieldsSchema", () => {
  it("accepts urls only", () => {
    const result = VideoSourcesFieldsSchema.parse({ urls: ["https://youtu.be/abc"] });
    expect(result.urls).toHaveLength(1);
  });

  it("accepts url-file alone", () => {
    expect(() =>
      VideoSourcesFieldsSchema.parse({ urls: [], urlFile: "/tmp/urls.txt" }),
    ).not.toThrow();
  });

  it("rejects malformed url", () => {
    expect(() => VideoSourcesFieldsSchema.parse({ urls: ["not-a-url"] })).toThrow();
  });
});

describe("hasVideoSources", () => {
  it("returns true for urls only", () => {
    const sources = VideoSourcesFieldsSchema.parse({ urls: ["https://youtu.be/abc"] });
    expect(hasVideoSources(sources)).toBe(true);
  });

  it("returns false for all-empty sources", () => {
    const sources = VideoSourcesFieldsSchema.parse({ urls: [] });
    expect(hasVideoSources(sources)).toBe(false);
  });

  it("returns true for url-file alone", () => {
    const sources = VideoSourcesFieldsSchema.parse({ urls: [], urlFile: "/tmp/urls.txt" });
    expect(hasVideoSources(sources)).toBe(true);
  });
});
