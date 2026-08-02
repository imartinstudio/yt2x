import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  burnBilingualSubtitles,
  measureBilingualSubtitleLayout,
} from "./burn-bilingual-subtitles.js";
import type * as BurnSubtitlesModule from "./burn-subtitles.js";
import type { ProcessRunner } from "../process/index.js";

// Mock verify-subtitles and validateSrtIntegrity to avoid Python dependency
// (keep the real progress-line parsers used by burnBilingualSubtitles)
vi.mock("./burn-subtitles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BurnSubtitlesModule>();
  return {
    ...actual,
    verifyBurnedSubtitles: vi.fn().mockResolvedValue({
      passed: true,
      checks: [],
    }),
    validateSrtIntegrity: vi.fn().mockResolvedValue({ valid: true, issues: [] }),
  };
});

vi.mock("./resolve-python.js", () => ({
  resolvePythonWithPillow: vi.fn().mockResolvedValue("python3"),
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
            // Blank PNG creation via python3 -c "Image.new(...).save(\"PATH\")\n..."
            // — one script now creates both the zh_blank and en_blank PNGs.
            const pyCode = args[1] ?? "";
            for (const match of pyCode.matchAll(/\.save\("([^"]+)"\)/g)) {
              const pngPath = match[1];
              if (pngPath) {
                await mkdir(path.dirname(pngPath), { recursive: true });
                await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
              }
            }
          } else if ((args[0] ?? "").includes("gen-watermark.py")) {
            const wmPath = args[1] ?? "/tmp/watermark.png";
            await mkdir(path.dirname(wmPath), { recursive: true });
            await writeFile(wmPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          } else {
            // Bilingual render script: args are [script, srt, outDir, --video-width, W, --video-height, H]
            const renderDir = args[2] ?? "/tmp/fallback";
            await mkdir(renderDir, { recursive: true });
            await writeFile(
              path.join(renderDir, "manifest.json"),
              JSON.stringify({
                zh_cues: [
                  { index: 0, filename: "zh_0000.png", start: 1, end: 3, width: 800, height: 40 },
                ],
                en_cues: [
                  { index: 1, filename: "en_0001.png", start: 1, end: 3, width: 200, height: 20 },
                ],
                video_width: 1280,
                video_height: 0,
              }),
            );
            // Write the actual layer PNG files too
            await writeFile(path.join(renderDir, "zh_0000.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            await writeFile(path.join(renderDir, "en_0001.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (opts.command === "ffprobe") {
          const args = (opts.args ?? []).join(" ");
          if (args.includes("width")) {
            return { exitCode: 0, stdout: "1280\n", stderr: "" };
          }
          if (args.includes("height")) {
            return { exitCode: 0, stdout: "720\n", stderr: "" };
          }
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

  it("uses the renderer measurement mode without producing cue images", async () => {
    vi.mocked(runner.run).mockImplementationOnce(async (spec) => {
      const outputIndex = spec.args?.indexOf("--output") ?? -1;
      const outputPath = spec.args?.[outputIndex + 1];
      expect(spec.args).toEqual(expect.arrayContaining([
        "--measure",
        "--video-width", "1280",
        "--video-height", "720",
      ]));
      await writeFile(outputPath!, JSON.stringify([{
        cueIndex: 1,
        zhWidth: 320,
        fitWidth: 1024,
        lineCount: 1,
        severity: "fit",
        resolvedFonts: { zh: "PingFang SC", en: "Lexend Deca" },
      }]));
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await measureBilingualSubtitleLayout({
      srtContent: "1\n00:00:01,000 --> 00:00:03,000\n你好\nHello\n",
      videoWidth: 1280,
      videoHeight: 720,
      runner,
    });

    expect(result).toEqual([
      expect.objectContaining({ cueIndex: 1, severity: "fit", fitWidth: 1024 }),
    ]);
  });

  it("keeps the approved BaoCut-inspired 720p style contract in the renderer", async () => {
    const renderer = await readFile(
      path.join(process.cwd(), "packages/adapters-node/src/acquire/render-bilingual-subtitles.py"),
      "utf8",
    );

    // Style is mostly held in BaoCut's own units — shadow distance/blur as
    // its 0-1 fractions (per row, since English's shadow has to work harder
    // with no outline to lean on) and the shadow angle in degrees. Outline
    // width is the deliberate exception: BaoCut's 8%-of-font-size fraction
    // scaled to 2-4px across our resolutions and read as too heavy, so it's
    // a fixed hairline pixel count instead of a resolution-scaled fraction.
    expect(renderer).toContain("_BASE_ZH_FONT_SIZE = 30");
    expect(renderer).toContain("_BASE_EN_FONT_SIZE = 16");
    expect(renderer).toContain("ZH_OUTLINE_PX = 1");
    expect(renderer).toContain("EN_OUTLINE_PX = 0");
    expect(renderer).toContain("ZH_SHADOW_DISTANCE_FRAC = 0.08");
    expect(renderer).toContain("ZH_SHADOW_BLUR_FRAC = 0.10");
    expect(renderer).toContain("EN_SHADOW_DISTANCE_FRAC = 0.08");
    expect(renderer).toContain("EN_SHADOW_BLUR_FRAC = 0.10");
    expect(renderer).toContain("SHADOW_ANGLE_DEG = 45");
    expect(renderer).toContain("MAX_WIDTH_FRAC = 0.80");

    // Lexend Deca is the requested face for both rows but has no CJK glyphs,
    // so it can only head a fallback chain — hence a Latin/CJK FontSet pair
    // and per-run face switching, not one font per row.
    expect(renderer).toContain("LexendDeca.ttf");
    expect(renderer).toContain('"PingFang SC"');
    expect(renderer).toContain('"Hiragino Sans GB"');
    expect(renderer).toContain('"STHeiti"');
    expect(renderer).toContain("class FontSet:");
    expect(renderer).toContain("def font_runs(");
    expect(renderer).toContain("def draw_mixed_line(");
    expect(renderer).toContain('anchor="ls"');

    // The shadow is a real Gaussian blur on its own layer, not a stamped
    // offset trail, and its silhouette is drawn entirely in the shadow colour
    // (drawing the outline pass in opaque black made the "shadow" an opaque
    // slab as thick as the outline no matter what alpha it was given).
    expect(renderer).toContain("SHADOW_RGB = (64, 64, 64)");
    expect(renderer).toContain("ImageFilter.GaussianBlur");
    expect(renderer).toContain("outline_color=shadow.color");

    // Opacity is per row: the Chinese outline carries legibility so its
    // shadow is only a depth hint, while English has no outline.
    expect(renderer).toContain("ZH_SHADOW_OPACITY = 0.28");
    expect(renderer).toContain("EN_SHADOW_OPACITY = 0.42");

    // CJK/Latin word spacing, so embedded product names don't run into the
    // surrounding Chinese.
    expect(renderer).toContain("def space_cjk_latin(");

    // ZH and EN render as independent layers of FIXED-SIZE, full-width
    // canvases with the text pre-centered. Constant frame dimensions are what
    // stop ffmpeg reconfiguring its filter graph mid-stream (which made the
    // Chinese row flicker exactly when the English row changed cues).
    expect(renderer).toContain("def render_text_row(");
    expect(renderer).toContain("def measure_text_block(");
    expect(renderer).toContain("def group_zh_runs(");
    expect(renderer).toContain('Image.new("RGBA", (VIDEO_WIDTH, row_h)');

    const burner = await readFile(
      path.join(process.cwd(), "packages/adapters-node/src/acquire/burn-bilingual-subtitles.ts"),
      "utf8",
    );
    expect(burner).toContain("const ZH_EN_ROW_GAP_BASE = 4;");
  });

  it("writes output to the specified outputPath", async () => {
    const opts = defaultOpts();
    await burnBilingualSubtitles(opts);

    const calls = vi.mocked(runner.run).mock.calls;
    const ffmpegCall = calls.find((c) => c[0]?.command === "ffmpeg");
    expect(ffmpegCall).toBeDefined();
    const args = ffmpegCall![0]!.args;
    expect(args).toContain(opts.outputPath);
    // Two independent strip layers: EN at the bottom margin, ZH stacked at a
    // fixed offset above it (bottomMargin 36 + en height 20 + gap 4 = 60).
    // x is a constant 0 — layers are full-width canvases with text already
    // centered inside, so ffmpeg never re-derives centering per frame.
    const filter = args?.[args.indexOf("-filter_complex") + 1] ?? "";
    expect(filter).toContain("overlay=0:H-h-36");
    expect(filter).toContain("overlay=0:H-h-60");
    expect(filter).not.toContain("(W-w)/2");
    // No full-frame overlay generator
    const pyCalls = calls.filter((c) => c[0]?.command === "python3");
    expect(
      pyCalls.some((c) => (c[0]?.args?.[0] ?? "").includes("generate-overlay-frames.py")),
    ).toBe(false);
  });

  it("reports render, frames, and encode progress via onProgress", async () => {
    const baseImpl = vi.mocked(runner.run).getMockImplementation()!;
    vi.mocked(runner.run).mockImplementation(async (spec) => {
      if (
        spec.command === "python3" &&
        (spec.args?.[0] ?? "").includes("render-bilingual-subtitles.py")
      ) {
        spec.onStdoutLine?.("PROGRESS 1/1");
      }
      if (spec.command === "ffmpeg") {
        expect(spec.args).toContain("-progress");
        spec.onStdoutLine?.("frame=40");
        spec.onStdoutLine?.("out_time=00:00:05.000000");
      }
      return baseImpl(spec);
    });

    const events: Array<{ phase: string; done: number; total: number }> = [];
    await burnBilingualSubtitles({
      ...defaultOpts(),
      onProgress: (e) => events.push(e),
    });

    expect(events).toContainEqual({ phase: "render", done: 1, total: 1 });
    expect(events).toContainEqual({ phase: "encode", done: 5, total: 10 });
    expect(events.some((e) => e.phase === "frames" && e.done === e.total)).toBe(true);
  });

  it("overlays static watermark when handles are provided", async () => {
    const opts = {
      ...defaultOpts(),
      watermarkVideo: "@channel",
      watermarkSubtitler: "@php_martin",
    };
    await burnBilingualSubtitles(opts);

    const calls = vi.mocked(runner.run).mock.calls;
    const ffmpegCall = calls.find((c) => c[0]?.command === "ffmpeg");
    expect(ffmpegCall).toBeDefined();
    const args = ffmpegCall![0]!.args ?? [];
    expect(args).toContain("-loop");
    const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(filter).toContain("overlay=24:16");
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

  describe("replaceAudioPath", () => {
    it("keeps mapping the source video's own audio (0:a) when omitted — unchanged default behaviour", async () => {
      const opts = defaultOpts();
      await burnBilingualSubtitles(opts);

      const calls = vi.mocked(runner.run).mock.calls;
      const ffmpegCall = calls.find((c) => c[0]?.command === "ffmpeg");
      const args = ffmpegCall![0]!.args ?? [];
      const mapIndices = args.reduce<number[]>((acc, a, i) => (a === "-map" ? [...acc, i] : acc), []);
      const mappedValues = mapIndices.map((i) => args[i + 1]);
      expect(mappedValues).toContain("0:a");
      // No extra input beyond video/zh-frames/en-frames was added.
      expect(args.filter((a) => a === "-i")).toHaveLength(3);
    });

    it("adds the replacement track as the last input and maps its audio instead of 0:a", async () => {
      const audioPath = path.join(tmpDir, "video", "dubbed-mix.m4a");
      await writeFile(audioPath, "fake-audio");

      const opts = { ...defaultOpts(), replaceAudioPath: audioPath };
      await burnBilingualSubtitles(opts);

      const calls = vi.mocked(runner.run).mock.calls;
      const ffmpegCall = calls.find((c) => c[0]?.command === "ffmpeg");
      const args = ffmpegCall![0]!.args ?? [];

      // video(0) + zh-frames(1) + en-frames(2) + replacement audio(3) = 4 "-i" inputs.
      expect(args.filter((a) => a === "-i")).toHaveLength(4);
      expect(args).toContain(audioPath);
      const mapIndices = args.reduce<number[]>((acc, a, i) => (a === "-map" ? [...acc, i] : acc), []);
      const mappedValues = mapIndices.map((i) => args[i + 1]);
      expect(mappedValues).toContain("3:a");
      expect(mappedValues).not.toContain("0:a");
      // The video overlay filter graph indices are untouched by the extra audio input.
      const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
      expect(filter).toContain("[0:v][1:v]overlay");
      expect(filter).toContain("[withzh][2:v]overlay");
    });

    it("keeps the watermark at input index 3 and maps the replacement audio at 4 when both are present", async () => {
      const audioPath = path.join(tmpDir, "video", "dubbed-mix.m4a");
      await writeFile(audioPath, "fake-audio");

      const opts = {
        ...defaultOpts(),
        replaceAudioPath: audioPath,
        watermarkVideo: "@channel",
        watermarkSubtitler: "@subtitler",
      };
      await burnBilingualSubtitles(opts);

      const calls = vi.mocked(runner.run).mock.calls;
      const ffmpegCall = calls.find((c) => c[0]?.command === "ffmpeg");
      const args = ffmpegCall![0]!.args ?? [];
      const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
      expect(filter).toContain("[withen][3:v]overlay");

      const mapIndices = args.reduce<number[]>((acc, a, i) => (a === "-map" ? [...acc, i] : acc), []);
      const mappedValues = mapIndices.map((i) => args[i + 1]);
      expect(mappedValues).toContain("4:a");
    });

    it("also treats a newer replacement audio track as a reason to re-burn (mtime check)", async () => {
      const audioPath = path.join(tmpDir, "video", "dubbed-mix.m4a");
      await writeFile(audioPath, "fake-audio");
      const opts = { ...defaultOpts(), replaceAudioPath: audioPath };
      await writeFile(opts.outputPath, "stale-burned");

      const { utimes } = await import("node:fs/promises");
      const future = new Date(Date.now() + 60_000);
      await utimes(audioPath, future, future);

      vi.mocked(runner.run).mockClear();
      const result = await burnBilingualSubtitles({ ...opts, force: false });

      expect(result.skipped).toBe(false);
      expect(result.burned).toBe(true);
    });
  });
});
