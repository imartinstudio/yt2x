import { describe, expect, it } from "vitest";
import { cleanTranscriptLines, transcriptToChunksMarkdown } from "./clean-chunk-transcript.js";

const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:03,000
Hello there

2
00:00:04,000 --> 00:00:06,000
General Kenobi

WEBVTT
`;

describe("cleanTranscriptLines", () => {
  it("strips timing lines and WEBVTT header noise", () => {
    const lines = cleanTranscriptLines(SAMPLE_SRT);
    expect(lines).toEqual(["Hello there", "General Kenobi"]);
  });
});

describe("transcriptToChunksMarkdown", () => {
  it("produces chunk headers with word counts", () => {
    const md = transcriptToChunksMarkdown(SAMPLE_SRT, 900);
    expect(md).toContain("# Cleaned Transcript Chunks");
    expect(md).toMatch(/## Chunk 1 \(\d+ words\)/);
    expect(md).toContain("Hello there");
    expect(md).toContain("General Kenobi");
  });

  it("rejects maxWords below 100", () => {
    expect(() => transcriptToChunksMarkdown("x", 50)).toThrow(/at least 100/);
  });
});
