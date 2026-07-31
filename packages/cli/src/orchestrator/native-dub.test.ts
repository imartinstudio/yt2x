import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as AdaptersNode from "@yt2x/adapters-node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const probeDemucsMock = vi.hoisted(() => vi.fn(async () => "/usr/bin/python3"));
const generateDubScriptMock = vi.hoisted(() => vi.fn());
const synthesizeDubLinesMock = vi.hoisted(() => vi.fn());
const separateDemucsMock = vi.hoisted(() => vi.fn());
const remixDubbedVideoMock = vi.hoisted(() => vi.fn());
const guardMock = vi.hoisted(() =>
  vi.fn(async () => {
    throw Object.assign(new Error("hard subs"), {
      name: "DubHardSubtitleError",
      code: "DUB_HARD_SUBTITLE_SOURCE",
    });
  }),
);

vi.mock("@yt2x/adapters-node", async (importOriginal) => {
  const actual = await importOriginal<typeof AdaptersNode>();
  return {
    ...actual,
    createLlmAdapter: vi.fn(() => ({ chat: vi.fn() })),
    probeDemucs: probeDemucsMock,
    generateDubScript: generateDubScriptMock,
    synthesizeDubLines: synthesizeDubLinesMock,
    separateDemucs: separateDemucsMock,
    remixDubbedVideo: remixDubbedVideoMock,
    guardDubSourceAgainstHardSubtitles: guardMock,
  };
});

import { executeNativeDub } from "./native-dub.js";

beforeEach(() => {
  probeDemucsMock.mockClear();
  generateDubScriptMock.mockClear();
  synthesizeDubLinesMock.mockClear();
  separateDemucsMock.mockClear();
  remixDubbedVideoMock.mockClear();
  guardMock.mockClear();
  guardMock.mockImplementation(async () => {
    throw Object.assign(new Error("hard subs"), {
      name: "DubHardSubtitleError",
      code: "DUB_HARD_SUBTITLE_SOURCE",
      message:
        "Source video already has burned Chinese hard subtitles. Use an unburned original.",
    });
  });
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
});

describe("executeNativeDub hard-subtitle guard", () => {
  it("refuses before Demucs, LLM rewrite, or TTS when the source has Chinese hard subs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-dub-guard-"));
    const outRoot = path.join(root, "downloads");
    const articleRoot = path.join(root, "articles");
    const videoId = "abc12345678";
    await mkdir(path.join(outRoot, videoId, "video"), { recursive: true });
    await mkdir(path.join(articleRoot, videoId, "video"), { recursive: true });
    await writeFile(path.join(outRoot, videoId, "video", "full.mp4"), "original");
    await writeFile(
      path.join(articleRoot, videoId, "video", "full.zh.srt"),
      "1\n00:00:01,000 --> 00:00:02,000\n你好\n",
    );

    const code = await executeNativeDub({
      videoId,
      outDir: outRoot,
      articleOutDir: articleRoot,
    });

    expect(code).toBeGreaterThan(0);
    expect(guardMock).toHaveBeenCalledOnce();
    expect(probeDemucsMock).not.toHaveBeenCalled();
    expect(generateDubScriptMock).not.toHaveBeenCalled();
    expect(synthesizeDubLinesMock).not.toHaveBeenCalled();
    expect(separateDemucsMock).not.toHaveBeenCalled();
    expect(remixDubbedVideoMock).not.toHaveBeenCalled();
  });
});
