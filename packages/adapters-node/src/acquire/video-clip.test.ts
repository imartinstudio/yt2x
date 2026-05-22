import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner, ProcessSpec } from "../process/index.js";
import {
  X_COMPATIBLE_VIDEO_FORMAT,
  downloadVideoClip,
  parseClipTimestamp,
  resolveClipRange,
  selectHottestClipRange,
} from "./video-clip.js";

describe("parseClipTimestamp", () => {
  it("parses seconds and clock formats", () => {
    expect(parseClipTimestamp("90")).toBe(90);
    expect(parseClipTimestamp("01:30")).toBe(90);
    expect(parseClipTimestamp("00:01:30")).toBe(90);
  });

  it("rejects invalid timestamps", () => {
    expect(() => parseClipTimestamp("bad")).toThrow(/invalid clip timestamp/);
    expect(() => parseClipTimestamp("1:bad")).toThrow(/invalid clip timestamp/);
  });
});

describe("resolveClipRange", () => {
  it("uses manual start and end when provided", () => {
    const range = resolveClipRange(
      { duration: 300 },
      { enabled: true, videoOnly: false, durationSeconds: 30, start: "01:00", end: "01:30" },
    );
    expect(range).toMatchObject({
      mode: "range",
      source: "user_range",
      startSeconds: 60,
      endSeconds: 90,
    });
  });

  it("uses manual start plus duration when end is omitted", () => {
    const range = resolveClipRange(
      { duration: 300 },
      { enabled: true, videoOnly: false, durationSeconds: 5, start: "01:00" },
    );
    expect(range).toMatchObject({
      mode: "range",
      source: "user_range",
      startSeconds: 60,
      endSeconds: 65,
    });
  });

  it("clamps manual start plus duration at the video end", () => {
    const range = resolveClipRange(
      { duration: 99 },
      { enabled: true, videoOnly: true, durationSeconds: 30, start: "00:01:12" },
    );
    expect(range).toMatchObject({
      mode: "range",
      source: "user_range",
      startSeconds: 72,
      endSeconds: 99,
      warnings: [
        "requested duration extends past video end; clamped range to 00:01:12-00:01:39",
      ],
    });
  });

  it("rejects invalid manual ranges", () => {
    expect(() =>
      resolveClipRange(
        { duration: 300 },
        { enabled: true, videoOnly: false, durationSeconds: 30, start: "90", end: "60" },
      ),
    ).toThrow(/greater/);
  });

  it("rejects manual starts outside the video duration", () => {
    expect(() =>
      resolveClipRange(
        { duration: 99 },
        { enabled: true, videoOnly: false, durationSeconds: 30, start: "00:01:39" },
      ),
    ).toThrow(/--video-start exceeds video duration/);
  });
});

describe("selectHottestClipRange", () => {
  it("selects the highest heatmap bucket and clamps to requested duration", () => {
    const range = selectHottestClipRange(
      {
        duration: 300,
        heatmap: [
          { start_time: 0, end_time: 10, value: 0.1 },
          { start_time: 120, end_time: 130, value: 0.9 },
        ],
      },
      30,
    );
    expect(range.source).toBe("youtube_heatmap");
    expect(range.startSeconds).toBe(110);
    expect(range.endSeconds).toBe(140);
  });

  it("falls back when heatmap is missing", () => {
    const range = selectHottestClipRange({ duration: 300 }, 30);
    expect(range.source).toBe("fallback_no_heatmap");
    expect(range.startSeconds).toBe(5);
    expect(range.endSeconds).toBe(35);
    expect(range.warnings[0]).toContain("metadata heatmap unavailable");
  });
});

describe("downloadVideoClip", () => {
  it("calls yt-dlp with download sections and writes a manifest", async () => {
    const videoDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-clip-"));
    await mkdir(path.join(videoDir, "video"), { recursive: true });
    await writeFile(path.join(videoDir, "video", "clip.mp4"), "old mp4", "utf8");
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      run: vi.fn(async (spec) => {
        calls.push(spec);
        const args = spec.args ?? [];
        const outputIndex = args.indexOf("-o");
        const outputPattern = args[outputIndex + 1]!;
        const outputDir = path.dirname(outputPattern);
        await mkdir(outputDir, { recursive: true });
        await writeFile(path.join(outputDir, "clip.mp4"), "fake mp4", "utf8");
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 1,
          command: spec.command,
          args: spec.args ?? [],
        };
      }),
    };

    const result = await downloadVideoClip({
      url: "https://www.youtube.com/watch?v=testVideo12",
      videoDir,
      metadata: { duration: 300, heatmap: [{ start_time: 120, end_time: 130, value: 1 }] },
      clip: { enabled: true, videoOnly: false, durationSeconds: 30 },
      cookiesFromBrowser: "chrome",
      proxy: "http://127.0.0.1:1082",
      runner,
      timeoutMs: 60_000,
    });

    expect(result.file).toBe("video/clip.mp4");
    const args = calls[0]!.args ?? [];
    expect(args).toContain("--download-sections");
    expect(args[args.indexOf("--download-sections") + 1]).toBe("*110-140");
    const formatSelector = args[args.indexOf("-f") + 1]!;
    expect(formatSelector).toBe(X_COMPATIBLE_VIDEO_FORMAT);
    expect(formatSelector.split("/").every((candidate) => candidate.includes("[vcodec^=avc1]"))).toBe(
      true,
    );
    expect(args).toContain("--merge-output-format");
    expect(args).toContain("--force-overwrites");
    expect(args).toContain("--cookies-from-browser");
    expect(args).toContain("chrome");
    expect(args).toContain("--proxy");
    expect(args).toContain("http://127.0.0.1:1082");
    await expect(readFile(path.join(videoDir, "video", "clip.mp4"), "utf8")).resolves.toBe(
      "fake mp4",
    );
  });
});
