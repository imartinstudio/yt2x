import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { burnSubtitles, validateSrtIntegrity, verifyBurnedSubtitles } from "./burn-subtitles.js";
import type { ProcessRunner, ProcessSpec, ProcessResult } from "../process/index.js";

vi.mock("./resolve-python.js", () => ({
  resolvePythonWithPillow: vi.fn().mockResolvedValue("python3"),
}));

const seedSrt = async (text: string): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "yt2x-burn-"));
  const srtPath = path.join(dir, "test.srt");
  await writeFile(srtPath, text, "utf8");
  return srtPath;
};

// ---------------------------------------------------------------------------
// validateSrtIntegrity
// ---------------------------------------------------------------------------

describe("validateSrtIntegrity", () => {
  it("passes a well-formed SRT", async () => {
    const srtPath = await seedSrt(`1
00:00:01,000 --> 00:00:03,500
Hello world

2
00:00:04,000 --> 00:00:06,000
Second line
`);
    const result = await validateSrtIntegrity(srtPath);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("flags overlapping cues", async () => {
    const srtPath = await seedSrt(`1
00:00:01,000 --> 00:00:05,000
First

2
00:00:03,000 --> 00:00:07,000
Overlaps with first
`);
    const result = await validateSrtIntegrity(srtPath);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.kind === "overlap")).toBe(true);
  });

  it("flags empty text cues as non-fatal warnings", async () => {
    const srtPath = await seedSrt(`1
00:00:01,000 --> 00:00:03,000
Hello

2
00:00:04,000 --> 00:00:06,000


3
00:00:07,000 --> 00:00:09,000
After empty
`);
    const result = await validateSrtIntegrity(srtPath);
    // Empty-text cues are non-fatal — they are silently skipped by the Python renderer.
    expect(result.valid).toBe(true);
    expect(result.issues.some((i) => i.kind === "empty_text")).toBe(true);
    // Fatal issue kinds should NOT be present
    expect(result.issues.some((i) => i.kind === "overlap" || i.kind === "negative_duration" || i.kind === "no_cues")).toBe(false);
  });

  it("flags negative duration cues", async () => {
    const srtPath = await seedSrt(`1
00:00:05,000 --> 00:00:01,000
End before start
`);
    const result = await validateSrtIntegrity(srtPath);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.kind === "negative_duration")).toBe(true);
  });

  it("reports gaps > 500ms between consecutive cues (non-fatal)", async () => {
    const srtPath = await seedSrt(`1
00:00:01,000 --> 00:00:03,000
First

2
00:00:05,000 --> 00:00:07,000
Two second gap
`);
    const result = await validateSrtIntegrity(srtPath);
    // Gaps are warnings, not fatal — valid stays true
    expect(result.valid).toBe(true);
    expect(result.issues.some((i) => i.kind === "gap")).toBe(true);
    const gapIssue = result.issues.find((i) => i.kind === "gap")!;
    expect(gapIssue.message).toContain("2000ms");
  });

  it("does not flag small gaps (<= 500ms)", async () => {
    const srtPath = await seedSrt(`1
00:00:01,000 --> 00:00:03,000
First

2
00:00:03,200 --> 00:00:05,000
200ms gap is fine
`);
    const result = await validateSrtIntegrity(srtPath);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.kind === "gap")).toHaveLength(0);
  });

  it("returns invalid for empty SRT file", async () => {
    const srtPath = await seedSrt("");
    const result = await validateSrtIntegrity(srtPath);
    expect(result.valid).toBe(false);
  });

  it("handles zero-duration cues (start == end)", async () => {
    const srtPath = await seedSrt(`1
00:00:03,000 --> 00:00:03,000
Instant cue
`);
    const result = await validateSrtIntegrity(srtPath);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.kind === "negative_duration")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyBurnedSubtitles
// ---------------------------------------------------------------------------

describe("verifyBurnedSubtitles", () => {
  it("passes when all check frames have visible subtitles", async () => {
    const srtPath = await seedSrt(`1
00:00:01,000 --> 00:00:05,000
Hello

2
00:00:05,000 --> 00:00:10,000
World
`);
    const createdFiles = new Set<string>();

    // Runner that creates frame files for stat checks
    const runner: ProcessRunner = {
      run: async (spec: ProcessSpec): Promise<ProcessResult> => {
        if (spec.command === "ffmpeg") {
          // Find the output file path (last arg before -y) and create it
          const args = spec.args ?? [];
          for (let i = args.length - 1; i >= 0; i--) {
            if (args[i]?.endsWith(".png")) {
              const dir = path.dirname(args[i]!);
              await mkdir(dir, { recursive: true });
              await writeFile(args[i]!, "");
              createdFiles.add(args[i]!);
              break;
            }
          }
          return makeResult(0, spec);
        }
        if (spec.command === "python3") {
          return makeResult(0, spec, "PASS score=85 (brightness_drop=15.2, std=28.3, edge_ratio=0.0321)");
        }
        return makeResult(1, spec, "unknown command");
      },
    };

    const result = await verifyBurnedSubtitles("/tmp/fake-burned.mp4", "/tmp/fake-orig.mp4", srtPath, runner);
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("fails when any check frame lacks subtitles", async () => {
    const srtPath = await seedSrt(`1
00:00:01,000 --> 00:00:05,000
Hello

2
00:00:05,000 --> 00:00:10,000
World
`);

    let callCount = 0;
    const runner: ProcessRunner = {
      run: async (spec: ProcessSpec): Promise<ProcessResult> => {
        if (spec.command === "ffmpeg") {
          // Create the output frame file for stat check
          const args = spec.args ?? [];
          for (let i = args.length - 1; i >= 0; i--) {
            if (args[i]?.endsWith(".png")) {
              const dir = path.dirname(args[i]!);
              await mkdir(dir, { recursive: true });
              await writeFile(args[i]!, "");
              break;
            }
          }
          return makeResult(0, spec);
        }
        if (spec.command === "python3") {
          callCount++;
          if (callCount === 1) {
            return makeResult(0, spec, "PASS score=85 (brightness_drop=15.2, std=28.3, edge_ratio=0.0321)");
          }
          return makeResult(1, spec, "FAIL score=10 — no subtitle detected");
        }
        return makeResult(1, spec, "unknown command");
      },
    };

    const result = await verifyBurnedSubtitles("/tmp/fake-burned.mp4", "/tmp/fake-orig.mp4", srtPath, runner);
    expect(result.passed).toBe(false);
    expect(result.checks.filter((c) => !c.passed).length).toBeGreaterThanOrEqual(1);
  });

  it("returns passed=false for empty SRT", async () => {
    const srtPath = await seedSrt("");
    const runner: ProcessRunner = {
      run: async (spec: ProcessSpec) => {
        if (spec.command === "ffmpeg") {
          const args = spec.args ?? [];
          for (let i = args.length - 1; i >= 0; i--) {
            if (args[i]?.endsWith(".png")) {
              const dir = path.dirname(args[i]!);
              await mkdir(dir, { recursive: true });
              await writeFile(args[i]!, "");
              break;
            }
          }
          return makeResult(0, spec);
        }
        return makeResult(0, spec);
      },
    };
    const result = await verifyBurnedSubtitles("/tmp/fake.mp4", "/tmp/fake-orig.mp4", srtPath, runner);
    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(0);
  });

  it("verifies start, middle, and end positions", async () => {
    const srtPath = await seedSrt(`1
00:00:10,000 --> 00:00:20,000
Start subtitle

2
00:00:20,000 --> 00:00:30,000
Middle subtitle

3
00:00:30,000 --> 00:00:40,000
End subtitle
`);

    const checkTimestamps: number[] = [];
    const runner: ProcessRunner = {
      run: async (spec: ProcessSpec): Promise<ProcessResult> => {
        if (spec.command === "ffmpeg") {
          const args = spec.args ?? [];
          // -ss is now after -i (output seeking); capture the timestamp value
          const ssIdx = args.indexOf("-ss");
          if (ssIdx >= 0 && ssIdx + 1 < args.length) {
            const val = parseFloat(args[ssIdx + 1]!);
            if (!isNaN(val)) checkTimestamps.push(val);
          }
          // Create output frame file
          for (let i = args.length - 1; i >= 0; i--) {
            if (args[i]?.endsWith(".png")) {
              const dir = path.dirname(args[i]!);
              await mkdir(dir, { recursive: true });
              await writeFile(args[i]!, "");
              break;
            }
          }
          return makeResult(0, spec);
        }
        if (spec.command === "python3") {
          return makeResult(0, spec, "PASS score=85");
        }
        return makeResult(1, spec);
      },
    };

    await verifyBurnedSubtitles("/tmp/fake.mp4", "/tmp/fake-orig.mp4", srtPath, runner);

    // 3 checks × 2 extractions (burned + original) = 6 ffmpeg calls
    expect(checkTimestamps).toHaveLength(6);
    const uniqueTs = [...new Set(checkTimestamps)].sort((a, b) => a - b);
    expect(uniqueTs).toHaveLength(3);
    // Start: 10 + 0.1*(40-10) = 13, midpoint of cue 1 (10-20) = 15
    expect(uniqueTs[0]!).toBeGreaterThan(12);
    expect(uniqueTs[0]!).toBeLessThan(20);
    // Middle: 10 + 0.5*(40-10) = 25, midpoint of cue 2 (20-30) = 25
    expect(uniqueTs[1]!).toBeGreaterThan(22);
    expect(uniqueTs[1]!).toBeLessThan(30);
    // End: 10 + 0.85*(40-10) = 35.5, midpoint of cue 3 (30-40) = 35
    expect(uniqueTs[2]!).toBeGreaterThan(33);
    expect(uniqueTs[2]!).toBeLessThan(40);
  });
});

// ---------------------------------------------------------------------------
// burnSubtitles
// ---------------------------------------------------------------------------

describe("burnSubtitles", () => {
  it("calls python3 render-subtitles.py with srt path", async () => {
    const srtPath = await seedSrt(`1
00:00:01,000 --> 00:00:03,500
Hello world

2
00:00:04,000 --> 00:00:06,000
Second line
`);
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      run: async (spec: ProcessSpec) => {
        calls.push(spec);
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 100,
          command: spec.command,
          args: spec.args,
        };
      },
    };

    await expect(
      burnSubtitles({
        videoPath: "/v/full.mp4",
        srtPath,
        outputPath: "/v/full.zh-burned.mp4",
        runner,
      }),
    ).rejects.toThrow(); // manifest missing

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const py = calls.find(
      (c) => c.command === "python3" && c.args[0]?.includes("render-subtitles.py"),
    );
    expect(py).toBeDefined();
    expect(py!.args[1]).toBe(srtPath);
  });

  it("throws when SRT integrity check fails", async () => {
    const srtPath = await seedSrt(`1
00:00:05,000 --> 00:00:01,000
Negative duration

2
00:00:03,000 --> 00:00:07,000
Overlaps too
`);
    const runner: ProcessRunner = {
      run: async (_spec: ProcessSpec) => ({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 50,
        command: _spec.command,
        args: _spec.args,
      }),
    };

    await expect(
      burnSubtitles({
        videoPath: "/v/full.mp4",
        srtPath,
        outputPath: "/v/full.zh-burned.mp4",
        runner,
      }),
    ).rejects.toThrow(/SRT integrity check failed/);
  });

  it("throws when python rendering fails", async () => {
    const srtPath = await seedSrt(`1
00:00:01,000 --> 00:00:03,000
Test
`);
    const runner: ProcessRunner = {
      run: async (_spec: ProcessSpec) => ({
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "Some Python error",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 50,
        command: "python3",
        args: [],
      }),
    };

    await expect(
      burnSubtitles({
        videoPath: "/v/full.mp4",
        srtPath,
        outputPath: "/v/full.zh-burned.mp4",
        runner,
      }),
    ).rejects.toThrow(/subtitle PNG rendering failed/);
  });

  it("throws for SRT with no cues", async () => {
    const srtPath = await seedSrt("");
    const runner: ProcessRunner = {
      run: async (_spec: ProcessSpec) => ({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 50,
        command: _spec.command,
        args: _spec.args,
      }),
    };

    await expect(
      burnSubtitles({
        videoPath: "/v/full.mp4",
        srtPath,
        outputPath: "/v/full.zh-burned.mp4",
        runner,
      }),
    ).rejects.toThrow(/SRT integrity check failed/);
  });
});

// Helpers

const makeResult = (
  exitCode: number,
  spec: ProcessSpec,
  stdout = "",
  stderr = "",
): ProcessResult => ({
  exitCode,
  signal: null,
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 50,
  command: spec.command,
  args: spec.args ?? [],
});
