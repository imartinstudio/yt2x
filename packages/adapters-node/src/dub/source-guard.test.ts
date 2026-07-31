import { describe, expect, it, vi } from "vitest";
import type { DetectBurnedSubtitlesResult } from "../acquire/detect-burned-subs.js";
import type { ProcessRunner } from "../process/index.js";
import {
  DubHardSubtitleError,
  assertNoChineseHardSubtitlesForDub,
  guardDubSourceAgainstHardSubtitles,
} from "./source-guard.js";

const chineseBurned = (): DetectBurnedSubtitlesResult => ({
  hasBurnedSubtitles: true,
  hasChineseBurnedSubtitles: true,
  shouldSkipBurn: true,
});

const clean = (): DetectBurnedSubtitlesResult => ({
  hasBurnedSubtitles: false,
  hasChineseBurnedSubtitles: false,
  shouldSkipBurn: false,
});

describe("assertNoChineseHardSubtitlesForDub", () => {
  it("rejects a source that already has Chinese hard subtitles", () => {
    expect(() => assertNoChineseHardSubtitlesForDub(chineseBurned())).toThrow(DubHardSubtitleError);
    expect(() => assertNoChineseHardSubtitlesForDub(chineseBurned())).toThrow(
      /hard subtitles|时间轴|unburned|未烧录/iu,
    );
  });

  it("allows a source without Chinese hard subtitles", () => {
    expect(() => assertNoChineseHardSubtitlesForDub(clean())).not.toThrow();
  });
});

describe("guardDubSourceAgainstHardSubtitles", () => {
  it("runs detection and refuses before callers can spend money or time", async () => {
    const detect = vi.fn(async () => chineseBurned());
    const runner = { run: vi.fn() } as unknown as ProcessRunner;

    await expect(
      guardDubSourceAgainstHardSubtitles("/tmp/source.mp4", runner, { detect }),
    ).rejects.toBeInstanceOf(DubHardSubtitleError);

    expect(detect).toHaveBeenCalledOnce();
    expect(detect.mock.calls[0]?.[0]).toBe("/tmp/source.mp4");
  });

  it("returns the detect result when the source is clean", async () => {
    const detect = vi.fn(async () => clean());
    const runner = { run: vi.fn() } as unknown as ProcessRunner;

    await expect(
      guardDubSourceAgainstHardSubtitles("/tmp/source.mp4", runner, { detect }),
    ).resolves.toEqual(clean());
  });
});
