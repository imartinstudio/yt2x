import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SectionCandidate } from "@yt2x/core";

const runMock = vi.fn();

vi.mock("../process/runner.js", () => ({
  defaultProcessRunner: {
    run: runMock,
  },
}));

const makeCandidate = (): SectionCandidate => ({
  id: "section-1",
  title: "X MCP 原生入口",
  summary: "",
  article_section: "",
  angle: "demo",
  risk: "low",
  timecodes: {
    start: "00:00:00,000",
    end: "00:02:01,000",
    startSec: 0,
    endSec: 121,
    durationSec: 121,
  },
  scores: {
    counter_intuitiveness: 1,
    shareability: 1,
    practical_value: 1,
    visual_appeal: 1,
    composite: 1,
  },
  key_quote: "",
  video_script: "",
});

describe("clipCandidates", () => {
  beforeEach(() => {
    runMock.mockReset();
    runMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      command: "ffmpeg",
      args: [],
    });
  });

  it("re-encodes clips so video starts from a decodable frame at zero", async () => {
    const { clipCandidates } = await import("./clipper.js");
    const outputDir = await mkdtemp(path.join(tmpdir(), "yt2x-clipper-"));

    await clipCandidates("/tmp/source.mp4", [makeCandidate()], outputDir);

    expect(runMock).toHaveBeenCalledTimes(1);
    const spec = runMock.mock.calls[0]![0];
    expect(spec.command).toBe("ffmpeg");
    expect(spec.args).toEqual([
      "-y",
      "-ss", "00:00:00",
      "-i", "/tmp/source.mp4",
      "-t", "121",
      "-map", "0:v:0",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-c:a", "aac",
      "-b:a", "160k",
      "-movflags", "+faststart",
      path.join(outputDir, "candidate-1-x-mcp-原生入口.mp4"),
    ]);
    expect(spec.args).not.toContain("copy");
  });
});
