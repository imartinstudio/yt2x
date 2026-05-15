import { describe, expect, it, vi } from "vitest";
import { runPipelineCommand } from "./pipeline-run.js";

const baseFlags = {
  urls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  acquire: "skip",
  notes: "skip",
  article: "skip",
  publish: "skip",
} as const;

describe("runPipelineCommand", () => {
  it("delegates to runNativePipeline", async () => {
    const runNativePipeline = vi.fn(async () => 0);

    const code = await runPipelineCommand(
      { ...baseFlags, notes: "auto" },
      {
        runNativePipeline,
        defaultMonorepoRoot: () => "/tmp/yt2x-monorepo",
      },
    );

    expect(code).toBe(0);
    expect(runNativePipeline).toHaveBeenCalledOnce();
    expect(runNativePipeline.mock.calls[0]![0].monorepoRoot).toBe("/tmp/yt2x-monorepo");
  });
});
