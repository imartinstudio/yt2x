import { describe, expect, it } from "vitest";
import { formatMsToSrtTimestamp, parseSrtTimestampToMs } from "./srt-time.js";

describe("parseSrtTimestampToMs", () => {
  it("parses HH:MM:SS,mmm", () => {
    expect(parseSrtTimestampToMs("00:01:02,500")).toBe(62_500);
    expect(parseSrtTimestampToMs("01:00:00,000")).toBe(3_600_000);
  });

  it("parses MM:SS,mmm without the hour field", () => {
    expect(parseSrtTimestampToMs("01:02,500")).toBe(62_500);
  });

  it("accepts a dot as the decimal separator", () => {
    expect(parseSrtTimestampToMs("00:00:01.250")).toBe(1_250);
  });

  it("right-pads the millisecond field instead of reading it as a plain number", () => {
    // ",5" is half a second, not 5 milliseconds
    expect(parseSrtTimestampToMs("00:00:01,5")).toBe(1_500);
    expect(parseSrtTimestampToMs("00:00:01,05")).toBe(1_050);
    expect(parseSrtTimestampToMs("00:00:01,005")).toBe(1_005);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseSrtTimestampToMs("  00:00:02,000 ")).toBe(2_000);
  });

  it("returns NaN for malformed input", () => {
    expect(parseSrtTimestampToMs("")).toBeNaN();
    expect(parseSrtTimestampToMs("not a timestamp")).toBeNaN();
    expect(parseSrtTimestampToMs("00:00:01")).toBeNaN();
    expect(parseSrtTimestampToMs("00:00:1,000")).toBeNaN();
    expect(parseSrtTimestampToMs("00:00:01,1234")).toBeNaN();
  });
});

describe("formatMsToSrtTimestamp", () => {
  it("formats with zero padding", () => {
    expect(formatMsToSrtTimestamp(0)).toBe("00:00:00,000");
    expect(formatMsToSrtTimestamp(62_500)).toBe("00:01:02,500");
    expect(formatMsToSrtTimestamp(3_661_001)).toBe("01:01:01,001");
  });

  it("round-trips with parseSrtTimestampToMs", () => {
    for (const ms of [0, 999, 1_500, 62_500, 3_661_001, 7_322_123]) {
      expect(parseSrtTimestampToMs(formatMsToSrtTimestamp(ms))).toBe(ms);
    }
  });

  it("clamps negative input to zero", () => {
    expect(formatMsToSrtTimestamp(-1)).toBe("00:00:00,000");
    expect(formatMsToSrtTimestamp(-9_999)).toBe("00:00:00,000");
  });

  it("rounds fractional milliseconds", () => {
    expect(formatMsToSrtTimestamp(1_500.6)).toBe("00:00:01,501");
  });
});
