import { describe, expect, it } from "vitest";
import { normalizeYoutubeUrl, sanitizeVideoId, videoIdFromUrl } from "./video-id-from-url.js";

describe("sanitizeVideoId", () => {
  it("strips trailing backslash from malformed ids", () => {
    expect(sanitizeVideoId("4ByJZRP5oYI\\")).toBe("4ByJZRP5oYI");
  });
});

describe("videoIdFromUrl", () => {
  it("ignores backslash before query string", () => {
    expect(videoIdFromUrl("https://youtu.be/4ByJZRP5oYI\\?si=abc")).toBe("4ByJZRP5oYI");
  });

  it("normalizes watch URLs", () => {
    expect(videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
});

describe("normalizeYoutubeUrl", () => {
  it("removes escaped query delimiters", () => {
    expect(normalizeYoutubeUrl("https://youtu.be/4ByJZRP5oYI\\?si\\=x")).toBe(
      "https://youtu.be/4ByJZRP5oYI?si=x",
    );
  });
});
