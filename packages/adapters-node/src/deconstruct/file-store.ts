import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DeconstructManifest,
  SectionCandidate,
  ClipEntry,
} from "@yt2x/core";
import { candidateVideoFilename, toSlug } from "./generator.js";

/**
 * 将 LLM 拆解结果 + 裁剪结果写入 clips/ 目录。
 */
export type WriteDeconstructOutput = {
  /** clips 输出目录 */
  clipsDir: string;
  /** manifest 文件路径 */
  manifestPath: string;
  /** 裁剪成功的条目数 */
  clippedCount: number;
};

export const writeDeconstructOutput = async (
  articleDir: string,
  candidates: SectionCandidate[],
  videoId: string,
  videoPath: string,
  durationSec: number,
  articleMd = "",
): Promise<WriteDeconstructOutput> => {
  const clipsDir = path.join(articleDir, "x-format", "clips");
  await mkdir(clipsDir, { recursive: true });

  // Build manifest entries
  const clips: ClipEntry[] = candidates.map((c, i) => ({
    id: `clip-${i + 1}`,
    slug: toSlug(c.title),
    title: c.title,
    type: c.angle === "contrarian" || c.angle === "discussion"
      ? "hot-take"
      : c.angle === "warning"
        ? "warning"
        : "insight",
    angle: c.angle,
    risk: c.risk,
    timecodes: c.timecodes,
    video: candidateVideoFilename(c),
    scores: c.scores,
    articleSection: c.article_section,
    sourceContext: {
      title: c.title,
      summary: c.summary,
      keyQuote: c.key_quote,
      videoScript: c.video_script,
      articleSection: c.article_section,
      articleBody: extractArticleSection(articleMd, c.article_section),
    },
  }));

  const manifest: DeconstructManifest = {
    v: 1,
    source: {
      videoId,
      articlePath: path.relative(clipsDir, path.join(articleDir, "article.md")),
      durationSec,
    },
    generatedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    clips,
  };

  const manifestPath = path.join(clipsDir, "clips-manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  return {
    clipsDir,
    manifestPath,
    clippedCount: clips.length,
  };
};

const extractArticleSection = (articleMd: string, sectionTitle: string): string => {
  const target = sectionTitle.trim();
  if (!target) return "";
  const lines = articleMd.split("\n");
  const headingIndex = lines.findIndex((line) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/u);
    return match !== null && match[2]!.replaceAll("**", "").trim() === target;
  });
  if (headingIndex < 0) return "";
  const level = lines[headingIndex]!.match(/^#+/u)![0].length;
  const nextHeadingOffset = lines.slice(headingIndex + 1).findIndex((line) => {
    const match = line.match(/^(#{1,6})\s+/u);
    return match !== null && match[1]!.length <= level;
  });
  const end = nextHeadingOffset < 0 ? lines.length : headingIndex + 1 + nextHeadingOffset;
  return lines.slice(headingIndex, end).join("\n");
};
