import { describe, expect, it } from "vitest";
import { PipelineArgsSchema, VideoSourcesSchema } from "./pipeline.js";

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

describe("VideoSourcesSchema", () => {
  it("accepts urls only", () => {
    const result = VideoSourcesSchema.parse({ urls: ["https://youtu.be/abc"] });
    expect(result.urls).toHaveLength(1);
  });

  it("rejects all-empty sources", () => {
    expect(() => VideoSourcesSchema.parse({ urls: [] })).toThrow(/必须提供/);
  });

  it("accepts url-file alone", () => {
    expect(() =>
      VideoSourcesSchema.parse({ urls: [], urlFile: "/tmp/urls.txt" }),
    ).not.toThrow();
  });

  it("rejects malformed url", () => {
    expect(() => VideoSourcesSchema.parse({ urls: ["not-a-url"] })).toThrow();
  });
});

describe("PipelineArgsSchema", () => {
  it("fills in stage defaults", () => {
    const parsed = PipelineArgsSchema.parse(baseInput);
    expect(parsed.stages.acquire).toBe("auto");
    expect(parsed.stages.notes).toBe("review");
    expect(parsed.stages.article).toBe("review");
    expect(parsed.stages.publish).toBe("review");
  });

  it("coerces numeric strings (CLI flags arrive as strings)", () => {
    const parsed = PipelineArgsSchema.parse({
      ...baseInput,
      acquire: { keyframes: "12", jobs: "5", sceneThreshold: "0.4", sceneMinGap: "8", maxWords: "1200" },
    });
    expect(parsed.acquire.keyframes).toBe(12);
    expect(parsed.acquire.jobs).toBe(5);
    expect(parsed.acquire.sceneThreshold).toBeCloseTo(0.4);
    expect(parsed.acquire.maxWords).toBe(1200);
  });

  it("defaults article targets to all three formats", () => {
    const parsed = PipelineArgsSchema.parse(baseInput);
    expect(parsed.article.targets).toEqual(["x-longform", "x-thread", "x-short"]);
  });

  it("parses article target combinations", () => {
    const parsed = PipelineArgsSchema.parse({
      ...baseInput,
      article: { targets: "x-thread,x-short" },
    });
    expect(parsed.article.targets).toEqual(["x-thread", "x-short"]);
  });

  it("rejects invalid article targets", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        article: { targets: "x-post" },
      }),
    ).toThrow(/Invalid --targets value/);
  });

  it("rejects unknown llm provider", () => {
    expect(() =>
      PipelineArgsSchema.parse({ ...baseInput, llm: { provider: "bard" } }),
    ).toThrow();
  });

  it("never echoes apiKey from defaults", () => {
    const parsed = PipelineArgsSchema.parse(baseInput);
    expect(parsed.llm.apiKey).toBeUndefined();
  });

  it("rejects keyframes < 0", () => {
    expect(() =>
      PipelineArgsSchema.parse({ ...baseInput, acquire: { keyframes: -1 } }),
    ).toThrow();
  });

  it("allows empty sources when --acquire skip", () => {
    const parsed = PipelineArgsSchema.parse({
      sources: { urls: [] },
      stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
      acquire: {},
      article: {},
      publish: {},
      control: {},
      llm: {},
      flags: {},
    });
    expect(parsed.stages.acquire).toBe("skip");
    expect(parsed.sources.urls).toHaveLength(0);
  });

  it("allows empty sources with --continue-from", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        sources: { urls: [] },
        stages: {},
        acquire: {},
        article: {},
        publish: {},
        control: { continueFlag: true },
        llm: {},
        flags: {},
      }),
    ).not.toThrow();
  });

  it("requires sources when acquire is not skip", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        sources: { urls: [] },
        stages: { acquire: "auto" },
        acquire: {},
        article: {},
        publish: {},
        control: {},
        llm: {},
        flags: {},
      }),
    ).toThrow(/必须提供/);
  });
});
