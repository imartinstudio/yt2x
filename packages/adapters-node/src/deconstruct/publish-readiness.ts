import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { DeconstructManifest } from "@yt2x/core";

export type ClipPublishOrderItem = {
  file: string;
  clipId: string;
  series: string;
  video: string;
};

export type ClipPublishReadiness = {
  clipsDir: string;
  ready: boolean;
  errors: string[];
  warnings: string[];
  publishOrder: ClipPublishOrderItem[];
  ignoredDrafts: string[];
};

type Frontmatter = Record<string, string>;

export const validateClipPublishReadiness = async (articleDirOrClipsDir: string): Promise<ClipPublishReadiness> => {
  const clipsDir = await resolveClipsDir(articleDirOrClipsDir);
  const result: ClipPublishReadiness = {
    clipsDir,
    ready: false,
    errors: [],
    warnings: [],
    publishOrder: [],
    ignoredDrafts: [],
  };

  const manifestPath = path.join(clipsDir, "clips-manifest.json");
  let manifest: DeconstructManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DeconstructManifest;
  } catch (err: unknown) {
    result.errors.push(`Missing or invalid clips-manifest.json: ${err instanceof Error ? err.message : String(err)}`);
    return finish(result);
  }

  const entries = await readdir(clipsDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const postFiles = files.filter((name) => /^post-\d+-.+\.md$/.test(name));
  result.ignoredDrafts = files.filter((name) => /^draft-.+\.md$/.test(name));

  const selected = manifest.clips.filter((clip) => clip.selected === true && typeof clip.text === "string" && clip.text.trim() !== "");
  const selectedById = new Map(selected.map((clip) => [clip.id, clip]));
  const postsByClipId = new Map<string, string[]>();

  if (selected.length === 0) {
    result.errors.push("No selected clips with generated text found. Run `yt2x clips generate` first.");
  }

  for (const file of postFiles) {
    const raw = await readFile(path.join(clipsDir, file), "utf8");
    const frontmatter = parseFrontmatter(raw);
    const clipId = frontmatter.clipId;

    if (!clipId) {
      result.errors.push(`${file}: missing clipId frontmatter`);
      continue;
    }

    const filesForClip = postsByClipId.get(clipId) ?? [];
    filesForClip.push(file);
    postsByClipId.set(clipId, filesForClip);

    for (const [key, expected] of Object.entries({ ref: "clips-manifest.json", type: "clip-post", platform: "x" })) {
      if (frontmatter[key] !== expected) {
        result.errors.push(`${file}: expected ${key}: ${expected}`);
      }
    }

    const clip = selectedById.get(clipId);
    if (clip === undefined) {
      result.warnings.push(`${file}: clipId ${clipId} is not selected in clips-manifest.json`);
    }

    const mentionedVideos = Array.from(raw.matchAll(/candidate-[^\s`"'()（）]+\.mp4/g)).map((match) => match[0]);
    if (mentionedVideos.length === 0) {
      result.errors.push(`${file}: no candidate video filename mentioned`);
    }
    for (const video of mentionedVideos) {
      if (!(await exists(path.join(clipsDir, video)))) {
        result.errors.push(`${file}: mentioned video does not exist: ${video}`);
      }
      if (clip?.video !== undefined && video !== clip.video) {
        result.errors.push(`${file}: mentioned video ${video} does not match manifest video ${clip.video}`);
      }
    }

    result.publishOrder.push({
      file,
      clipId,
      series: frontmatter.series ?? "",
      video: clip?.video ?? "",
    });
  }

  for (const clip of selected) {
    const filesForClip = postsByClipId.get(clip.id) ?? [];
    if (filesForClip.length === 0) {
      result.errors.push(`Selected clip ${clip.id} has no final post-*.md`);
    }
    if (filesForClip.length > 1) {
      result.errors.push(`Selected clip ${clip.id} has duplicate final posts: ${filesForClip.join(", ")}`);
    }
  }

  validateSeries(result, selected.length);
  result.publishOrder.sort((a, b) => seriesIndex(a.series) - seriesIndex(b.series));
  return finish(result);
};

export const assertClipPublishReadiness = async (articleDirOrClipsDir: string): Promise<ClipPublishReadiness> => {
  const result = await validateClipPublishReadiness(articleDirOrClipsDir);
  if (!result.ready) {
    throw new Error(`Clip publish readiness failed:\n${result.errors.map((error) => `- ${error}`).join("\n")}`);
  }
  return result;
};

const resolveClipsDir = async (articleDirOrClipsDir: string): Promise<string> => {
  const direct = path.resolve(articleDirOrClipsDir);
  if (await exists(path.join(direct, "clips-manifest.json"))) return direct;
  return path.join(direct, "x-format", "clips");
};

const validateSeries = (result: ClipPublishReadiness, selectedCount: number): void => {
  const seen = new Set<number>();
  for (const item of result.publishOrder) {
    const match = /^(\d+)\/(\d+)$/.exec(item.series);
    if (match === null) {
      result.errors.push(`${item.file}: invalid series value ${item.series || "(missing)"}`);
      continue;
    }
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (total !== selectedCount) {
      result.errors.push(`${item.file}: series total ${total} does not match selected count ${selectedCount}`);
    }
    if (index < 1 || index > selectedCount) {
      result.errors.push(`${item.file}: series index ${index} out of range`);
    }
    if (seen.has(index)) {
      result.errors.push(`${item.file}: duplicate series index ${index}`);
    }
    seen.add(index);
  }
  for (let i = 1; i <= selectedCount; i++) {
    if (!seen.has(i)) result.errors.push(`Missing series index ${i}/${selectedCount}`);
  }
};

const parseFrontmatter = (raw: string): Frontmatter => {
  if (!raw.startsWith("---\n")) return {};
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return {};

  const frontmatter: Frontmatter = {};
  for (const line of raw.slice(4, end).split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    frontmatter[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^"|"$/g, "");
  }
  return frontmatter;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const seriesIndex = (series: string): number => {
  const value = Number(series.split("/")[0]);
  return Number.isFinite(value) ? value : 0;
};

const finish = (result: ClipPublishReadiness): ClipPublishReadiness => ({
  ...result,
  ready: result.errors.length === 0,
});
