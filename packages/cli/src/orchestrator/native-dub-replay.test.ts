import { describe, expect, it } from "vitest";
import { executeDubReplay } from "./native-dub-replay.js";

describe("executeDubReplay", () => {
  it("refuses to run without a video id instead of guessing one", async () => {
    expect(await executeDubReplay({})).not.toBe(0);
  });

  it("reports missing artifacts as an input problem, pointing at the run that produces them", async () => {
    // 重放读的是 `yt2x dub` 留下的产物；没跑过就没有可重放的东西，这不是内部错误
    const exitCode = await executeDubReplay({
      videoId: "no-such-video",
      articleOutDir: "/tmp/yt2x-replay-does-not-exist",
    });
    expect(exitCode).not.toBe(0);
  });
});
