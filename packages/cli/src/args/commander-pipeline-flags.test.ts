import { describe, expect, it } from "vitest";
import { parseCommanderPipelineFlags } from "./commander-pipeline-flags.js";

describe("parseCommanderPipelineFlags", () => {
  it("maps continueFrom to control.continueFlag", () => {
    const args = parseCommanderPipelineFlags({
      urls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      continueFrom: true,
    });
    expect(args.control.continueFlag).toBe(true);
  });

  it("maps force to control.force", () => {
    const args = parseCommanderPipelineFlags({
      urls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      force: true,
    });
    expect(args.control.force).toBe(true);
  });

  it("defaults stages to acquire auto and notes/article/publish review", () => {
    const args = parseCommanderPipelineFlags({
      urls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    });
    expect(args.stages.acquire).toBe("auto");
    expect(args.stages.notes).toBe("review");
    expect(args.stages.article).toBe("review");
    expect(args.stages.publish).toBe("review");
    expect(args.acquire.keyframes).toBe(0);
    expect(args.acquire.downloadVideo).toBe(true);
    expect(args.publish.format).toBe("article");
    expect(args.publish.maxChars).toBe(500);
    expect(args.publish.maxTweets).toBe(8);
    expect(args.publish.threadDelay).toBe("20-30");
  });

  it("maps threadDelay to publish options", () => {
    const args = parseCommanderPipelineFlags({
      urls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      threadDelay: "3-5",
    });
    expect(args.publish.threadDelay).toBe("3-5");
  });

  it("maps article targets", () => {
    const args = parseCommanderPipelineFlags({
      urls: ["https://example.com/video"],
      targets: "all",
    });
    expect(args.article.targets).toEqual(["article", "x-thread", "x-short", "x-video-short"]);
  });

  it("maps platform article targets", () => {
    const args = parseCommanderPipelineFlags({
      urls: ["https://example.com/video"],
      platformTargets: "all-platforms",
    });
    expect(args.article.platformTargets).toEqual(["xiaohongshu", "wechat", "bilibili"]);
  });

  it("maps video download options and auto-enables download for manual ranges", () => {
    const args = parseCommanderPipelineFlags({
      urls: ["https://example.com/video"],
      videoStart: "00:01:00",
      videoEnd: "00:01:30",
      videoDuration: "45",
    });
    expect(args.acquire.downloadVideo).toBe(true);
    expect(args.acquire.videoOnly).toBe(false);
    expect(args.acquire.videoStart).toBe("00:01:00");
    expect(args.acquire.videoEnd).toBe("00:01:30");
    expect(args.acquire.videoDuration).toBe(45);
  });

  it("maps subtitle options", () => {
    const args = parseCommanderPipelineFlags({
      urls: ["https://example.com/video"],
      subtitleZh: "both",
      subtitleSourceLang: "en",
      subtitleTargetLang: "zh-CN",
      subtitleSource: "file",
      subtitleFile: "/tmp/source.vtt",
    });
    expect(args.acquire.subtitleZh).toBe("both");
    expect(args.acquire.subtitleSourceLang).toBe("en");
    expect(args.acquire.subtitleTargetLang).toBe("zh-CN");
    expect(args.acquire.subtitleSource).toBe("file");
    expect(args.acquire.subtitleFile).toBe("/tmp/source.vtt");
  });

  it("supports opting out of the default video download", () => {
    const args = parseCommanderPipelineFlags({
      urls: ["https://example.com/video"],
      downloadVideo: false,
    });
    expect(args.acquire.downloadVideo).toBe(false);
  });

  it("rejects video-only on pipeline args", () => {
    expect(() =>
      parseCommanderPipelineFlags({
        urls: ["https://example.com/video"],
        videoOnly: true,
      }),
    ).toThrow(/video-only/);
  });
});
