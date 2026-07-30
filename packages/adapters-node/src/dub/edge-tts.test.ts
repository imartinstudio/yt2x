import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isTtsError } from "@yt2x/core";
import {
  DEFAULT_EDGE_TTS_VOICE,
  EDGE_TTS_ENGINE_ID,
  EDGE_TTS_RATE_RANGE,
  createEdgeTtsAdapter,
  formatEdgeTtsRate,
} from "./edge-tts.js";
import { ProcessError } from "../process/index.js";
import type { ProcessResult, ProcessRunner, ProcessSpec } from "../process/index.js";

const okResult = (spec: ProcessSpec, stdout = ""): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 1,
  command: spec.command,
  args: spec.args ?? [],
});

const mediaPathOf = (spec: ProcessSpec): string => {
  const args = spec.args ?? [];
  const at = args.indexOf("--write-media");
  return args[at + 1] ?? "";
};

/** 真 edge-tts 由子进程写文件，mock runner 也得写，否则读回来的路径永远是空的。 */
const writingRunner = (bytes: Uint8Array): { runner: ProcessRunner; specs: ProcessSpec[] } => {
  const specs: ProcessSpec[] = [];
  const runner: ProcessRunner = {
    run: async (spec) => {
      specs.push(spec);
      const target = mediaPathOf(spec);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return okResult(spec);
    },
  };
  return { runner, specs };
};

const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

describe("formatEdgeTtsRate", () => {
  it("maps a multiplier to a signed percentage string", () => {
    expect(formatEdgeTtsRate(1)).toBe("+0%");
    expect(formatEdgeTtsRate(1.15)).toBe("+15%");
    expect(formatEdgeTtsRate(2)).toBe("+100%");
    expect(formatEdgeTtsRate(0.9)).toBe("-10%");
    expect(formatEdgeTtsRate(0.5)).toBe("-50%");
  });

  it("rounds to whole percent", () => {
    expect(formatEdgeTtsRate(1.234)).toBe("+23%");
    expect(formatEdgeTtsRate(0.996)).toBe("+0%");
  });
});

describe("createEdgeTtsAdapter", () => {
  it("declares its engine id and rate range", () => {
    const tts = createEdgeTtsAdapter();
    expect(tts.id).toBe(EDGE_TTS_ENGINE_ID);
    expect(tts.rateRange).toEqual({ min: 0.5, max: 2.0 });
    expect(EDGE_TTS_RATE_RANGE).toEqual({ min: 0.5, max: 2.0 });
  });

  it("invokes the confirmed edge-tts CLI shape and returns the written audio", async () => {
    const { runner, specs } = writingRunner(audio);
    const tts = createEdgeTtsAdapter({ runner });

    const result = await tts.synthesize({
      text: "  今天我们来聊配音  ",
      voice: DEFAULT_EDGE_TTS_VOICE,
      rate: 1,
    });

    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    expect(spec.command).toBe("edge-tts");
    const args = spec.args ?? [];
    expect(args[0]).toBe("-t");
    expect(args[1]).toBe("今天我们来聊配音");
    expect(args[2]).toBe("-v");
    expect(args[3]).toBe(DEFAULT_EDGE_TTS_VOICE);
    expect(args).toContain("--rate=+0%");
    expect(args).toContain("--write-media");
    expect(mediaPathOf(spec).endsWith(".mp3")).toBe(true);

    expect(result.audio).toEqual(audio);
    expect(result.format).toBe("mp3");
    expect(result.voice).toBe(DEFAULT_EDGE_TTS_VOICE);
    expect(result.rate).toBe(1);
  });

  it("clamps the requested rate into the engine range and reports the used value", async () => {
    const { runner, specs } = writingRunner(audio);
    const tts = createEdgeTtsAdapter({ runner });

    const fast = await tts.synthesize({ text: "太快了", voice: "v", rate: 5 });
    expect(fast.rate).toBe(2);
    expect(specs[0]?.args).toContain("--rate=+100%");

    const slow = await tts.synthesize({ text: "太慢了", voice: "v", rate: 0.1 });
    expect(slow.rate).toBe(0.5);
    expect(specs[1]?.args).toContain("--rate=-50%");
  });

  it("defaults a missing rate to 1.0", async () => {
    const { runner, specs } = writingRunner(audio);
    const tts = createEdgeTtsAdapter({ runner });
    const result = await tts.synthesize({ text: "默认语速", voice: "v" });
    expect(result.rate).toBe(1);
    expect(specs[0]?.args).toContain("--rate=+0%");
  });

  it("honours a custom command path", async () => {
    const { runner, specs } = writingRunner(audio);
    const tts = createEdgeTtsAdapter({ runner, command: "/opt/bin/edge-tts" });
    await tts.synthesize({ text: "自定义路径", voice: "v" });
    expect(specs[0]?.command).toBe("/opt/bin/edge-tts");
  });

  it("removes its temp directory after a successful run", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-edge-tts-test-"));
    const { runner } = writingRunner(audio);
    const tts = createEdgeTtsAdapter({ runner, tmpDir: tmpRoot });
    await tts.synthesize({ text: "清理临时目录", voice: "v" });
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("removes its temp directory after a failure too", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-edge-tts-test-"));
    const runner: ProcessRunner = {
      run: async (spec) => {
        await mkdir(path.dirname(mediaPathOf(spec)), { recursive: true });
        await writeFile(mediaPathOf(spec), new Uint8Array());
        return okResult(spec);
      },
    };
    const tts = createEdgeTtsAdapter({ runner, tmpDir: tmpRoot });
    await expect(tts.synthesize({ text: "失败也要清理", voice: "v" })).rejects.toThrow();
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("rejects empty text as BAD_REQUEST without spawning anything", async () => {
    let called = false;
    const runner: ProcessRunner = {
      run: async (spec) => {
        called = true;
        return okResult(spec);
      },
    };
    const tts = createEdgeTtsAdapter({ runner });
    await expect(tts.synthesize({ text: "   ", voice: "v" })).rejects.toMatchObject({
      name: "TtsError",
      kind: "BAD_REQUEST",
    });
    expect(called).toBe(false);
  });

  it("rejects an empty voice as BAD_REQUEST", async () => {
    const { runner } = writingRunner(audio);
    const tts = createEdgeTtsAdapter({ runner });
    await expect(tts.synthesize({ text: "有文本没音色", voice: " " })).rejects.toMatchObject({
      kind: "BAD_REQUEST",
    });
  });

  it("rejects a wav request as BAD_REQUEST — edge-tts only writes mp3", async () => {
    const { runner } = writingRunner(audio);
    const tts = createEdgeTtsAdapter({ runner });
    await expect(
      tts.synthesize({ text: "要 wav", voice: "v", format: "wav" }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });

  it("maps a missing binary to UNAVAILABLE instead of degrading silently", async () => {
    const runner: ProcessRunner = {
      run: async (spec) => {
        throw new ProcessError("NOT_FOUND", "Command not found", {
          command: spec.command,
          args: spec.args ?? [],
        });
      },
    };
    const tts = createEdgeTtsAdapter({ runner });
    const err = await tts.synthesize({ text: "没装", voice: "v" }).catch((e: unknown) => e);
    expect(isTtsError(err)).toBe(true);
    expect(err).toMatchObject({ kind: "UNAVAILABLE", context: { engine: "edge-tts", voice: "v" } });
    expect((err as Error).message).toContain("edge-tts");
  });

  it("maps a spawn failure to UNAVAILABLE", async () => {
    const runner: ProcessRunner = {
      run: async (spec) => {
        throw new ProcessError("SPAWN_FAILED", "spawn failed", {
          command: spec.command,
          args: spec.args ?? [],
        });
      },
    };
    const tts = createEdgeTtsAdapter({ runner });
    await expect(tts.synthesize({ text: "起不来", voice: "v" })).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
  });

  it("maps a timeout to a retriable NETWORK error", async () => {
    const runner: ProcessRunner = {
      run: async (spec) => {
        throw new ProcessError("TIMEOUT", "timed out", {
          command: spec.command,
          args: spec.args ?? [],
        });
      },
    };
    const tts = createEdgeTtsAdapter({ runner });
    await expect(tts.synthesize({ text: "超时", voice: "v" })).rejects.toMatchObject({
      kind: "NETWORK",
      context: { retriable: true },
    });
  });

  it("maps an abort to UNKNOWN", async () => {
    const runner: ProcessRunner = {
      run: async (spec) => {
        throw new ProcessError("KILLED", "cancelled", {
          command: spec.command,
          args: spec.args ?? [],
        });
      },
    };
    const tts = createEdgeTtsAdapter({ runner });
    await expect(tts.synthesize({ text: "中止", voice: "v" })).rejects.toMatchObject({
      kind: "UNKNOWN",
    });
  });

  it("maps an edge-tts 'No audio was received' exit to BAD_RESPONSE", async () => {
    const runner: ProcessRunner = {
      run: async (spec) => {
        throw new ProcessError("NON_ZERO_EXIT", "exited 1", {
          command: spec.command,
          args: spec.args ?? [],
          exitCode: 1,
          stderrExcerpt: "Exception: No audio was received. Please verify parameters",
        });
      },
    };
    const tts = createEdgeTtsAdapter({ runner });
    await expect(tts.synthesize({ text: "空音频", voice: "v" })).rejects.toMatchObject({
      kind: "BAD_RESPONSE",
    });
  });

  it("maps an unknown voice to BAD_REQUEST", async () => {
    const runner: ProcessRunner = {
      run: async (spec) => {
        throw new ProcessError("NON_ZERO_EXIT", "exited 1", {
          command: spec.command,
          args: spec.args ?? [],
          exitCode: 1,
          stderrExcerpt: "Invalid voice zh-CN-NopeNeural",
        });
      },
    };
    const tts = createEdgeTtsAdapter({ runner });
    await expect(tts.synthesize({ text: "音色不存在", voice: "zh-CN-NopeNeural" })).rejects.toMatchObject(
      { kind: "BAD_REQUEST" },
    );
  });

  it("maps any other non-zero exit to UNKNOWN", async () => {
    const runner: ProcessRunner = {
      run: async (spec) => {
        throw new ProcessError("NON_ZERO_EXIT", "exited 3", {
          command: spec.command,
          args: spec.args ?? [],
          exitCode: 3,
          stderrExcerpt: "some other failure",
        });
      },
    };
    const tts = createEdgeTtsAdapter({ runner });
    await expect(tts.synthesize({ text: "别的错", voice: "v" })).rejects.toMatchObject({
      kind: "UNKNOWN",
    });
  });

  it("maps a non-ProcessError throw to UNKNOWN", async () => {
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error("boom");
      },
    };
    const tts = createEdgeTtsAdapter({ runner });
    await expect(tts.synthesize({ text: "意外", voice: "v" })).rejects.toMatchObject({
      kind: "UNKNOWN",
    });
  });

  it("treats a zero-byte file as BAD_RESPONSE", async () => {
    const { runner } = writingRunner(new Uint8Array());
    const tts = createEdgeTtsAdapter({ runner });
    await expect(tts.synthesize({ text: "零字节", voice: "v" })).rejects.toMatchObject({
      kind: "BAD_RESPONSE",
    });
  });

  it("treats a successful exit with no file as BAD_RESPONSE", async () => {
    const runner: ProcessRunner = { run: async (spec) => okResult(spec) };
    const tts = createEdgeTtsAdapter({ runner });
    await expect(tts.synthesize({ text: "没写文件", voice: "v" })).rejects.toMatchObject({
      kind: "BAD_RESPONSE",
    });
  });
});
