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
    expect(parsed.article.targets).toEqual(["article", "x-thread", "x-short", "x-video-short"]);
    expect(parsed.acquire.downloadVideo).toBe(true);
    expect(parsed.acquire.subtitleZh).toBe("off");
    expect(parsed.acquire.subtitleSourceLang).toBe("en");
    expect(parsed.acquire.subtitleTargetLang).toBe("zh-CN");
    expect(parsed.acquire.subtitleSource).toBe("auto");
    expect(parsed.acquire.subtitleFile).toBeUndefined();
    expect(parsed.publish.format).toBe("article");
    expect(parsed.publish.maxChars).toBe(500);
    expect(parsed.publish.maxTweets).toBe(8);
    expect(parsed.publish.threadDelay).toBe("20-30");
  });

  it("preserves publish thread delay config", () => {
    const parsed = PipelineArgsSchema.parse({
      ...baseInput,
      publish: { threadDelay: "5-9" },
    });
    expect(parsed.publish.threadDelay).toBe("5-9");
  });

  it("parses article target combinations", () => {
    const parsed = PipelineArgsSchema.parse({
      ...baseInput,
      article: { targets: "x-thread,x-short" },
    });
    expect(parsed.article.targets).toEqual(["x-thread", "x-short"]);
  });

  it("defaults platform article targets to none", () => {
    const parsed = PipelineArgsSchema.parse(baseInput);
    expect(parsed.article.platformTargets).toEqual([]);
  });

  it("parses platform article target combinations", () => {
    const parsed = PipelineArgsSchema.parse({
      ...baseInput,
      article: { platformTargets: "xiaohongshu,wechat" },
    });
    expect(parsed.article.platformTargets).toEqual(["xiaohongshu", "wechat"]);
  });

  it("rejects invalid platform article targets", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        article: { platformTargets: "douyin" },
      }),
    ).toThrow(/Invalid --platform-targets value/);
  });

  it("rejects invalid article targets", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        article: { targets: "x-post" },
      }),
    ).toThrow(/Invalid --targets value/);
  });

  it("rejects thread maxTweets above ten", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        publish: { maxTweets: 11 },
      }),
    ).toThrow();
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

  it("allows disabling default video download", () => {
    const parsed = PipelineArgsSchema.parse({
      ...baseInput,
      acquire: { downloadVideo: false },
    });
    expect(parsed.acquire.downloadVideo).toBe(false);
  });

  it("parses subtitle options", () => {
    const parsed = PipelineArgsSchema.parse({
      ...baseInput,
      acquire: {
        subtitleZh: "burned",
        subtitleSourceLang: "en-US",
        subtitleTargetLang: "zh-CN",
        subtitleSource: "file",
        subtitleFile: "/tmp/source.srt",
      },
    });
    expect(parsed.acquire.subtitleZh).toBe("burned");
    expect(parsed.acquire.subtitleSourceLang).toBe("en-US");
    expect(parsed.acquire.subtitleTargetLang).toBe("zh-CN");
    expect(parsed.acquire.subtitleSource).toBe("file");
    expect(parsed.acquire.subtitleFile).toBe("/tmp/source.srt");
  });

  it("rejects invalid subtitle mode", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        acquire: { subtitleZh: "hard" },
      }),
    ).toThrow();
  });

  it("requires subtitle file only with file source", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        acquire: { subtitleSource: "file" },
      }),
    ).toThrow(/subtitle-file/);
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        acquire: { subtitleFile: "/tmp/source.srt" },
      }),
    ).toThrow(/subtitle-source file/);
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

  it("defaults subtitleBilingual to off and subtitleBurnStyle to zh-default", () => {
    const parsed = PipelineArgsSchema.parse(baseInput);
    expect(parsed.acquire.subtitleBilingual).toBe("off");
    expect(parsed.acquire.subtitleBurnStyle).toBe("zh-default");
  });

  it("accepts valid subtitleBilingual modes when subtitleZh is enabled", () => {
    for (const mode of ["off", "srt", "ass", "burned", "all"] as const) {
      const zhMode = mode === "off" ? "off" : "both";
      const parsed = PipelineArgsSchema.parse({
        ...baseInput,
        acquire: { subtitleZh: zhMode, subtitleBilingual: mode },
      });
      expect(parsed.acquire.subtitleBilingual).toBe(mode);
    }
  });

  it("rejects invalid subtitleBilingual mode", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        acquire: { subtitleBilingual: "png" },
      }),
    ).toThrow();
  });

  it("accepts zh-default subtitleBurnStyle without bilingual mode", () => {
    const parsed = PipelineArgsSchema.parse({
      ...baseInput,
      acquire: { subtitleBurnStyle: "zh-default" },
    });
    expect(parsed.acquire.subtitleBurnStyle).toBe("zh-default");
  });

  it("accepts bilingual-explainer style with subtitleBilingual enabled", () => {
    const parsed = PipelineArgsSchema.parse({
      ...baseInput,
      acquire: {
        subtitleZh: "both",
        subtitleBilingual: "all",
        subtitleBurnStyle: "bilingual-explainer",
      },
    });
    expect(parsed.acquire.subtitleBurnStyle).toBe("bilingual-explainer");
    expect(parsed.acquire.subtitleBilingual).toBe("all");
  });

  it("rejects invalid subtitleBurnStyle", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        acquire: { subtitleBurnStyle: "zh-yellow" },
      }),
    ).toThrow();
  });

  it("rejects bilingual-explainer style when subtitleBilingual is off", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        acquire: {
          subtitleBurnStyle: "bilingual-explainer",
        },
      }),
    ).toThrow(/bilingual-explainer/);
  });

  it("rejects subtitleBilingual without subtitleZh", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        acquire: {
          subtitleZh: "off",
          subtitleBilingual: "all",
        },
      }),
    ).toThrow(/subtitle-zh/);
  });

  it("accepts bilingual-explainer with subtitleBilingual enabled", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        acquire: {
          subtitleZh: "both",
          subtitleBilingual: "all",
          subtitleBurnStyle: "bilingual-explainer",
        },
      }),
    ).not.toThrow();
  });

  it("accepts subtitleBilingual srt with subtitleZh srt", () => {
    expect(() =>
      PipelineArgsSchema.parse({
        ...baseInput,
        acquire: {
          subtitleZh: "srt",
          subtitleBilingual: "srt",
        },
      }),
    ).not.toThrow();
  });
});
