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

  it("keeps the approved 720p style contract in the shared visual module", async () => {
    // The LOOK is shared with the single-language renderer so the two cannot
    // drift apart; this asserts the contract file itself. Type size and row
    // stacking stay per-renderer and are asserted below.
    const style = await readFile(
      path.join(process.cwd(), "packages/adapters-node/src/acquire/subtitle_style.py"),
      "utf8",
    );

    // Outline is a fixed hairline pixel count, not a font-size fraction: an
    // 8%-of-font-size outline scaled to 2-4px across our resolutions and read
    // as too heavy. It is also what keeps a white glyph alive on a near-white
    // scene now that neither renderer draws a background box.
    expect(style).toContain("ZH_OUTLINE_PX = 1");
    // English carried no outline until a burn test over bright UI footage
    // showed it was the first thing to become unreadable.
    expect(style).toContain("EN_OUTLINE_PX = 1");
    expect(style).toContain("MAX_WIDTH_FRAC = 0.80");
    expect(style).toContain("BASELINE_VIDEO_HEIGHT = 720");

    // Chinese shadow is the design spec's CSS `0 4px 20px rgba(0,0,0,.5)`,
    // stated as absolute 720p px rather than a font fraction — the
    // single-language renderer changes type size per cue, so a font-relative
    // shadow would change weight between captions.
    expect(style).toContain("ZH_SHADOW_CSS_OFFSET_PX = (0, 4)");
    expect(style).toContain("ZH_SHADOW_CSS_BLUR_PX = 20");
    expect(style).toContain("ZH_SHADOW_OPACITY = 0.50");
    expect(style).toContain("ZH_SHADOW_RGB = (0, 0, 0)");
    // CSS blur is 2-sigma, Pillow's GaussianBlur radius IS sigma.
    expect(style).toContain("(ZH_SHADOW_CSS_BLUR_PX / 2) * scale");

    // English keeps the earlier font-relative shadow: the spec sets its face,
    // colour and tracking but says nothing about shadow, and with no outline
    // this row has nothing else separating white glyphs from the picture.
    expect(style).toContain("EN_SHADOW_ANGLE_DEG = 45");
    expect(style).toContain("EN_SHADOW_DISTANCE_FRAC = 0.08");
    expect(style).toContain("EN_SHADOW_BLUR_FRAC = 0.10");
    expect(style).toContain("EN_SHADOW_OPACITY = 0.42");
    expect(style).toContain("EN_SHADOW_RGB = (64, 64, 64)");

    // Chinese is Source Han Sans / Noto Sans SC at weight 900 ("Black"),
    // discovered on the host because the CJK outlines are far too big to
    // vendor; English is the vendored Inter Bold, so its repo copy is
    // authoritative.
    expect(style).toContain("NotoSansSC-Variable.ttf");
    expect(style).toContain('"Noto Sans SC Black", "Black"');
    expect(style).toContain("SourceHanSansSC-Heavy.otf");
    expect(style).toContain('"Inter-Bold.ttf"');
    expect(style).toContain('"PingFang SC"');
    expect(style).toContain('"Hiragino Sans GB"');
    expect(style).toContain('"STHeiti"');

    // Colours: both rows white, with the English row accenting the standalone
    // word "AI" in #FFD928.
    expect(style).toContain("ZH_FILL = (255, 255, 255, 255)");
    expect(style).toContain("EN_FILL = (255, 255, 255, 255)");
    expect(style).toContain("EN_HIGHLIGHT_FILL = (255, 217, 40, 255)");
    expect(style).toContain('EN_HIGHLIGHT_RE = re.compile(r"\\bAI\\b")');

    // Letter-spacing is English-only: CJK glyphs already sit on a fixed
    // advance, so extra tracking there just loosens the word shapes.
    expect(style).toContain("ZH_TRACKING_EM = 0.0");
    expect(style).toContain("EN_TRACKING_EM = 0.02");

    // One line pitch for every row, applied to that row's own size. The two
    // renderers used to disagree (~1.50em here vs 2.00em single-language).
    expect(style).toContain("LINE_PITCH_EM = 1.65");

    const renderer = await readFile(
      path.join(process.cwd(), "packages/adapters-node/src/acquire/render-bilingual-subtitles.py"),
      "utf8",
    );

    // The Chinese row's size is shared, because single-language delivery is
    // this same row with the English one removed. English has no counterpart
    // to match, so its size stays local to this renderer.
    expect(style).toContain("ZH_FONT_SIZE_BASE = 30");
    expect(renderer).toContain("from subtitle_style import");
    expect(renderer).toContain("ZH_FONT_SIZE_BASE");
    expect(renderer).toContain("_BASE_EN_FONT_SIZE = 16");
    expect(renderer).toContain("class FontSet:");
    expect(renderer).toContain("def font_runs(");
    expect(renderer).toContain("def styled_runs(");
    expect(renderer).toContain("def draw_mixed_line(");
    // Left-baseline anchoring lives with the shared draw primitive: the two
    // faces' differing ascents must not make their glyphs sit at different
    // heights on a shared baseline.
    expect(style).toContain('anchor: str = "ls"');

    // The shadow is a real Gaussian blur on its own layer, not a stamped
    // offset trail, and its silhouette is drawn entirely in the shadow colour
    // (drawing the outline pass in opaque black made the "shadow" an opaque
    // slab as thick as the outline no matter what alpha it was given).
    expect(renderer).toContain("ImageFilter.GaussianBlur");
    expect(renderer).toContain("outline_color=shadow.color");

    // Outlining is a shared primitive: a 3x3 dilation, NOT Pillow's
    // stroke_width. The two are a pixel or two apart at the same nominal
    // width, so both renderers have to use the same one or their Chinese rows
    // stop matching.
    expect(style).toContain("def draw_outlined_runs(");
    expect(renderer).toContain("draw_outlined_runs(draw, placed, baseline_y");
    expect(renderer).not.toContain("stroke_width");

    // Chinese caption text treatment is shared too, or the two renderers draw
    // different strings from the same SRT.
    expect(style).toContain("def zh_caption_text(");
    expect(renderer).toContain("zh_caption_text(");

    // CJK/Latin word spacing, so embedded product names don't run into the
    // surrounding Chinese. Shared, like the rest of the text treatment.
    expect(style).toContain("def space_cjk_latin(");
    expect(style).toContain("def clean_subtitle_text(");

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
