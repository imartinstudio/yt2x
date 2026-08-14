import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeconstructManifest, SectionCandidate } from "@yt2x/core";
import { selectClips, selectTopUniqueArticleSections } from "./selector.js";
import { replaceDirectoryAtomically, withContentTargetLock } from "../content-transaction.js";

const makeCandidate = (
  id: string,
  articleSection: string,
  composite: number,
): SectionCandidate => ({
  id,
  title: id,
  summary: "",
  article_section: articleSection,
  angle: "tutorial",
  risk: "low",
  timecodes: {
    start: "00:00:00,000",
    end: "00:01:00,000",
    startSec: 0,
    endSec: 60,
    durationSec: 60,
  },
  scores: {
    counter_intuitiveness: 1,
    shareability: 1,
    practical_value: 1,
    visual_appeal: 1,
    composite,
  },
  key_quote: "",
  video_script: "",
});

describe("selectTopUniqueArticleSections", () => {
  it("keeps only the highest-scored clip per article section", () => {
    const sections = [
      makeCandidate("section-1-part1", "OAuth 授权故障排除", 4.1),
      makeCandidate("section-1-part2", "OAuth 授权故障排除", 4.8),
      makeCandidate("section-2", "X MCP 原生入口", 3.9),
    ];

    const selected = selectTopUniqueArticleSections(sections, 10);

    expect(selected.map((s) => s.section.id)).toEqual([
      "section-1-part2",
      "section-2",
    ]);
    expect(selected.map((s) => s.originalIndex)).toEqual([1, 2]);
  });

  it("applies the requested limit after article-section dedupe", () => {
    const sections = [
      makeCandidate("section-1-part1", "重复主题", 4.2),
      makeCandidate("section-1-part2", "重复主题", 4.9),
      makeCandidate("section-2", "独立主题", 4.5),
    ];

    const selected = selectTopUniqueArticleSections(sections, 1);

    expect(selected.map((s) => s.section.id)).toEqual(["section-1-part2"]);
  });
});

const selectorRoots: string[] = [];

afterEach(async () => {
  await Promise.all(selectorRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const manifestFixture = (): DeconstructManifest => ({
  version: 1,
  generatedAt: new Date().toISOString(),
  source: {
    videoId: "video-placeholder",
    title: "Placeholder title",
    durationSec: 600,
  },
  candidateCount: 2,
  total: 0,
  clips: [
    { id: "clip-1", slug: "first", title: "First", selected: false },
    { id: "clip-2", slug: "second", title: "Second", selected: false },
  ],
} as unknown as DeconstructManifest);

describe("selectClips", () => {
  it("commits selection through the shared deconstruct lock without losing a concurrent bundle commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yt2x-selector-tx-"));
    selectorRoots.push(root);
    const articleDir = path.join(root, "article");
    const clipsRoot = path.join(articleDir, "x-format", "clips");
    await mkdir(clipsRoot, { recursive: true });
    await writeFile(
      path.join(clipsRoot, "clips-manifest.json"),
      JSON.stringify(manifestFixture(), null, 2) + "\n",
      "utf8",
    );

    const writer = withContentTargetLock(articleDir, "deconstruct", async () => {
      const stage = path.join(articleDir, "x-format", ".clips-stage");
      await cp(clipsRoot, stage, { recursive: true, dereference: true });
      await writeFile(path.join(stage, "post-1-first.md"), "post body\n", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await replaceDirectoryAtomically(stage, clipsRoot);
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = await selectClips({ articleDir, keep: ["1"] });
    await writer;

    const finalManifest = JSON.parse(
      await readFile(path.join(clipsRoot, "clips-manifest.json"), "utf8"),
    ) as DeconstructManifest;
    expect(finalManifest.clips.find((clip) => clip.id === "clip-1")?.selected).toBe(true);
    expect(finalManifest.clips.find((clip) => clip.id === "clip-2")?.selected).toBe(false);
    await expect(readFile(path.join(clipsRoot, "post-1-first.md"), "utf8")).resolves.toBe("post body\n");
    expect(result.kept).toBe(1);
    expect(result.removed).toBe(1);
  });

});
