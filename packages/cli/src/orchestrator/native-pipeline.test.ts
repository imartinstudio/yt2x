import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineArgsSchema } from "../args/pipeline.js";

const executeNativeNotesMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("./native-notes.js", () => ({
  executeNativeNotes: executeNativeNotesMock,
}));

const executeNativeArticleMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("./native-article.js", () => ({
  executeNativeArticle: executeNativeArticleMock,
}));

const executeNativePublishMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("./native-publish.js", () => ({
  executeNativePublish: executeNativePublishMock,
}));

import { mergePipelineExitCode, runNativePipeline } from "./native-pipeline.js";

const buildArgs = (overrides: Record<string, unknown>) =>
  PipelineArgsSchema.parse({
    sources: { urls: ["https://youtu.be/abc123def45"] },
    stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    acquire: {},
    article: {},
    publish: {},
    control: {},
    llm: { provider: "openai" },
    flags: {},
    ...overrides,
  });

beforeEach(() => {
  executeNativeNotesMock.mockClear();
  executeNativeArticleMock.mockClear();
  executeNativePublishMock.mockClear();
});

describe("mergePipelineExitCode", () => {
  it("keeps the highest non-zero exit code", () => {
    expect(mergePipelineExitCode(0, 4)).toBe(4);
    expect(mergePipelineExitCode(1, 4)).toBe(4);
    expect(mergePipelineExitCode(4, 0)).toBe(4);
  });
});

describe("runNativePipeline", () => {
  it("with --acquire skip calls executeNativeNotes per video when pipeline-state manifest exists as dirs", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-"));
    for (const id of ["aaa", "bbb"]) {
      await mkdir(path.join(outRoot, id), { recursive: true });
      await writeFile(path.join(outRoot, id, "metadata.json"), JSON.stringify({ id, title: id }));
    }

    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    });

    const code = await runNativePipeline({
      args,
      monorepoRoot: "/tmp/yt2x-monorepo",
    });

    expect(code).toBe(0);
    expect(executeNativeNotesMock).toHaveBeenCalledTimes(2);
    expect(executeNativeArticleMock).not.toHaveBeenCalled();
    expect(executeNativePublishMock).not.toHaveBeenCalled();
  });

  it("returns 1 when acquire skip and no video dirs", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-empty-"));
    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    });
    const code = await runNativePipeline({ args, monorepoRoot: "/tmp" });
    expect(code).toBe(1);
    expect(executeNativeNotesMock).not.toHaveBeenCalled();
  });

  it("with --acquire skip discovers videos via metadata.json when no root state file", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-meta-"));
    const vid = "metaVid1";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "t" }));

    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(executeNativeNotesMock).toHaveBeenCalledTimes(1);
  });

  it("returns partial exit code when error-strategy is skip and notes fail", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-skip-"));
    const vid = "aaa";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));

    executeNativeNotesMock.mockResolvedValueOnce(4);

    const args = buildArgs({
      control: { outDir: outRoot, errorStrategy: "skip" },
      stages: { acquire: "skip", notes: "auto", article: "skip", publish: "skip" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(4);
  });

  it("treats publish review as dry-run preview instead of real posting", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-pub-review-"));
    const vid = "pubReview1";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));

    const args = buildArgs({
      control: { outDir: outRoot },
      stages: { acquire: "skip", notes: "skip", article: "skip", publish: "review" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(executeNativePublishMock).toHaveBeenCalledOnce();
    expect(executeNativePublishMock.mock.calls[0]![0]).toMatchObject({
      videoId: vid,
      dryRun: true,
      publishDryRun: true,
    });
  });
});
