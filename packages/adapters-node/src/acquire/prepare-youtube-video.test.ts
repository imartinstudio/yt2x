import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner, ProcessResult, ProcessSpec } from "../process/index.js";
import { prepareYoutubeVideo, subtitlePipelineHasWork } from "./prepare-youtube-video.js";
import * as videoSubtitles from "./video-subtitles.js";
import type * as VideoSubtitlesModule from "./video-subtitles.js";

// Only runSubtitlePipeline is stubbed — the rest of the module (notably
// prepareSourceSubtitle) stays real so the other integration tests are unaffected.
vi.mock("./video-subtitles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof VideoSubtitlesModule>();
  return { ...actual, runSubtitlePipeline: vi.fn().mockResolvedValue({ warnings: [] }) };
});

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const SAMPLE_METADATA = {
  id: "testVideo12",
  title: "Integration Test Video",
  language: "en",
  duration: 300,
  heatmap: [{ start_time: 120, end_time: 130, value: 1 }],
};

const baseProcessResult = (
  spec: ProcessSpec,
  overrides: Partial<ProcessResult> = {},
): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 1,
  command: spec.command,
  args: spec.args ?? [],
  ...overrides,
});

const outputDirFromYtDlpArgs = (args: readonly string[]): string | null => {
  const oIdx = args.indexOf("-o");
  if (oIdx < 0 || oIdx + 1 >= args.length) {
    return null;
  }
  const pattern = args[oIdx + 1]!;
  const slash = pattern.indexOf("/%(");
  return slash >= 0 ? pattern.slice(0, slash) : pattern;
};

const createMockRunner = (opts: {
  subtitleFileName?: string;
  failVideoClip?: boolean;
  /** false 时 yt-dlp 一个字幕文件都不产出，用来模拟 PO token / 无字幕视频 */
  writeSubtitles?: boolean;
  /** true 时 whisper-cli 会产出 SRT，用来模拟本地转录可用 */
  transcribe?: boolean;
  onRun?: (spec: ProcessSpec) => void;
}): ProcessRunner => {
  const subtitleName = opts.subtitleFileName ?? "fixture.en.srt";
  let subtitleWritten = false;

  return {
    run: vi.fn(async (spec: ProcessSpec): Promise<ProcessResult> => {
      opts.onRun?.(spec);
      const args = spec.args ?? [];

      if (spec.command === "yt-dlp" && args.includes("--write-info-json")) {
        const oIdx = args.indexOf("-o");
        const template = oIdx >= 0 ? args[oIdx + 1]! : "";
        const tempDir = template.includes("/") ? template.slice(0, template.lastIndexOf("/")) : template;
        await mkdir(tempDir, { recursive: true });
        await writeFile(
          path.join(tempDir, "video.info.json"),
          `${JSON.stringify(SAMPLE_METADATA)}\n`,
          "utf8",
        );
        return baseProcessResult(spec);
      }

      if (
        spec.command === "yt-dlp" &&
        (args.includes("--write-subs") || args.includes("--write-auto-subs"))
      ) {
        const videoDir = outputDirFromYtDlpArgs(args);
        if (videoDir !== null && !subtitleWritten && opts.writeSubtitles !== false) {
          const { copyFile, mkdir } = await import("node:fs/promises");
          await mkdir(videoDir, { recursive: true });
          await copyFile(
            path.join(FIXTURES_DIR, "sample-en.srt"),
            path.join(videoDir, subtitleName),
          );
          subtitleWritten = true;
        }
        return baseProcessResult(spec);
      }

      if (spec.command === "yt-dlp" && args.includes("--merge-output-format")) {
        if (opts.failVideoClip === true) {
          return baseProcessResult(spec, { exitCode: 1, stderr: "clip failed" });
        }
        const oIdx = args.indexOf("-o");
        const outputPattern = oIdx >= 0 ? args[oIdx + 1]! : "";
        const outputDir = outputPattern.includes("/")
          ? outputPattern.slice(0, outputPattern.lastIndexOf("/"))
          : ".";
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(outputDir, { recursive: true });
        await writeFile(
          path.join(outputDir, args.includes("--download-sections") ? "clip.mp4" : "full.mp4"),
          "fake mp4",
          "utf8",
        );
        return baseProcessResult(spec);
      }

      if (spec.command === "yt-dlp") {
        return baseProcessResult(spec);
      }

      if (spec.command === "ffmpeg") {
        return baseProcessResult(spec);
      }

      if (spec.command === "whisper-cli") {
        if (opts.transcribe !== true) {
          return baseProcessResult(spec, { exitCode: 1, stderr: "whisper-cli not available" });
        }
        const ofIdx = args.indexOf("-of");
        const { copyFile, mkdir } = await import("node:fs/promises");
        const target = `${args[ofIdx + 1]!}.srt`;
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(FIXTURES_DIR, "sample-en.srt"), target);
        return baseProcessResult(spec);
      }

      return baseProcessResult(spec);
    }),
  };
};

describe("subtitlePipelineHasWork", () => {
  /**
   * The bilingual `--deliver` tiers deliberately set subtitleZh to "off" so the
   * single-language burn never runs alongside the bilingual one (delivery.ts
   * documents that double-burn bug). Their real intent rides on
   * subtitleBilingual, so a gate that reads only the zh mode makes
   * `--urls --deliver bilingual-burned` produce NOTHING and still report success.
   */
  it("runs when only the bilingual mode is set — the bilingual --deliver tiers", () => {
    expect(subtitlePipelineHasWork("off", "burned")).toBe(true);
    expect(subtitlePipelineHasWork("off", "srt")).toBe(true);
    expect(subtitlePipelineHasWork("off", "ass")).toBe(true);
    expect(subtitlePipelineHasWork("off", "all")).toBe(true);
  });

  it("runs when only the Chinese mode is set", () => {
    expect(subtitlePipelineHasWork("srt", "off")).toBe(true);
    expect(subtitlePipelineHasWork("burned", "off")).toBe(true);
  });

  it("stays off when neither mode asks for anything", () => {
    expect(subtitlePipelineHasWork("off", "off")).toBe(false);
    expect(subtitlePipelineHasWork(undefined, undefined)).toBe(false);
    expect(subtitlePipelineHasWork("off", undefined)).toBe(false);
    expect(subtitlePipelineHasWork(undefined, "off")).toBe(false);
  });
});

describe("prepareYoutubeVideo (integration, mocked yt-dlp)", () => {
  it("runs the subtitle pipeline when ONLY the bilingual mode is set", async () => {
    // The regression this pins: `--urls --deliver bilingual-burned` sets
    // subtitleZh "off" by design and carries its intent in subtitleBilingual.
    // Gating on the zh mode alone skipped the stage and still reported success,
    // so the run produced no subtitles at all. Asserting the predicate in
    // isolation is not enough — it would stay green if the call site stopped
    // consulting it, which is exactly the shape of the original bug.
    vi.mocked(videoSubtitles.runSubtitlePipeline).mockClear();
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-bi-"));

    await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      videoSubtitles: { mode: "off", sourceLang: "en", targetLang: "zh-CN", source: "auto" },
      subtitleBilingual: "burned",
      runner: createMockRunner({}),
      timeoutMs: 60_000,
    });

    expect(videoSubtitles.runSubtitlePipeline).toHaveBeenCalledTimes(1);
    expect(vi.mocked(videoSubtitles.runSubtitlePipeline).mock.calls[0]![0]).toEqual(
      expect.objectContaining({ subtitleBilingual: "burned" }),
    );
  });

  it("leaves the subtitle pipeline alone when both modes are off", async () => {
    vi.mocked(videoSubtitles.runSubtitlePipeline).mockClear();
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-nosub-"));

    await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      videoSubtitles: { mode: "off", sourceLang: "en", targetLang: "zh-CN", source: "auto" },
      subtitleBilingual: "off",
      runner: createMockRunner({}),
      timeoutMs: 60_000,
    });

    expect(videoSubtitles.runSubtitlePipeline).not.toHaveBeenCalled();
  });

  it("writes metadata, chunks.md, and timestamped-cues.md", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-"));
    const runner = createMockRunner({});

    const result = await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      runner,
      timeoutMs: 60_000,
    });

    expect(result.ok).toBe(true);
    expect(result.video_id).toBe("testVideo12");

    const videoDir = path.join(outDir, "testVideo12");
    const chunks = await readFile(path.join(videoDir, "chunks.md"), "utf8");
    const cues = await readFile(path.join(videoDir, "timestamped-cues.md"), "utf8");
    const metadata = JSON.parse(await readFile(path.join(videoDir, "metadata.json"), "utf8")) as {
      id: string;
    };

    expect(metadata.id).toBe("testVideo12");
    expect(chunks).toContain("Hello integration test");
    expect(cues).toContain("`00:00:01.000`");
    expect(cues).toContain("Second cue line");
  });

  it("passes --sub-langs to yt-dlp manual subtitle pass", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-sublang-"));
    const calls: ProcessSpec[] = [];
    const runner = createMockRunner({
      onRun: (spec) => {
        calls.push(spec);
      },
    });

    await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      subLangs: "zh-Hans,zh",
      runner,
      timeoutMs: 60_000,
    });

    const manualPass = calls.find(
      (c) =>
        c.command === "yt-dlp" &&
        (c.args ?? []).includes("--write-subs") &&
        (c.args ?? []).includes("--sub-langs"),
    );
    expect(manualPass).toBeDefined();
    const args = manualPass!.args ?? [];
    expect(args[args.indexOf("--sub-langs") + 1]).toBe("zh-Hans,zh");
  });

  it("defaults manual subtitle language order to Simplified Chinese first", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-default-sublang-"));
    const calls: ProcessSpec[] = [];
    const runner = createMockRunner({
      onRun: (spec) => {
        calls.push(spec);
      },
    });

    await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      runner,
      timeoutMs: 60_000,
    });

    const manualPass = calls.find(
      (c) =>
        c.command === "yt-dlp" &&
        (c.args ?? []).includes("--write-subs") &&
        (c.args ?? []).includes("--sub-langs"),
    );
    expect(manualPass).toBeDefined();
    const args = manualPass!.args ?? [];
    expect(args[args.indexOf("--sub-langs") + 1]).toBe("zh-CN,zh-Hans,zh,zh-Hant,zh-TW,en");
  });

  it("tries the video's own language before Chinese when falling back to automatic captions", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-auto-order-"));
    const calls: ProcessSpec[] = [];
    // 一个字幕都不写：让自动字幕回落把整张语言表跑完，才能断言顺序
    const runner = createMockRunner({ writeSubtitles: false, onRun: (spec) => calls.push(spec) });

    await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      runner,
      timeoutMs: 60_000,
    });

    const autoLangs = calls
      .filter((c) => c.command === "yt-dlp" && (c.args ?? []).includes("--write-auto-subs"))
      .map((c) => {
        const args = c.args ?? [];
        return args[args.indexOf("--sub-langs") + 1];
      });

    // 开了 PO token 之后 YouTube 会把几百种机翻轨全部放出来，所以"首个命中即返回"
    // 的这张表，第一项决定了最终拿到的是原声还是机翻。
    expect(autoLangs[0]).toBe("en");
    expect(autoLangs.indexOf("en")).toBeLessThan(autoLangs.indexOf("zh-CN"));
  });

  it("falls back to local transcription when YouTube yields no subtitles", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-transcribe-fallback-"));
    const runner = createMockRunner({ writeSubtitles: false, transcribe: true });

    const result = await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      runner,
      timeoutMs: 60_000,
      videoClip: { enabled: true, durationSeconds: 300 },
    });

    expect(result.ok).toBe(true);
    const chunks = await readFile(path.join(outDir, "testVideo12", "chunks.md"), "utf8");
    expect(chunks).toContain("Chunk 1");
  });

  it("passes --proxy and --cookies-from-browser to yt-dlp", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-proxy-"));
    const calls: ProcessSpec[] = [];
    const runner = createMockRunner({
      onRun: (spec) => {
        calls.push(spec);
      },
    });

    await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      proxy: "http://127.0.0.1:1082",
      cookiesFromBrowser: "chrome",
      runner,
      timeoutMs: 60_000,
    });

    const metadataCall = calls.find(
      (c) => c.command === "yt-dlp" && (c.args ?? []).includes("--write-info-json"),
    );
    expect(metadataCall).toBeDefined();
    const args = metadataCall!.args ?? [];
    expect(args).toContain("--proxy");
    expect(args).toContain("http://127.0.0.1:1082");
    expect(args).toContain("--cookies-from-browser");
    expect(args).toContain("chrome");
  });

  it("downloads an optional video clip when enabled", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-clip-"));
    const calls: ProcessSpec[] = [];
    const runner = createMockRunner({
      onRun: (spec) => {
        calls.push(spec);
      },
    });

    const result = await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      videoClip: { enabled: true, videoOnly: false, durationSeconds: 30 },
      runner,
      timeoutMs: 60_000,
    });

    expect(result.ok).toBe(true);
    expect(result.video_clip?.file).toBe("video/full.mp4");
    const clipCall = calls.find(
      (c) => c.command === "yt-dlp" && (c.args ?? []).includes("--merge-output-format"),
    );
    expect(clipCall).toBeDefined();
    const args = clipCall!.args ?? [];
    expect(args).not.toContain("--download-sections");
    await expect(readFile(path.join(outDir, "testVideo12", "video", "clip-manifest.json"), "utf8"))
      .resolves
      .toContain('"source": "full_video"');
  });

  it("supports video-only mode without transcript artifacts", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-video-only-"));
    const runner = createMockRunner({});

    const result = await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      videoClip: { enabled: true, videoOnly: true, durationSeconds: 30 },
      runner,
      timeoutMs: 60_000,
    });

    expect(result.ok).toBe(true);
    const videoDir = path.join(outDir, "testVideo12");
    await expect(readFile(path.join(videoDir, "video", "clip-manifest.json"), "utf8")).resolves.toContain(
      '"file": "video/full.mp4"',
    );
    await expect(readFile(path.join(videoDir, "chunks.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps normal acquire ok when optional video clip download fails", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-clip-fail-"));
    const runner = createMockRunner({ failVideoClip: true });

    const result = await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      videoClip: { enabled: true, videoOnly: false, durationSeconds: 30 },
      runner,
      timeoutMs: 60_000,
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toContain("video clip download failed");
    await expect(readFile(path.join(outDir, "testVideo12", "chunks.md"), "utf8")).resolves.toContain(
      "Hello integration test",
    );
  });

  it("fails video-only mode when the clip download fails", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-prep-video-only-fail-"));
    const runner = createMockRunner({ failVideoClip: true });

    const result = await prepareYoutubeVideo({
      url: "https://www.youtube.com/watch?v=testVideo12",
      outDir,
      maxWords: 900,
      keyframes: 0,
      sceneThreshold: 0.35,
      sceneMinGap: 12,
      videoClip: { enabled: true, videoOnly: true, durationSeconds: 30 },
      runner,
      timeoutMs: 60_000,
    });

    expect(result.ok).toBe(false);
    expect(result.warnings.join("\n")).toContain("video clip download failed");
    expect(result.warnings.join("\n")).toContain("missing required artifacts");
  });
});
