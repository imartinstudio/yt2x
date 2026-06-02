import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { burnZhSubtitlesForVideo } from "./burn-zh-subtitles-for-video.js";
import type { ProcessRunner } from "../process/index.js";

vi.mock("./detect-burned-subs.js", () => ({
  detectBurnedSubtitles: vi.fn(),
}));

vi.mock("./burn-subtitles.js", () => ({
  burnSubtitles: vi.fn().mockResolvedValue(undefined),
}));

import { detectBurnedSubtitles } from "./detect-burned-subs.js";
import { burnSubtitles } from "./burn-subtitles.js";

const runner: ProcessRunner = {
  run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
};

describe("burnZhSubtitlesForVideo", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      process.cwd(),
      "files",
      "downloads",
      `burn-test-${Date.now()}`,
    );
    const videoSub = path.join(tmpDir, "video");
    await mkdir(videoSub, { recursive: true });
    await writeFile(path.join(videoSub, "full.zh.srt"), "1\n00:00:00,000 --> 00:00:01,000\n测试\n");
    await writeFile(path.join(videoSub, "full.mp4"), "fake");
    vi.mocked(detectBurnedSubtitles).mockReset();
    vi.mocked(burnSubtitles).mockClear();
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("skips burn when Chinese hard subs are detected", async () => {
    vi.mocked(detectBurnedSubtitles).mockResolvedValue({
      hasBurnedSubtitles: true,
      hasChineseBurnedSubtitles: true,
      shouldSkipBurn: true,
    });

    const result = await burnZhSubtitlesForVideo({
      videoDir: tmpDir,
      runner,
      skipIfChineseBurned: true,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("chinese_burned_detected");
    expect(burnSubtitles).not.toHaveBeenCalled();
  });

  it("burns when detection is disabled", async () => {
    const result = await burnZhSubtitlesForVideo({
      videoDir: tmpDir,
      runner,
      skipIfChineseBurned: false,
    });

    expect(result.burned).toBe(true);
    expect(detectBurnedSubtitles).not.toHaveBeenCalled();
    expect(burnSubtitles).toHaveBeenCalled();
  });
});
