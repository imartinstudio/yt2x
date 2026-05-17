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
    expect(args.article.targets).toEqual(["article", "x-thread", "x-short"]);
  });
});
