/**
 * 批次视频队列（扫描 `--out-dir` 子目录）与阶段产物校验。
 * 步骤状态仅写各视频目录下的 `process-status.json`（见 `fs/process-status-store.ts`）。
 */

import { access, readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { PipelineStep } from "@yt2x/core";
import { PROCESS_STATUS_FILE, readYoutubePageUrl } from "../fs/process-status-store.js";
import { resolveVideoSources, type ResolveSourcesInput, type VideoSourceRow } from "./resolve-sources.js";

export type ResolveAcquireQueueInput = {
  outDir: string;
  continueFlag: boolean;
  sources: ResolveSourcesInput;
};

/**
 * 解析 native acquire 要处理的视频列表。
 * `--continue` 时优先扫描已有子目录；否则（或扫描为空）再解析 URL / 搜索。
 * 解析失败返回 `null`；成功但无视频返回 `[]`。
 */
export const resolveAcquireVideoQueue = async (
  input: ResolveAcquireQueueInput,
): Promise<VideoSourceRow[] | null> => {
  const { outDir, continueFlag, sources } = input;

  if (continueFlag) {
    let rows = await listBatchVideosFromOutRoot(outDir);
    if (rows.length === 0) {
      try {
        rows = await resolveVideoSources(sources);
      } catch {
        return null;
      }
    }
    return rows;
  }

  try {
    return await resolveVideoSources(sources);
  } catch {
    return null;
  }
};

/**
 * 扫描输出根下「已出现产物或状态」的视频子目录。
 * `video_id` = 目录名，字典序。
 */
export const listBatchVideosFromOutRoot = async (outRoot: string): Promise<VideoSourceRow[]> => {
  let dirents: Dirent[];
  try {
    dirents = await readdir(outRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const rows: VideoSourceRow[] = [];
  for (const ent of dirents) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    if (name.startsWith(".")) continue;
    const videoDir = path.join(outRoot, name);
    const hasMeta = await access(path.join(videoDir, "metadata.json"))
      .then(() => true)
      .catch(() => false);
    const hasStatus = await access(path.join(videoDir, PROCESS_STATUS_FILE))
      .then(() => true)
      .catch(() => false);
    if (!hasMeta && !hasStatus) continue;

    const video_id = name;
    const url = await readYoutubePageUrl(videoDir, video_id);
    let title = video_id;
    if (hasMeta) {
      try {
        const raw = await readFile(path.join(videoDir, "metadata.json"), "utf8");
        const meta = JSON.parse(raw) as { title?: string };
        if (typeof meta.title === "string" && meta.title.length > 0) title = meta.title;
      } catch {
        /* ignore */
      }
    }
    rows.push({ video_id, url, title });
  }
  rows.sort((a, b) => a.video_id.localeCompare(b.video_id));
  return rows;
};

/** Native `yt2x pipeline` 的视频 id 列表（字典序，与 `listBatchVideosFromOutRoot` 一致）。 */
export const collectNativePipelineVideoIds = async (outRoot: string): Promise<string[]> => {
  const rows = await listBatchVideosFromOutRoot(outRoot);
  return rows.map((r) => r.video_id);
};

/** 校验某阶段期望产物是否存在于 `videoDir`。 */
export const validateArtifacts = async (videoDir: string, step: PipelineStep): Promise<boolean> => {
  const checks: Record<PipelineStep, string[]> = {
    acquire: ["metadata.json", "chunks.md", "timestamped-cues.md"],
    notes: ["structured-notes.md"],
    article: [],
    publish: [],
  };

  const files = checks[step] ?? [];
  for (const file of files) {
    try {
      await access(path.join(videoDir, file));
    } catch {
      return false;
    }
  }
  return true;
};
