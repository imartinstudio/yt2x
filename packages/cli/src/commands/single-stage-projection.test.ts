import { describe, expect, it } from "vitest";
import { projectSingleStage, toStageMode } from "./single-stage-projection.js";

describe("toStageMode", () => {
  it("returns fallback when raw is undefined", () => {
    expect(toStageMode(undefined, "skip")).toBe("skip");
  });

  it("accepts valid modes", () => {
    expect(toStageMode("review", "auto")).toBe("review");
  });

  it("throws on invalid mode", () => {
    expect(() => toStageMode("bogus", "auto")).toThrow(/Invalid --mode/);
  });
});

describe("projectSingleStage", () => {
  it("sets only acquire to auto and others to skip", () => {
    const args = projectSingleStage("acquire", {
      urls: ["https://www.youtube.com/watch?v=abc12345678"],
    });
    expect(args.stages.acquire).toBe("auto");
    expect(args.stages.notes).toBe("skip");
    expect(args.stages.article).toBe("skip");
    expect(args.stages.publish).toBe("skip");
  });

  it("honors --mode for the target stage", () => {
    const args = projectSingleStage("notes", {
      urls: ["https://www.youtube.com/watch?v=abc12345678"],
      mode: "review",
    });
    expect(args.stages.notes).toBe("review");
    expect(args.stages.acquire).toBe("skip");
  });

  it("maps continueFrom to control.continueFlag", () => {
    const args = projectSingleStage("acquire", {
      urls: ["https://www.youtube.com/watch?v=abc12345678"],
      continueFrom: true,
    });
    expect(args.control.continueFlag).toBe(true);
  });

  it("maps article targets for single-stage commands", () => {
    const args = projectSingleStage("article", {
      urls: ["https://example.com/video"],
      targets: "x-thread,x-short",
    });
    expect(args.article.targets).toEqual(["x-thread", "x-short"]);
  });

  it("maps legacy x-longform to article for single-stage commands", () => {
    const args = projectSingleStage("article", {
      urls: ["https://example.com/video"],
      targets: "x-longform,x-short",
    });
    expect(args.article.targets).toEqual(["article", "x-short"]);
  });

  it("maps threadDelay for publish single-stage commands", () => {
    const args = projectSingleStage("publish", {
      urls: ["https://example.com/video"],
      threadDelay: "12-18",
    });
    expect(args.publish.threadDelay).toBe("12-18");
  });
});
