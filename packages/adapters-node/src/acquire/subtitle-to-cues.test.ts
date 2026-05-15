import { describe, expect, it } from "vitest";
import { cuesToMarkdown, parseSubtitleCues } from "./subtitle-to-cues.js";

const SAMPLE_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.500
Hello <b>world</b>

2
00:00:04,000 --> 00:00:06.000
Second line
`;

describe("parseSubtitleCues", () => {
  it("parses VTT timing and strips tags", () => {
    const cues = parseSubtitleCues(SAMPLE_VTT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({
      start: "00:00:01.000",
      end: "00:00:03.500",
      text: "Hello world",
    });
    expect(cues[1]!.text).toBe("Second line");
  });

  it("deduplicates consecutive identical cue text", () => {
    const dup = `WEBVTT

1
00:00:01.000 --> 00:00:02.000
Same

2
00:00:03.000 --> 00:00:04.000
Same
`;
    const cues = parseSubtitleCues(dup);
    expect(cues).toHaveLength(1);
  });
});

describe("cuesToMarkdown", () => {
  it("emits markdown list format", () => {
    const md = cuesToMarkdown([
      { start: "00:00:01.000", end: "00:00:02.000", text: "Hi" },
    ]);
    expect(md).toContain("# Timestamped Subtitle Cues");
    expect(md).toContain("- `00:00:01.000` - `00:00:02.000`: Hi");
  });
});
