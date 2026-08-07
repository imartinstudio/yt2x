import { describe, expect, it } from "vitest";
import { buildPipelineTimingsPayload, formatProgressBar } from "./pipeline-progress.js";

describe("formatProgressBar", () => {
  it("renders percent and blocks", () => {
    expect(formatProgressBar(50, 10)).toBe("[█████░░░░░] 50%");
    expect(formatProgressBar(100, 4)).toBe("[████] 100%");
  });

  it("accepts fractional percent for smooth bar width", () => {
    expect(formatProgressBar(14.3, 10)).toBe("[█░░░░░░░░░] 14%");
  });
});

describe("buildPipelineTimingsPayload", () => {
  it("builds sorted ms/sec maps and wall total", () => {
    const timings = new Map([
      ["notes", 9500],
      ["article.x.draft", 10700],
    ]);
    const payload = buildPipelineTimingsPayload("notes", timings, performance.now() - 20_000);
    expect(payload.command).toBe("notes");
    expect(payload.timingsMs).toEqual({
      "article.x.draft": 10700,
      notes: 9500,
    });
    expect(payload.timingsSec).toEqual({
      "article.x.draft": 10.7,
      notes: 9.5,
    });
    expect(payload.stepCount).toBe(2);
    expect(payload.totalMs).toBeGreaterThanOrEqual(19_000);
    expect(payload.totalSec).toBeGreaterThanOrEqual(19);
  });
});
