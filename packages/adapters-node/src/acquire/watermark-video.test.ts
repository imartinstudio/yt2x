import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { overlayWatermarkOnVideo } from "./watermark-video.js";
import type { ProcessRunner } from "../process/index.js";

vi.mock("./resolve-python.js", () => ({
  resolvePythonWithPillow: vi.fn().mockResolvedValue("python3"),
}));

/**
 * The watermark used to be reachable only as a side effect of a subtitle burn.
 * This module exposes it on its own so a video can be attributed without also
 * being re-rendered with subtitle strips.
 */
describe("overlayWatermarkOnVideo", () => {
  let tmpDir: string;
  let runner: ProcessRunner;
  let inputPath: string;
  let outputPath: string;

  const argsOf = (command: string): string[] => {
    const call = vi
      .mocked(runner.run)
      .mock.calls.find((c) => c[0]?.command === command);
    return call?.[0]?.args ?? [];
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-watermark-video-"));
    await mkdir(tmpDir, { recursive: true });
    inputPath = path.join(tmpDir, "in.mp4");
    outputPath = path.join(tmpDir, "out.mp4");
    await writeFile(inputPath, "fake-video");

    runner = {
      run: vi.fn().mockImplementation(async (opts: { command: string; args?: string[] }) => {
        if (opts.command === "python3") {
          const pngPath = opts.args?.[1] ?? path.join(tmpDir, "wm.png");
          await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (opts.command === "ffprobe") {
          return { exitCode: 0, stdout: "916.05\n", stderr: "" };
        }
        if (opts.command === "ffmpeg") {
          await writeFile(outputPath, "burned");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as unknown as ProcessRunner;
  });

  it("renders both attribution lines through the shared watermark script", async () => {
    await overlayWatermarkOnVideo({
      inputPath,
      outputPath,
      runner,
      watermarkVideo: "@nateherk",
      watermarkSubtitler: "@php_martin",
    });

    const args = argsOf("python3");
    expect(args[0]).toMatch(/gen-watermark\.py$/);
    expect(args).toContain("--watermark-video");
    expect(args[args.indexOf("--watermark-video") + 1]).toBe("@nateherk");
    expect(args).toContain("--watermark-subtitler");
    expect(args[args.indexOf("--watermark-subtitler") + 1]).toBe("@php_martin");
  });

  it("places the overlay at the same top-left offset the subtitle burn uses", async () => {
    await overlayWatermarkOnVideo({
      inputPath,
      outputPath,
      runner,
      watermarkSubtitler: "@php_martin",
    });

    const args = argsOf("ffmpeg");
    expect(args).toContain("-loop");
    const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(filter).toContain("overlay=24:16");
  });

  /**
   * `-shortest` together with `-loop 1` hangs / aborts on macOS — the subtitle burn
   * path already works around it with an explicit `-t`. A 3-second fixture hides
   * this; a 15-minute video does not.
   */
  it("bounds the output with an explicit -t from ffprobe instead of -shortest", async () => {
    await overlayWatermarkOnVideo({
      inputPath,
      outputPath,
      runner,
      watermarkSubtitler: "@php_martin",
    });

    const args = argsOf("ffmpeg");
    expect(args).not.toContain("-shortest");
    expect(args).toContain("-t");
    expect(argsOf("ffprobe")).toContain("format=duration");
    // Exactly the source duration: unlike the subtitle burn there is no separate
    // caption stream to leave room for, so any padding is a frozen tail frame.
    expect(Number(args[args.indexOf("-t") + 1])).toBeCloseTo(916.05, 2);
  });

  it("copies the audio track instead of re-encoding it", async () => {
    await overlayWatermarkOnVideo({
      inputPath,
      outputPath,
      runner,
      watermarkSubtitler: "@php_martin",
    });

    const args = argsOf("ffmpeg");
    expect(args[args.indexOf("-c:a") + 1]).toBe("copy");
  });

  it("refuses before spawning anything when neither handle is given", async () => {
    await expect(
      overlayWatermarkOnVideo({ inputPath, outputPath, runner }),
    ).rejects.toThrow(/at least one/i);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("fails loudly when the watermark PNG cannot be rendered", async () => {
    runner = {
      run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "Pillow missing" }),
    } as unknown as ProcessRunner;

    await expect(
      overlayWatermarkOnVideo({
        inputPath,
        outputPath,
        runner,
        watermarkSubtitler: "@php_martin",
      }),
    ).rejects.toThrow(/watermark/i);
  });

  it("does not re-encode an existing output unless forced", async () => {
    await writeFile(outputPath, "already-watermarked");

    const result = await overlayWatermarkOnVideo({
      inputPath,
      outputPath,
      runner,
      watermarkSubtitler: "@php_martin",
    });

    expect(result.skipped).toBe(true);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("re-encodes an existing output when forced", async () => {
    await writeFile(outputPath, "already-watermarked");

    const result = await overlayWatermarkOnVideo({
      inputPath,
      outputPath,
      runner,
      force: true,
      watermarkSubtitler: "@php_martin",
    });

    expect(result.skipped).toBe(false);
    expect(argsOf("ffmpeg").length).toBeGreaterThan(0);
  });
});
