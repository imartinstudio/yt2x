import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NotesPromptInput, ScreenshotManifest, YouTubeMetadata } from "@yt2x/core";

/**
 * 旧 pipeline 约定的视频目录布局：
 *
 *   <outDir>/
 *     <videoId>/
 *       chunks.md
 *       timestamped-cues.md
 *       metadata.json
 *       screenshots/scene_manifest.json   (optional)
 *       structured-notes.md               (output)
 */

export const DEFAULT_OUT_DIR = "files/downloads";

export type VideoDirArtifacts = NotesPromptInput & {
  videoDir: string;
  videoId: string;
};

export type ReadArtifactsError = {
  videoDir: string;
  missing: string[];
};

/**
 * 读取一个视频目录的全部 notes 输入素材。
 *
 * 缺关键文件（chunks.md / cues / metadata）→ throw，附明确缺失列表。
 * 缺 screenshots 视为正常（很多视频会跳过截图阶段）。
 */
export const readVideoArtifacts = async (videoDir: string): Promise<VideoDirArtifacts> => {
  const chunksPath = path.join(videoDir, "chunks.md");
  const cuesPath = path.join(videoDir, "timestamped-cues.md");
  const metadataPath = path.join(videoDir, "metadata.json");
  const screenshotsPath = path.join(videoDir, "screenshots", "scene_manifest.json");

  const [chunks, cues, metadataRaw, screenshotsRaw] = await Promise.all([
    safeReadText(chunksPath),
    safeReadText(cuesPath),
    safeReadText(metadataPath),
    safeReadText(screenshotsPath),
  ]);

  const missing: string[] = [];
  if (chunks === null) missing.push("chunks.md");
  if (cues === null) missing.push("timestamped-cues.md");
  if (metadataRaw === null) missing.push("metadata.json");
  if (missing.length > 0) {
    const err: Error & ReadArtifactsError = Object.assign(
      new Error(
        `Video directory "${videoDir}" is missing required acquisition outputs: ${missing.join(", ")}. Run \`yt2x acquire\` first.`,
      ),
      { videoDir, missing },
    );
    throw err;
  }

  let metadata: YouTubeMetadata;
  try {
    metadata = JSON.parse(metadataRaw!) as YouTubeMetadata;
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e);
    throw new Error(`metadata.json in "${videoDir}" is not valid JSON: ${m}`);
  }

  let screenshots: ScreenshotManifest | null = null;
  if (screenshotsRaw !== null) {
    try {
      screenshots = JSON.parse(screenshotsRaw) as ScreenshotManifest;
    } catch {
      // 截图 manifest 损坏视为没截图，不阻断 notes
      screenshots = null;
    }
  }

  return {
    videoDir,
    videoId: path.basename(videoDir),
    chunksMd: chunks!,
    timestampedCuesMd: cues!,
    metadata,
    screenshots,
  };
};

/**
 * 原子写 `structured-notes.md`：tmp + rename。
 * 已存在且 !force → 返回 null 跳过；--force 时覆盖。
 */
export const writeStructuredNotes = async (
  videoDir: string,
  content: string,
  options: { force?: boolean } = {},
): Promise<string | null> => {
  const target = path.join(videoDir, "structured-notes.md");
  if (options.force !== true) {
    try {
      await stat(target);
      return null;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  await mkdir(videoDir, { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, target);
  return target;
};

/**
 * 扫描 outDir 下所有"已采集（有 chunks.md）但还没生成笔记（无 structured-notes.md）"的视频。
 *
 * 用于 `yt2x notes --all`：批量补齐。
 */
export const findPendingVideoDirs = async (outDir: string): Promise<string[]> => {
  let entries: Dirent[];
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const pending: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const videoDir = path.join(outDir, entry.name);
    const hasChunks = await fileExists(path.join(videoDir, "chunks.md"));
    if (!hasChunks) continue;
    const hasNotes = await fileExists(path.join(videoDir, "structured-notes.md"));
    if (hasNotes) continue;
    pending.push(videoDir);
  }
  return pending.sort();
};

const safeReadText = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
};
