import { describe, expect, it, vi } from "vitest";
import type { ProcessResult, ProcessRunner, ProcessSpec } from "../process/index.js";
import { DemucsError, probeDemucs, separateDemucs } from "./demucs.js";

const okResult = (spec: ProcessSpec, stdout = '{"ok":true}\n'): ProcessResult => ({
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

describe("probeDemucs", () => {
  it("returns the python path when probe exits 0", async () => {
    const runner: ProcessRunner = {
      run: async (spec) => okResult(spec),
    };
    await expect(probeDemucs({ runner, pythonPath: "/usr/bin/python3" })).resolves.toBe(
      "/usr/bin/python3",
    );
  });

  it("throws UNAVAILABLE when the probe process fails", async () => {
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error('Command "python3" exited with code 2.');
      },
    };
    await expect(probeDemucs({ runner })).rejects.toMatchObject({
      name: "DemucsError",
      kind: "UNAVAILABLE",
    });
  });
});

describe("separateDemucs", () => {
  it("skips when no_vocals.wav already exists", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "yt2x-demucs-test-"));
    try {
      await writeFile(path.join(dir, "no_vocals.wav"), "fake");
      const run = vi.fn();
      const runner: ProcessRunner = { run };
      const result = await separateDemucs({
        inputPath: "/tmp/in.mp4",
        outDir: dir,
        runner,
      });
      expect(result.skipped).toBe(true);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws FAILED when demucs exits non-zero", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "yt2x-demucs-fail-"));
    try {
      const runner: ProcessRunner = {
        run: async () => {
          throw new Error("exit 1");
        },
      };
      await expect(
        separateDemucs({
          inputPath: "/tmp/in.mp4",
          outDir: dir,
          runner,
          pythonPath: "python3",
          skipIfExists: false,
        }),
      ).rejects.toBeInstanceOf(DemucsError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
