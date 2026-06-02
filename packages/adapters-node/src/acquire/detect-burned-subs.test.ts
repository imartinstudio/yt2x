import { describe, expect, it, vi } from "vitest";
import { detectBurnedSubtitles } from "./detect-burned-subs.js";
import type { ProcessRunner } from "../process/index.js";

const runnerWithStdout = (stdout: string): ProcessRunner => ({
  run: vi.fn().mockResolvedValue({ exitCode: 0, stdout, stderr: "" }),
});

describe("detectBurnedSubtitles", () => {
  it("skips burn only when shouldSkipBurn / Chinese burned subs are true", async () => {
    const result = await detectBurnedSubtitles(
      "/tmp/video.mp4",
      runnerWithStdout(
        JSON.stringify({
          hasBurnedSubtitles: true,
          hasChineseBurnedSubtitles: true,
          shouldSkipBurn: true,
          scores: [0.05, 0.06],
        }),
      ),
    );
    expect(result.shouldSkipBurn).toBe(true);
    expect(result.hasChineseBurnedSubtitles).toBe(true);
  });

  it("does not skip when only generic burned overlay is detected", async () => {
    const result = await detectBurnedSubtitles(
      "/tmp/video.mp4",
      runnerWithStdout(
        JSON.stringify({
          hasBurnedSubtitles: true,
          hasChineseBurnedSubtitles: false,
          shouldSkipBurn: false,
          scores: [0.05, 0.04],
        }),
      ),
    );
    expect(result.shouldSkipBurn).toBe(false);
    expect(result.hasBurnedSubtitles).toBe(true);
  });

  it("returns false when detection script fails", async () => {
    const runner: ProcessRunner = {
      run: vi.fn().mockRejectedValue(new Error("python3 missing")),
    };
    const result = await detectBurnedSubtitles("/tmp/video.mp4", runner);
    expect(result).toEqual({
      hasBurnedSubtitles: false,
      hasChineseBurnedSubtitles: false,
      shouldSkipBurn: false,
    });
  });
});
