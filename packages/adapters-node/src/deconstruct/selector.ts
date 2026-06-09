import { readFile, writeFile, unlink, rename } from "node:fs/promises";
import path from "node:path";
import type { DeconstructManifest, ClipEntry } from "@yt2x/core";

export type SelectClipsInput = {
  articleDir: string;
  /** 要保留的 clip IDs（如 "clip-1,clip-3,clip-5"）或序号（"1,3,5"） */
  keep: string[];
};

export type SelectClipsResult = {
  manifestPath: string;
  kept: number;
  removed: number;
};

/**
 * 从 manifest 中选择保留哪些候选，删除未选中的视频文件。
 */
export const selectClips = async (input: SelectClipsInput): Promise<SelectClipsResult> => {
  const manifestPath = path.join(input.articleDir, "clips", "clips-manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const manifest: DeconstructManifest = JSON.parse(raw);

  // 解析 keep 列表：支持 "clip-1" 格式和 "1" 格式
  const keepSet = new Set<string>();
  for (const k of input.keep) {
    const trimmed = k.trim();
    if (trimmed.startsWith("clip-") || trimmed.startsWith("candidate-")) {
      keepSet.add(trimmed);
    } else {
      // 纯数字 → 转为 clip-N
      keepSet.add(`clip-${trimmed}`);
    }
  }

  const kept: ClipEntry[] = [];
  const removed: string[] = [];

  // 从 manifest.clips 里按 clip ID 的序号数字匹配
  // 实际 clip ID 是 "clip-1", "clip-2" 格式，序号 = 数字部分
  for (const entry of manifest.clips) {
    const match = entry.id.match(/^clip-(\d+)$/);
    if (!match) {
      // 兼容 candidate-N 格式
      const cm = entry.id.match(/^candidate-(\d+)$/);
      const idx = cm ? `clip-${cm[1]}` : entry.id;
      if (keepSet.has(idx) || keepSet.has(entry.id) || keepSet.has(entry.slug)) {
        kept.push({ ...entry, selected: true });
      } else {
        removed.push(entry.video);
      }
    } else {
      // clip-N 格式
      const numId = match[1]!;
      if (keepSet.has(`clip-${numId}`) || keepSet.has(numId)) {
        kept.push({ ...entry, selected: true });
      } else {
        removed.push(entry.video);
      }
    }
  }

  // 删除未选中的视频文件
  const clipsDir = path.join(input.articleDir, "clips");
  let removedCount = 0;
  for (const filename of removed) {
    try {
      await unlink(path.join(clipsDir, filename));
      removedCount++;
    } catch {
      // 文件可能已被删除
    }
  }

  // 重编号保留的 clip：按 manifest 中原有顺序保留，但 id 重编
  const renumbered = kept.map((entry, i) => ({
    ...entry,
    id: `clip-${i + 1}`,
    selected: true,
    slug: entry.slug,
    video: `clip-${i + 1}-${entry.slug}.mp4`,
  }));

  // 如果有重编号，重命名视频文件
  for (let i = 0; i < kept.length; i++) {
    const oldPath = path.join(clipsDir, kept[i]!.video);
    const newPath = path.join(clipsDir, renumbered[i]!.video);
    if (oldPath !== newPath) {
      try {
        await unlink(newPath).catch(() => {}); // 删除可能存在的目标
        await rename(oldPath, newPath);
      } catch {
        // renaming may fail if file doesn't exist
      }
    }
  }

  // 更新 manifest — 保留 originalCandidateCount 供报告参考
  const updated: DeconstructManifest = {
    ...manifest,
    generatedAt: new Date().toISOString(),
    candidateCount: manifest.candidateCount,
    total: renumbered.length,
    clips: renumbered,
  };

  await writeFile(manifestPath, JSON.stringify(updated, null, 2) + "\n", "utf8");

  return {
    manifestPath,
    kept: renumbered.length,
    removed: removedCount,
  };
};
