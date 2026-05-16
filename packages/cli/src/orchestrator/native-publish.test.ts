import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProcessStatusMerged } from "@yt2x/adapters-node";
import { executeNativePublish } from "./native-publish.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-publish-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("executeNativePublish", () => {
  it("rejects path-like video ids", async () => {
    const code = await executeNativePublish({
      videoId: "../outside",
      outDir: path.join(root, "downloads"),
      articleOutDir: path.join(root, "articles"),
      dryRun: true,
    });

    expect(code).toBe(2);
  });

  it("writes preview artifact and publish status on dry-run", async () => {
    const videoId = "dryRunVid1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://youtu.be/dryRunVid1" }),
    );
    await writeFile(path.join(articleDir, "article.md"), "Preview body");

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        dryRun: true,
      });

      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as { format: string; source: string; parts: unknown[] };
    expect(preview.format).toBe("long");
    expect(preview.source).toBe("article.md");
    expect(preview.parts).toHaveLength(1);

    const status = await readProcessStatusMerged(videoDir, {
      videoId,
      url: "https://youtu.be/dryRunVid1",
    });
    expect(status?.steps.publish.status).toBe("done");
    expect(status?.steps.publish.resultFile).toBe("publish-preview.json");
    expect(status?.articleOutDir).toBe(articleDir);
  });

  it("previews generated thread source on dry-run", async () => {
    const videoId = "threadPreview1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/thread-preview" }),
    );
    await writeFile(path.join(articleDir, "x-thread.md"), "# T\n\n1/ first\n\n2/ second\n");

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        target: "x-thread",
        threadSource: "generated",
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as { mode: string; source: string; tweets: string[] };
    expect(preview.mode).toBe("thread");
    expect(preview.source).toBe("x-thread.md");
    expect(preview.tweets).toEqual(["first", "second"]);
  });

  it("previews short target on dry-run", async () => {
    const videoId = "shortPreview1";
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const videoDir = path.join(outDir, videoId);
    const articleDir = path.join(articleOutDir, videoId);
    await mkdir(videoDir, { recursive: true });
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(videoDir, "metadata.json"),
      JSON.stringify({ id: videoId, webpage_url: "https://example.com/short-preview" }),
    );
    await writeFile(path.join(articleDir, "x-short.md"), "short post body\n");

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await executeNativePublish({
        videoId,
        outDir,
        articleOutDir,
        target: "x-short",
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const previewRaw = await readFile(path.join(articleDir, "publish-preview.json"), "utf8");
    const preview = JSON.parse(previewRaw) as { mode: string; source: string; text: string };
    expect(preview.mode).toBe("short");
    expect(preview.source).toBe("x-short.md");
    expect(preview.text).toBe("short post body");
  });
});
