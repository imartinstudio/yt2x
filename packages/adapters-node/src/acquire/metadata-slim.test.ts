import { describe, expect, it } from "vitest";
import { slimVideoMetadata } from "./metadata-slim.js";

describe("slimVideoMetadata", () => {
  it("drops heavy yt-dlp arrays but keeps title and duration", () => {
    const slim = slimVideoMetadata({
      id: "abc",
      title: "T",
      duration: 120,
      formats: [{ url: "x" }],
      thumbnails: [{ url: "y" }],
      automatic_captions: { en: [] },
    });
    expect(slim.title).toBe("T");
    expect(slim.duration).toBe(120);
    expect(slim.formats).toBeUndefined();
    expect(slim.thumbnails).toBeUndefined();
  });
});
