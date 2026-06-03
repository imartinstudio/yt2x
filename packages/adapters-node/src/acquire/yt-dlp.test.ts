import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner, ProcessSpec } from "../process/index.js";
import { downloadSubtitlesTwoPhase, ensureOfficialYoutubeThumbnail } from "./yt-dlp.js";

let videoDir: string;

beforeEach(async () => {
  videoDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-thumb-"));
});

afterEach(async () => {
  await rm(videoDir, { recursive: true, force: true });
});

describe("ensureOfficialYoutubeThumbnail", () => {
  it("downloads official thumbnail even when scene screenshots already exist", async () => {
    const screenshotsDir = path.join(videoDir, "screenshots");
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(path.join(screenshotsDir, "contact_sheet.jpg"), Buffer.from([0xff, 0xd8]));

    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      run: vi.fn(async (spec) => {
        calls.push(spec);
        await writeFile(path.join(screenshotsDir, "youtube_cover.jpg"), Buffer.from([0xff, 0xd8]));
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

    const warnings: string[] = [];
    const cover = await ensureOfficialYoutubeThumbnail("https://www.youtube.com/watch?v=<videoId>", videoDir, {
      runner,
      timeoutMs: 60_000,
    }, warnings);

    expect(cover).toBe("youtube_cover.jpg");
    expect(warnings).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("--write-thumbnail");
  });

  it("skips download when official thumbnail already exists", async () => {
    const screenshotsDir = path.join(videoDir, "screenshots");
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(path.join(screenshotsDir, "youtube_cover.webp"), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    const runner: ProcessRunner = {
      run: vi.fn(async (spec) => ({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
        command: spec.command,
        args: spec.args ?? [],
      })),
    };

    const cover = await ensureOfficialYoutubeThumbnail("https://www.youtube.com/watch?v=<videoId>", videoDir, {
      runner,
      timeoutMs: 60_000,
    }, []);

    expect(cover).toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe("downloadSubtitlesTwoPhase", () => {
  it("tries Simplified Chinese auto subtitles before Traditional Chinese fallbacks", async () => {
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      run: vi.fn(async (spec) => {
        calls.push(spec);
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

    await downloadSubtitlesTwoPhase("https://www.youtube.com/watch?v=<videoId>", videoDir, {
      runner,
      timeoutMs: 60_000,
      videoLanguage: "en",
      manualSubLangs: "zh-CN,zh-Hans,zh,zh-Hant,zh-TW,en",
    });

    const autoLangs = calls
      .filter((call) => (call.args ?? []).includes("--write-auto-subs"))
      .map((call) => {
        const args = call.args ?? [];
        return args[args.indexOf("--sub-langs") + 1];
      });

    expect(autoLangs.slice(0, 5)).toEqual(["zh-CN", "zh-Hans", "zh", "zh-Hant", "zh-TW"]);
  });
});
