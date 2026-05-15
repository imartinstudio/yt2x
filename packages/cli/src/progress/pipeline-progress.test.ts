import { describe, expect, it } from "vitest";
import {
  buildPipelineTimingsPayload,
  countPipelineProgressUnits,
  estimatePipelineVideoCount,
  formatProgressBar,
} from "./pipeline-progress.js";
import { PipelineArgsSchema } from "../args/pipeline.js";

const baseInput = {
  sources: { urls: ["https://www.youtube.com/watch?v=abc"] },
  stages: {},
  acquire: {},
  article: {},
  publish: {},
  control: {},
  llm: {},
  flags: {},
};

describe("formatProgressBar", () => {
  it("renders percent and blocks", () => {
    expect(formatProgressBar(50, 10)).toBe("[█████░░░░░] 50%");
    expect(formatProgressBar(100, 4)).toBe("[████] 100%");
  });

  it("accepts fractional percent for smooth bar width", () => {
    expect(formatProgressBar(14.3, 10)).toBe("[█░░░░░░░░░] 14%");
  });
});

describe("estimatePipelineVideoCount", () => {
  it("uses url list or search suffix count", () => {
    const urlsOnly = PipelineArgsSchema.parse({
      ...baseInput,
      sources: { urls: ["https://youtu.be/a", "https://youtu.be/b"] },
    });
    expect(estimatePipelineVideoCount(urlsOnly)).toBe(2);

    const search = PipelineArgsSchema.parse({
      ...baseInput,
      sources: { search: "AI Coding:5" },
    });
    expect(estimatePipelineVideoCount(search)).toBe(5);
  });
});

describe("buildPipelineTimingsPayload", () => {
  it("builds sorted ms/sec maps and wall total", () => {
    const timings = new Map([
      ["notes", 9500],
      ["acquire.x.metadata", 10700],
    ]);
    const payload = buildPipelineTimingsPayload("pipeline", timings, performance.now() - 20_000);
    expect(payload.command).toBe("pipeline");
    expect(payload.timingsMs).toEqual({
      "acquire.x.metadata": 10700,
      notes: 9500,
    });
    expect(payload.timingsSec).toEqual({
      "acquire.x.metadata": 10.7,
      notes: 9.5,
    });
    expect(payload.stepCount).toBe(2);
    expect(payload.totalMs).toBeGreaterThanOrEqual(19_000);
    expect(payload.totalSec).toBeGreaterThanOrEqual(19);
  });
});

describe("countPipelineProgressUnits", () => {
  it("counts acquire sub-steps and llm stages per video", () => {
    const args = PipelineArgsSchema.parse({
      ...baseInput,
      sources: { urls: ["https://youtu.be/a", "https://youtu.be/b"] },
      stages: { acquire: "auto", notes: "auto", article: "auto", publish: "skip" },
      acquire: { keyframes: 0 },
    });
    expect(countPipelineProgressUnits(args, 2)).toBe(4 * 2 + 2 + 2);
  });
});
