import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decorateNativeArticleMarkdown,
  findPendingNativeArticleDirs,
  readStructuredNotesArtifacts,
  writeNativeArticleBundle,
  writeVisualSuggestions,
} from "./file-store.js";
import type { VisualSuggestion } from "@yt2x/core";

let notesRoot: string;
let articleRoot: string;

beforeEach(async () => {
  notesRoot = await mkdtemp(path.join(tmpdir(), "yt2x-notes-src-"));
  articleRoot = await mkdtemp(path.join(tmpdir(), "yt2x-art-out-"));
});

afterEach(async () => {
  await rm(notesRoot, { recursive: true, force: true });
  await rm(articleRoot, { recursive: true, force: true });
});

const seedNotesVideo = async (
  videoId: string,
  opts: { notes?: string; meta?: string; shot?: Buffer; clip?: Buffer } = {},
): Promise<string> => {
  const dir = path.join(notesRoot, videoId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "structured-notes.md"),
    opts.notes ?? "# Title\n\nbody",
  );
  await writeFile(path.join(dir, "metadata.json"), opts.meta ?? JSON.stringify({ id: videoId, title: "T" }));
  if (opts.shot !== undefined) {
    await mkdir(path.join(dir, "screenshots"), { recursive: true });
    await writeFile(path.join(dir, "screenshots", "a.webp"), opts.shot);
  }
  if (opts.clip !== undefined) {
    await mkdir(path.join(dir, "video"), { recursive: true });
    await writeFile(path.join(dir, "video", "clip.mp4"), opts.clip);
  }
  return dir;
};

describe("readStructuredNotesArtifacts", () => {
  it("reads structured notes + metadata", async () => {
    const dir = await seedNotesVideo("v1", { notes: "N", meta: JSON.stringify({ id: "v1" }) });
    const a = await readStructuredNotesArtifacts(dir);
    expect(a.structuredNotesMd).toBe("N");
    expect(a.metadata.id).toBe("v1");
  });

  it("throws with missing list", async () => {
    const dir = path.join(notesRoot, "bad");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "structured-notes.md"), "x");
    await expect(readStructuredNotesArtifacts(dir)).rejects.toMatchObject({
      missing: ["metadata.json"],
    });
  });

  it("reports missing structured notes clearly", async () => {
    const dir = path.join(notesRoot, "missing-notes");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "metadata.json"), JSON.stringify({ id: "missing-notes" }));
    await expect(readStructuredNotesArtifacts(dir)).rejects.toMatchObject({
      missing: ["structured-notes.md"],
    });
  });
});

describe("writeNativeArticleBundle", () => {
  it("writes article.md and run.json atomically", async () => {
    await seedNotesVideo("v1");
    const run = {
      v: 1 as const,
      platform: "x" as const,
      videoId: "v1",
      model: "m",
      finishReason: "stop",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
    };
    const w = await writeNativeArticleBundle(articleRoot, "v1", "# A\n\nok", run);
    expect(await readFile(w.articlePath, "utf8")).toBe("# A\n\nok");
    const parsed = JSON.parse(await readFile(w.runPath, "utf8")) as { model: string };
    expect(parsed.model).toBe("m");
  });

  it("refuses overwrite without --force", async () => {
    await seedNotesVideo("v1");
    const run = {
      v: 1 as const,
      platform: "x" as const,
      videoId: "v1",
      model: "m",
      finishReason: "stop",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
    };
    await writeNativeArticleBundle(articleRoot, "v1", "one", run);
    await expect(writeNativeArticleBundle(articleRoot, "v1", "two", run)).rejects.toThrow(/already exists/);
  });

  it("copies cover from screenshots when notesVideoDir passed", async () => {
    await seedNotesVideo("v1", { shot: Buffer.from([0x52, 0x49, 0x46, 0x46]) });
    const run = {
      v: 1 as const,
      platform: "x" as const,
      videoId: "v1",
      model: "m",
      finishReason: "stop",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
    };
    const w = await writeNativeArticleBundle(articleRoot, "v1", "x", run, {
      notesVideoDir: path.join(notesRoot, "v1"),
    });
    expect(w.coverPath).toBe(path.join(w.articleDir, "images", "cover.webp"));
  });

  it("prefers official YouTube cover over contact sheet", async () => {
    const dir = await seedNotesVideo("v1");
    const screenshotsDir = path.join(dir, "screenshots");
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(path.join(screenshotsDir, "contact_sheet.jpg"), Buffer.from([0xff, 0xd8]));
    await writeFile(path.join(screenshotsDir, "youtube_cover.jpg"), Buffer.from([0xff, 0xd8, 0xff]));

    const run = {
      v: 1 as const,
      platform: "x" as const,
      videoId: "v1",
      model: "m",
      finishReason: "stop",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
    };
    const w = await writeNativeArticleBundle(articleRoot, "v1", "x", run, {
      notesVideoDir: dir,
    });

    expect(w.coverPath).toBe(path.join(w.articleDir, "images", "cover.jpg"));
    expect(await readFile(w.coverPath!, "hex")).toBe("ffd8ff");
  });

  it("writes cover and hashtags body into article layout", async () => {
    const dir = await seedNotesVideo("v1", {
      shot: Buffer.from([0x52, 0x49, 0x46, 0x46]),
      clip: Buffer.from("fake mp4"),
    });
    const run = {
      v: 1 as const,
      platform: "x" as const,
      videoId: "v1",
      model: "m",
      finishReason: "stop",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
    };
    const body = "# **标题**\n\n导语。\n\n## **第一节**\n\n正文。\n\n#话题一 #话题二 #TopicThree";
    const w = await writeNativeArticleBundle(articleRoot, "v1", body, run, {
      notesVideoDir: dir,
      sourceVideoUrl: "<YOUTUBE_URL>",
    });

    expect(w.videoPath).toBe(path.join(w.articleDir, "video", "clip.mp4"));
    expect(await readFile(w.videoPath!, "utf8")).toBe("fake mp4");
    expect(await readFile(w.articlePath, "utf8")).toBe(
      "# **标题**\n\n![封面](images/cover.webp)\n\n导语。\n\n## **第一节**\n\n正文。\n\n#话题一 #话题二 #TopicThree",
    );
  });
});

describe("decorateNativeArticleMarkdown", () => {
  it("keeps H1 first and inserts cover after it", () => {
    expect(
      decorateNativeArticleMarkdown("# **标题**\n\n导语。\n\n## **正文**\n\n内容。", {
        coverPath: "images/cover.jpg",
        videoPath: "video/clip.mp4",
        sourceVideoUrl: "<YOUTUBE_URL>",
      }),
    ).toMatch(/^# \*\*标题\*\*\n\n!\[封面\]\(images\/cover.jpg\)[\s\S]*## \*\*正文\*\*[\s\S]*内容。$/);
  });
});

describe("writeNativeArticleBundle cover fallback", () => {
  it("falls back to contact_sheet only when no other screenshots exist", async () => {
    const dir = await seedNotesVideo("v1");
    const screenshotsDir = path.join(dir, "screenshots");
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(path.join(screenshotsDir, "contact_sheet.jpg"), Buffer.from([0xff, 0xd8]));

    const run = {
      v: 1 as const,
      platform: "x" as const,
      videoId: "v1",
      model: "m",
      finishReason: "stop",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
    };
    const w = await writeNativeArticleBundle(articleRoot, "v1", "x", run, {
      notesVideoDir: dir,
    });
    expect(w.coverPath).toBe(path.join(w.articleDir, "images", "cover.jpg"));
  });

  it("prefers any keyframe screenshot over contact_sheet when no youtube cover", async () => {
    const dir = await seedNotesVideo("v1");
    const screenshotsDir = path.join(dir, "screenshots");
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(path.join(screenshotsDir, "contact_sheet.jpg"), Buffer.from([0xff, 0xd8]));
    await writeFile(path.join(screenshotsDir, "scene_03.webp"), Buffer.from([0x52, 0x49]));

    const run = {
      v: 1 as const,
      platform: "x" as const,
      videoId: "v1",
      model: "m",
      finishReason: "stop",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
    };
    const w = await writeNativeArticleBundle(articleRoot, "v1", "x", run, {
      notesVideoDir: dir,
    });
    expect(w.coverPath).toBe(path.join(w.articleDir, "images", "cover.webp"));
  });
});

describe("writeVisualSuggestions", () => {
  it("writes the suggestions JSON and returns its path", async () => {
    const articleDir = path.join(articleRoot, "v1");
    await mkdir(articleDir, { recursive: true });
    const suggestions: VisualSuggestion[] = [
      {
        kind: "diagram",
        target_section: "完整流程",
        description: "示例说明",
        priority: "high",
        trigger: "流程",
      },
    ];
    const written = await writeVisualSuggestions(articleDir, suggestions);
    expect(written).toBe(path.join(articleDir, "visual-suggestions.json"));
    const parsed = JSON.parse(await readFile(written!, "utf8")) as {
      v: number;
      suggestions: VisualSuggestion[];
    };
    expect(parsed.v).toBe(1);
    expect(parsed.suggestions.length).toBe(1);
    expect(parsed.suggestions[0]!.kind).toBe("diagram");
  });

  it("skips writing when suggestions array is empty", async () => {
    const articleDir = path.join(articleRoot, "v2");
    await mkdir(articleDir, { recursive: true });
    const written = await writeVisualSuggestions(articleDir, []);
    expect(written).toBeNull();
  });
});

describe("findPendingNativeArticleDirs", () => {
  it("lists dirs with notes but no destination article.md", async () => {
    await seedNotesVideo("a");
    await seedNotesVideo("b");
    await mkdir(path.join(articleRoot, "b"), { recursive: true });
    await writeFile(path.join(articleRoot, "b", "article.md"), "done");
    const pending = await findPendingNativeArticleDirs(notesRoot, articleRoot);
    expect(pending).toEqual([path.join(notesRoot, "a")]);
  });
});
