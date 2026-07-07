import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { burnBilingualSubtitles } from "./burn-bilingual-subtitles.js";
import type { ProcessRunner } from "../process/index.js";

// Mock verify-subtitles and validateSrtIntegrity to avoid Python dependency
vi.mock("./burn-subtitles.js", () => ({
  verifyBurnedSubtitles: vi.fn().mockResolvedValue({
    passed: true,
    checks: [],
  }),
  validateSrtIntegrity: vi.fn().mockResolvedValue({ valid: true, issues: [] }),
}));

describe("burnBilingualSubtitles", () => {
  let tmpDir: string;
  let runner: ProcessRunner;

  beforeEach(async () => {
    tmpDir = path.join(
      process.cwd(),
      "files",
      "downloads",
      `burn-bilingual-test-${Date.now()}`,
    );
    const videoSub = path.join(tmpDir, "video");
    await mkdir(videoSub, { recursive: true });
    await writeFile(path.join(videoSub, "full.mp4"), "fake-video-content");
    await writeFile(
      path.join(videoSub, "full.bilingual.srt"),
      "1\n00:00:01,000 --> 00:00:03,000\n你好\nHello\n",
    );
    await writeFile(
      path.join(videoSub, "full.en.srt"),
      "1\n00:00:01,000 --> 00:00:03,000\nHello\n",
    );
    await writeFile(
      path.join(videoSub, "full.zh.srt"),
      "1\n00:00:01,000 --> 00:00:03,000\n你好\n",
    );

    // Smart mock: simulate Python renderer output, ffprobe, and ffmpeg
    runner = {
      run: vi.fn().mockImplementation(async (opts) => {
        if (opts.command === "python3") {
          const args = opts.args ?? [];
          if (args[0] === "-c") {
            // Blank PNG creation via python3 -c "Image.new(...).save(\"PATH\")"
            const pyCode = args[1] ?? "";
            const match = pyCode.match(/\.save\("([^"]+)"\)/);
            const pngPath = match?.[1];
            if (pngPath) {
              await mkdir(path.dirname(pngPath), { recursive: true });
              await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
            }
          } else {
            // Bilingual render script: args are [script, srt, outDir, --video-width, W, --video-height, H]
            const renderDir = args[2] ?? "/tmp/fallback";
            await mkdir(renderDir, { recursive: true });
            await writeFile(
              path.join(renderDir, "manifest.json"),
              JSON.stringify({
                cues: [
                  { index: 1, filename: "cue_0001.png", start: 1, end: 3, width: 800, height: 120 },
                ],
                video_width: 1280,
                video_height: 0,
              }),
            );
            // Write the actual cue PNG file too
            await writeFile(path.join(renderDir, "cue_0001.png"), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (opts.command === "ffprobe") {
          return { exitCode: 0, stdout: "10.0\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    };
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  const defaultOpts = () => ({
    srtPath: path.join(tmpDir, "video", "full.bilingual.srt"),
    videoPath: path.join(tmpDir, "video", "full.mp4"),
    outputPath: path.join(tmpDir, "video", "full.bilingual-burned.mp4"),
    enSrtPath: path.join(tmpDir, "video", "full.en.srt"),
    zhSrtPath: path.join(tmpDir, "video", "full.zh.srt"),
    runner,
  });

  it("writes output to the specified outputPath", async () => {
    const opts = defaultOpts();
    await burnBilingualSubtitles(opts);

    const calls = vi.mocked(runner.run).mock.calls;
    const ffmpegCall = calls.find((c) => c[0]?.command === "ffmpeg");
    expect(ffmpegCall).toBeDefined();
    const args = ffmpegCall![0]!.args;
    expect(args).toContain(opts.outputPath);
  });

  it("skips burn when output is newer than all sources (non-force)", async () => {
    const opts = defaultOpts();
    await writeFile(opts.outputPath, "existing-burned");
    const burnedStat = await (await import("node:fs/promises")).stat(opts.outputPath);
    const past = new Date(burnedStat.mtimeMs - 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(opts.srtPath, past, past);
    await utimes(opts.enSrtPath, past, past);
    await utimes(opts.zhSrtPath, past, past);

    vi.mocked(runner.run).mockClear();

    const result = await burnBilingualSubtitles({ ...opts, force: false });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("already_exists");
    const ffmpegCalls = vi.mocked(runner.run).mock.calls.filter(
      (c) => c[0]?.command === "ffmpeg",
    );
    expect(ffmpegCalls).toHaveLength(0);
  });

  it("re-burns when force is true even if output exists", async () => {
    const opts = defaultOpts();
    await writeFile(opts.outputPath, "existing-burned");

    vi.mocked(runner.run).mockClear();

    const result = await burnBilingualSubtitles({ ...opts, force: true });

    expect(result.skipped).toBe(false);
    expect(result.burned).toBe(true);
  });

  it("re-burns when SRT is newer than output (mtime check)", async () => {
    const opts = defaultOpts();
    await writeFile(opts.outputPath, "stale-burned");
    const future = new Date(Date.now() + 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(opts.srtPath, future, future);

    vi.mocked(runner.run).mockClear();

    const result = await burnBilingualSubtitles({ ...opts, force: false });

    expect(result.skipped).toBe(false);
    expect(result.burned).toBe(true);
  });

  it("returns missing_srt when bilingual SRT is absent", async () => {
    const opts = { ...defaultOpts(), srtPath: "/nonexistent/path.srt" };
    const result = await burnBilingualSubtitles(opts);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("missing_srt");
  });
});
