import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeNativeAcquire } from "./execute-native-acquire.js";
import { isStepDone } from "../fs/process-status-store.js";

vi.mock("./prepare-youtube-video.js", () => ({
  prepareYoutubeVideo: vi.fn(async (opts: { url: string; outDir: string }) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const videoId = "dQw4w9WgXcQ";
    const videoDir = path.join(opts.outDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await writeFile(path.join(videoDir, "metadata.json"), "{}\n", "utf8");
    await writeFile(path.join(videoDir, "chunks.md"), "# chunks\n", "utf8");
    await writeFile(path.join(videoDir, "timestamped-cues.md"), "# cues\n", "utf8");
    return {
      url: opts.url,
      dir: videoDir,
      ok: true,
      warnings: [],
      video_id: videoId,
    };
  }),
}));

const baseStages = {
  acquire: "auto" as const,
  notes: "skip" as const,
  article: "skip" as const,
  publish: "skip" as const,
};

describe("executeNativeAcquire", () => {
  it("marks acquire done in process-status when prepare succeeds (no root pipeline-state file)", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-acq-"));
    const { prepareYoutubeVideo } = await import("./prepare-youtube-video.js");

    const code = await executeNativeAcquire({
      monorepoRoot: "/tmp/yt2x-fake-root",
      outDir,
      sources: { urls: ["https://youtu.be/dQw4w9WgXcQ"] },
      acquire: {
        keyframes: 0,
        sceneThreshold: 0.35,
        sceneMinGap: 12,
        maxWords: 900,
        jobs: 3,
      },
      stages: baseStages,
      control: { continueFlag: false, errorStrategy: "stop" },
      flags: { verbose: false },
    });

    expect(code).toBe(0);
    const videoDir = path.join(outDir, "dQw4w9WgXcQ");
    await expect(isStepDone(videoDir, "acquire")).resolves.toBe(true);
    await expect(access(path.join(outDir, "pipeline-state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(prepareYoutubeVideo).toHaveBeenCalledTimes(1);
  });

  it("marks acquire done under result.dir when metadata id differs from URL id", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-acq-id-"));
    const { prepareYoutubeVideo } = await import("./prepare-youtube-video.js");
    const canonicalId = "4ByJZRP5oYI";
    const urlId = "shortUrlId";
    vi.mocked(prepareYoutubeVideo).mockImplementationOnce(async (opts) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const videoDir = path.join(opts.outDir, canonicalId);
      await mkdir(videoDir, { recursive: true });
      await writeFile(path.join(videoDir, "metadata.json"), "{}\n", "utf8");
      await writeFile(path.join(videoDir, "chunks.md"), "# chunks\n", "utf8");
      await writeFile(path.join(videoDir, "timestamped-cues.md"), "# cues\n", "utf8");
      return {
        url: opts.url,
        dir: videoDir,
        ok: true,
        warnings: [],
        video_id: canonicalId,
      };
    });

    const code = await executeNativeAcquire({
      monorepoRoot: "/tmp",
      outDir,
      sources: { urls: [`https://youtu.be/${urlId}`] },
      acquire: {
        keyframes: 0,
        sceneThreshold: 0.35,
        sceneMinGap: 12,
        maxWords: 900,
        jobs: 3,
      },
      stages: baseStages,
      control: { continueFlag: false, errorStrategy: "stop" },
      flags: { verbose: false },
    });

    expect(code).toBe(0);
    await expect(isStepDone(path.join(outDir, canonicalId), "acquire")).resolves.toBe(true);
    await expect(isStepDone(path.join(outDir, urlId), "acquire")).resolves.toBe(false);
  });

  it("returns 1 when no sources on fresh run", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-acq-empty-"));
    const code = await executeNativeAcquire({
      monorepoRoot: "/tmp",
      outDir,
      sources: { urls: [] },
      acquire: {
        keyframes: 0,
        sceneThreshold: 0.35,
        sceneMinGap: 12,
        maxWords: 900,
        jobs: 3,
      },
      stages: baseStages,
      control: { continueFlag: false, errorStrategy: "stop" },
      flags: { verbose: false },
    });
    expect(code).toBe(1);
  });

  it("prints acquire failure details without requiring verbose mode", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-acq-fail-"));
    const { prepareYoutubeVideo } = await import("./prepare-youtube-video.js");
    vi.mocked(prepareYoutubeVideo).mockImplementationOnce(async (opts) => {
      const { mkdir } = await import("node:fs/promises");
      const videoDir = path.join(opts.outDir, "failVideo");
      await mkdir(videoDir, { recursive: true });
      return {
        url: opts.url,
        dir: videoDir,
        ok: false,
        warnings: [
          "metadata failed: yt-dlp exited 1: Sign in to confirm you are not a bot",
          "missing required artifacts: metadata.json, chunks.md, timestamped-cues.md",
        ],
        video_id: "failVideo",
      };
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const code = await executeNativeAcquire({
        monorepoRoot: "/tmp",
        outDir,
        sources: { urls: ["https://youtu.be/failVideo"] },
        acquire: {
          keyframes: 0,
          sceneThreshold: 0.35,
          sceneMinGap: 12,
          maxWords: 900,
          jobs: 3,
        },
        stages: baseStages,
        control: { continueFlag: false, errorStrategy: "stop" },
        flags: { verbose: false },
      });

      expect(code).toBe(1);
      const output = errorSpy.mock.calls.flat().join("\n");
      expect(output).toContain("ERROR yt2x acquire failed for failVideo");
      expect(output).toContain("Reason:");
      expect(output).toContain("Sign in to confirm you are not a bot");
      expect(output).toContain("Details:");
      expect(output).toContain("process-status.json");
      expect(output).toContain("Hint:");
      expect(output).toContain("YouTube requires sign-in or bot verification");
      expect(output).toContain("--cookies-from-browser chrome");
      expect(output).toContain(
        "pnpm yt2x acquire --urls 'https://youtu.be/failVideo' --cookies-from-browser chrome",
      );
      expect(output.indexOf("Hint:")).toBeGreaterThan(output.indexOf("Details:"));
      expect(output.indexOf("pnpm yt2x acquire")).toBeGreaterThan(
        output.indexOf("Retry with --cookies-from-browser chrome"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
