import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DeconstructManifest, SectionCandidate } from "@yt2x/core";

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

export type SelectedSection = {
  section: SectionCandidate;
  originalIndex: number;
};

const articleSectionKey = (section: SectionCandidate): string => {
  const key = section.article_section.trim();
  return key.length > 0 ? key : section.title.replace(/\s*\(\d+\/\d+\)\s*$/, "").trim();
};

/**
 * 按综合评分排序，但同一个文章章节只保留最高分片段。
 */
export const selectTopUniqueArticleSections = (
  sections: SectionCandidate[],
  limit: number,
): SelectedSection[] => {
  const bestByArticleSection = new Map<string, SelectedSection>();

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const key = articleSectionKey(section);
    const current = bestByArticleSection.get(key);
    if (current === undefined || section.scores.composite > current.section.scores.composite) {
      bestByArticleSection.set(key, { section, originalIndex: i });
    }
  }

  return [...bestByArticleSection.values()]
    .sort((a, b) => b.section.scores.composite - a.section.scores.composite)
    .slice(0, Math.max(0, limit));
};

/**
 * 从 manifest 中选择保留哪些候选，标记 selected 状态。
 * 不再删除未选中视频——视频裁剪在 selection 之后才进行。
 */
export const selectClips = async (input: SelectClipsInput): Promise<SelectClipsResult> => {
  const manifestPath = path.join(input.articleDir, "x-format", "clips", "clips-manifest.json");
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

  let keptCount = 0;
  let removedCount = 0;

  // 标记每个候选的 selected 状态，保留所有条目和原始 ID
  for (const entry of manifest.clips) {
    const match = entry.id.match(/^clip-(\d+)$/);
    const clipKey = match ? `clip-${match[1]}` : entry.id;
    if (keepSet.has(clipKey) || keepSet.has(entry.id) || keepSet.has(entry.slug)) {
      entry.selected = true;
      keptCount++;
    } else {
      entry.selected = false;
      removedCount++;
    }
  }

  // 更新 manifest — 保留全部候选，不删视频
  const updated: DeconstructManifest = {
    ...manifest,
    generatedAt: new Date().toISOString(),
    candidateCount: manifest.candidateCount,
    total: keptCount,
    clips: manifest.clips,
  };

  await writeFile(manifestPath, JSON.stringify(updated, null, 2) + "\n", "utf8");

  return {
    manifestPath,
    kept: keptCount,
    removed: removedCount,
  };
};
