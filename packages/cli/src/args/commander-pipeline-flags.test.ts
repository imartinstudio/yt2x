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
  });
});
