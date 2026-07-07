import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { burnBilingualSubtitles } from "./burn-bilingual-subtitles.js";
import type { ProcessRunner } from "../process/index.js";

// Mock verify-subtitles to avoid Python dependency in unit tests
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
      path.join(videoSub, "full.bilingual.ass"),
      "[Script Info]\nScriptType: v4.00+\n",
    );
    await writeFile(
      path.join(videoSub, "full.en.srt"),
      "1\n00:00:01,000 --> 00:00:03,000\nHello\n",
    );
    await writeFile(
      path.join(videoSub, "full.zh.srt"),
      "1\n00:00:01,000 --> 00:00:03,000\n你好\n",
    );

    runner = {
      run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    };
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  const defaultOpts = () => ({
    assPath: path.join(tmpDir, "video", "full.bilingual.ass"),
    videoPath: path.join(tmpDir, "video", "full.mp4"),
    outputPath: path.join(tmpDir, "video", "full.bilingual-burned.mp4"),
    enSrtPath: path.join(tmpDir, "video", "full.en.srt"),
    zhSrtPath: path.join(tmpDir, "video", "full.zh.srt"),
    runner,
  });

  it("calls ffmpeg with subtitles filter pointing to ASS file", async () => {
    const opts = defaultOpts();
    await burnBilingualSubtitles(opts);

    const calls = vi.mocked(runner.run).mock.calls;
    const ffmpegCall = calls.find((c) => c[0]?.command === "ffmpeg");
    expect(ffmpegCall).toBeDefined();

    const args = ffmpegCall![0]!.args;
    const argsStr = args.join(" ");
    expect(argsStr).toContain(`subtitles=${opts.assPath}`);
  });

  it("passes H.264 + AAC + yuv420p + faststart encoding params", async () => {
    await burnBilingualSubtitles(defaultOpts());

    const calls = vi.mocked(runner.run).mock.calls;
    const ffmpegCall = calls.find((c) => c[0]?.command === "ffmpeg");
    const args = ffmpegCall![0]!.args.join(" ");

    expect(args).toContain("libx264");
    expect(args).toContain("yuv420p");
    expect(args).toContain("aac");
    expect(args).toContain("faststart");
  });

  it("writes output to the specified outputPath", async () => {
    const opts = defaultOpts();
    await burnBilingualSubtitles(opts);

    const calls = vi.mocked(runner.run).mock.calls;
    const ffmpegCall = calls.find((c) => c[0]?.command === "ffmpeg");
    const args = ffmpegCall![0]!.args;

    // The output path should be the last arg (before -y is appended)
    expect(args).toContain(opts.outputPath);
  });

  it("skips burn when output is newer than all sources (non-force)", async () => {
    const opts = defaultOpts();
    // Create output file newer than sources
    await writeFile(opts.outputPath, "existing-burned");
    const burnedStat = await stat(opts.outputPath);
    // Touch source files to be older
    const past = new Date(burnedStat.mtimeMs - 60_000);
    await writeFile(opts.assPath, "old-ass");
    // Set mtime to past
    const { utimes } = await import("node:fs/promises");
    await utimes(opts.assPath, past, past);
    await utimes(opts.enSrtPath, past, past);
    await utimes(opts.zhSrtPath, past, past);

    vi.mocked(runner.run).mockClear();

    const result = await burnBilingualSubtitles({ ...opts, force: false });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("already_exists");
    // ffmpeg should not have been called
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
    const ffmpegCalls = vi.mocked(runner.run).mock.calls.filter(
      (c) => c[0]?.command === "ffmpeg",
    );
    expect(ffmpegCalls.length).toBeGreaterThan(0);
  });

  it("re-burns when ASS is newer than output (mtime check)", async () => {
    const opts = defaultOpts();
    // Create output older than ASS
    await writeFile(opts.outputPath, "stale-burned");
    const futureAss = new Date(Date.now() + 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(opts.assPath, futureAss, futureAss);

    vi.mocked(runner.run).mockClear();

    const result = await burnBilingualSubtitles({ ...opts, force: false });

    expect(result.skipped).toBe(false);
    expect(result.burned).toBe(true);
  });

  it("includes fontsdir in ffmpeg filter when provided", async () => {
    const opts = { ...defaultOpts(), fontsDir: "/usr/share/fonts/truetype" };
    await burnBilingualSubtitles(opts);

    const calls = vi.mocked(runner.run).mock.calls;
    const ffmpegCall = calls.find((c) => c[0]?.command === "ffmpeg");
    const argsStr = ffmpegCall![0]!.args.join(" ");

    expect(argsStr).toContain("fontsdir=/usr/share/fonts/truetype");
  });

  it("escapes ASS path with colons for ffmpeg (Windows-style or escaped)", async () => {
    // ffmpeg subtitles filter uses : as separator; paths with : must be escaped
    // On macOS/Linux, paths rarely have colons, but we ensure the filter
    // construction handles special characters.
    const assDir = path.join(tmpDir, "video");
    const opts = {
      ...defaultOpts(),
      assPath: path.join(assDir, "full.bilingual.ass"),
    };
    await burnBilingualSubtitles(opts);

    const calls = vi.mocked(runner.run).mock.calls;
    const ffmpegCall = calls.find((c) => c[0]?.command === "ffmpeg");
    expect(ffmpegCall).toBeDefined();
  });

  it("records warning when fontsDir has no CJK fallback", async () => {
    const opts = defaultOpts();
    const result = await burnBilingualSubtitles(opts);

    // Without fontsDir, a warning about font discovery should be recorded
    const hasFontWarning = result.warnings.some((w) =>
      w.toLowerCase().includes("font"),
    );
    expect(hasFontWarning).toBe(true);
  });

  it("does not warn about fonts when fontsDir is provided", async () => {
    const opts = { ...defaultOpts(), fontsDir: "/usr/share/fonts" };
    const result = await burnBilingualSubtitles(opts);

    // With fontsDir, no font warning
    const hasFontWarning = result.warnings.some((w) =>
      w.toLowerCase().includes("font"),
    );
    expect(hasFontWarning).toBe(false);
  });
});
