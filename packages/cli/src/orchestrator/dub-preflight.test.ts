import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeLocalMock = vi.hoisted(() =>
  vi.fn(async () => ({
    srtPath: "video/full.local.en.srt",
    wordsPath: "video/full.local.en.words.json",
    cueCount: 1,
  })),
);
const probeDemucsMock = vi.hoisted(() => vi.fn(async () => "/usr/bin/python3"));

vi.mock("@yt2x/adapters-node", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    transcribeLocal: transcribeLocalMock,
    probeDemucs: probeDemucsMock,
  };
});

import { logger } from "../logger.js";
import { allVideosAlreadyDubbed, ensureDubPreflight } from "./dub-preflight.js";

beforeEach(() => {
  transcribeLocalMock.mockClear();
  transcribeLocalMock.mockResolvedValue({
    srtPath: "video/full.local.en.srt",
    wordsPath: "video/full.local.en.words.json",
    cueCount: 1,
  });
  probeDemucsMock.mockClear();
  probeDemucsMock.mockResolvedValue("/usr/bin/python3");
});

describe("allVideosAlreadyDubbed", () => {
  it("returns false for an empty video list", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-empty-"));
    await expect(allVideosAlreadyDubbed(root, [])).resolves.toBe(false);
  });

  it("returns true only when every id has full.zh-dubbed.mp4", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-alldubbed-"));
    await mkdir(path.join(root, "vid1", "video"), { recursive: true });
    await writeFile(path.join(root, "vid1", "video", "full.zh-dubbed.mp4"), "x");
    await mkdir(path.join(root, "vid2", "video"), { recursive: true });
    await expect(allVideosAlreadyDubbed(root, ["vid1", "vid2"])).resolves.toBe(false);
    await writeFile(path.join(root, "vid2", "video", "full.zh-dubbed.mp4"), "x");
    await expect(allVideosAlreadyDubbed(root, ["vid1", "vid2"])).resolves.toBe(true);
  });
});

describe("ensureDubPreflight", () => {
  it("skips engine/TTS/demucs checks when every target video is already dubbed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-skip-"));
    const outRoot = path.join(root, "downloads");
    const articleOutRoot = path.join(root, "articles");
    await mkdir(path.join(articleOutRoot, "vid1", "video"), { recursive: true });
    await writeFile(path.join(articleOutRoot, "vid1", "video", "full.zh-dubbed.mp4"), "x");

    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot,
      articleOutRoot,
      dubEngineFlag: "edge-tts",
    });

    expect(result).toEqual({ ok: true });
    expect(probeDemucsMock).not.toHaveBeenCalled();
    expect(transcribeLocalMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid --dub-engine before touching demucs/transcription", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-bad-engine-"));
    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot: path.join(root, "downloads"),
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "not-a-real-engine",
    });
    expect(result).toEqual({ ok: false, exitCode: expect.any(Number) });
    expect(probeDemucsMock).not.toHaveBeenCalled();
  });

  it("returns ok:false with CONFIG_MISSING when demucs is unavailable", async () => {
    probeDemucsMock.mockRejectedValueOnce(
      Object.assign(new Error("demucs not found"), { name: "DemucsError" }),
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-no-demucs-"));
    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot: path.join(root, "downloads"),
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "edge-tts",
    });
    expect(result.ok).toBe(false);
    expect(transcribeLocalMock).not.toHaveBeenCalled();
  });

  it("transcribes videos that have no local word-level transcript yet", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-transcribe-"));
    const outRoot = path.join(root, "downloads");
    await mkdir(path.join(outRoot, "vid1"), { recursive: true });

    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot,
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "edge-tts",
    });

    expect(result).toEqual({ ok: true });
    expect(transcribeLocalMock).toHaveBeenCalledOnce();
    expect(transcribeLocalMock.mock.calls[0]![0]).toMatchObject({
      videoDir: path.join(outRoot, "vid1"),
      language: "en",
    });
  });

  it("skips transcription for videos that already have a local word-level transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-has-words-"));
    const outRoot = path.join(root, "downloads");
    await mkdir(path.join(outRoot, "vid1", "video"), { recursive: true });
    await writeFile(
      path.join(outRoot, "vid1", "video", "full.local.en.words.json"),
      JSON.stringify([{ word: "hi", start: 0, end: 0.2 }]),
    );

    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot,
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "edge-tts",
    });

    expect(result).toEqual({ ok: true });
    expect(transcribeLocalMock).not.toHaveBeenCalled();
  });

  it("returns ok:false with CONFIG_MISSING when local transcription is unavailable", async () => {
    transcribeLocalMock.mockResolvedValueOnce(undefined);
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-transcribe-fail-"));
    const outRoot = path.join(root, "downloads");
    await mkdir(path.join(outRoot, "vid1"), { recursive: true });

    const result = await ensureDubPreflight({
      videoIds: ["vid1"],
      outRoot,
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "edge-tts",
    });

    expect(result.ok).toBe(false);
  });

  it("passes an explicit pythonPath through to probeDemucs unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-python-path-"));
    await ensureDubPreflight({
      videoIds: [],
      outRoot: path.join(root, "downloads"),
      articleOutRoot: path.join(root, "articles"),
      dubEngineFlag: "edge-tts",
      pythonPath: "/explicit/python3",
    });
    expect(probeDemucsMock).toHaveBeenCalledWith(
      expect.objectContaining({ pythonPath: "/explicit/python3" }),
    );
  });

  describe("commandLabel", () => {
    it("defaults the log message prefix to 'yt2x pipeline --dub' when not provided", async () => {
      const infoSpy = vi.spyOn(logger, "info");
      const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-label-default-"));
      const articleOutRoot = path.join(root, "articles");
      await mkdir(path.join(articleOutRoot, "vid1", "video"), { recursive: true });
      await writeFile(path.join(articleOutRoot, "vid1", "video", "full.zh-dubbed.mp4"), "x");

      await ensureDubPreflight({
        videoIds: ["vid1"],
        outRoot: path.join(root, "downloads"),
        articleOutRoot,
        dubEngineFlag: "edge-tts",
      });

      expect(infoSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("yt2x pipeline --dub: all target videos already have a dubbed output"),
      );
      infoSpy.mockRestore();
    });

    it("uses a custom commandLabel as the log message prefix instead", async () => {
      const infoSpy = vi.spyOn(logger, "info");
      const errorSpy = vi.spyOn(logger, "error");
      const root = await mkdtemp(path.join(os.tmpdir(), "dub-preflight-label-custom-"));

      const result = await ensureDubPreflight({
        videoIds: ["vid1"],
        outRoot: path.join(root, "downloads"),
        articleOutRoot: path.join(root, "articles"),
        dubEngineFlag: "not-a-real-engine",
        commandLabel: "yt2x video",
      });

      expect(result).toEqual({ ok: false, exitCode: expect.any(Number) });
      expect(errorSpy).toHaveBeenCalledWith(expect.anything(), "yt2x video: invalid --dub-engine");
      expect(infoSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("yt2x pipeline --dub"),
      );
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
