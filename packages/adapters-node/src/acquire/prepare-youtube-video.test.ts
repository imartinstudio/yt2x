import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner, ProcessResult, ProcessSpec } from "../process/index.js";
import { prepareYoutubeVideo } from "./prepare-youtube-video.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const SAMPLE_METADATA = {
  id: "testVideo12",
  title: "Integration Test Video",
  language: "en",
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
        if (videoDir !== null && !subtitleWritten) {
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

      if (spec.command === "yt-dlp") {
        return baseProcessResult(spec);
      }

      if (spec.command === "ffmpeg") {
        return baseProcessResult(spec);
      }

      return baseProcessResult(spec);
    }),
  };
};

describe("prepareYoutubeVideo (integration, mocked yt-dlp)", () => {
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
});
