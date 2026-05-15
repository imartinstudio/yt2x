import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findArticleArtifacts } from "./find-article-dir.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "yt2x-pub-art-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const seedFlatArticle = async (
  videoId: string,
  files: {
    articleContent?: string | null;
    coverIn?: "images" | "root" | null;
  } = {},
): Promise<string> => {
  const dir = path.join(root, videoId);
  await mkdir(dir, { recursive: true });
  if (files.articleContent !== null && files.articleContent !== undefined) {
    await writeFile(path.join(dir, "article.md"), files.articleContent);
  }
  if (files.coverIn === "images") {
    await mkdir(path.join(dir, "images"), { recursive: true });
    await writeFile(path.join(dir, "images", "cover.webp"), Buffer.from([0x52, 0x49, 0x46, 0x46]));
  } else if (files.coverIn === "root") {
    await writeFile(path.join(dir, "cover.png"), Buffer.from([0x89, 0x50]));
  }
  return dir;
};

describe("findArticleArtifacts", () => {
  it("reads article.md from the explicit articleDir", async () => {
    const dir = await seedFlatArticle("vid1", {
      articleContent: "# Hello\n\nbody",
    });
    const arts = await findArticleArtifacts({
      videoId: "vid1",
      articleRootDir: root,
      articleDir: dir,
    });
    expect(arts.articleContent).toBe("# Hello\n\nbody");
    expect(arts.articleDir).toBe(dir);
    expect(arts.coverPath).toBeNull();
  });

  it("auto-discovers flat <articleRootDir>/<videoId>/article.md", async () => {
    await seedFlatArticle("vid1", { articleContent: "native-flat" });
    const arts = await findArticleArtifacts({ videoId: "vid1", articleRootDir: root });
    expect(arts.articleDir).toBe(path.join(root, "vid1"));
    expect(arts.articleContent).toBe("native-flat");
  });

  it("detects cover.webp inside images/", async () => {
    const dir = await seedFlatArticle("vid1", {
      articleContent: "body",
      coverIn: "images",
    });
    const arts = await findArticleArtifacts({
      videoId: "vid1",
      articleRootDir: root,
      articleDir: dir,
    });
    expect(arts.coverPath).toBe(path.join(dir, "images", "cover.webp"));
  });

  it("detects cover.png in articleDir root as fallback", async () => {
    const dir = await seedFlatArticle("vid1", {
      articleContent: "body",
      coverIn: "root",
    });
    const arts = await findArticleArtifacts({
      videoId: "vid1",
      articleRootDir: root,
      articleDir: dir,
    });
    expect(arts.coverPath).toBe(path.join(dir, "cover.png"));
  });

  it("throws when no article layout exists", async () => {
    await mkdir(path.join(root, "vid1"), { recursive: true });
    await expect(findArticleArtifacts({ videoId: "vid1", articleRootDir: root })).rejects.toThrow(/No article for/);
  });

  it("throws when the video root doesn't exist", async () => {
    await expect(findArticleArtifacts({ videoId: "missing", articleRootDir: root })).rejects.toThrow(/No article for/);
  });

  it("throws when article.md missing (auto-discover flat layout)", async () => {
    await seedFlatArticle("vid1", { articleContent: null });
    await expect(findArticleArtifacts({ videoId: "vid1", articleRootDir: root })).rejects.toThrow(/No article for/);
  });

  it("throws when article.md missing under explicit articleDir", async () => {
    const emptyDir = path.join(root, "empty-article");
    await mkdir(emptyDir, { recursive: true });
    await expect(
      findArticleArtifacts({ videoId: "vid1", articleRootDir: root, articleDir: emptyDir }),
    ).rejects.toThrow(/article\.md not found/);
  });

  it("throws when article.md is empty", async () => {
    const dir = await seedFlatArticle("vid1", {
      articleContent: "   \n  ",
    });
    await expect(
      findArticleArtifacts({ videoId: "vid1", articleRootDir: root, articleDir: dir }),
    ).rejects.toThrow(/is empty/);
  });

  it("rejects path-like video ids before resolving under articleRootDir", async () => {
    await expect(findArticleArtifacts({ videoId: "../outside", articleRootDir: root })).rejects.toThrow(
      /Invalid videoId/,
    );
  });
});
