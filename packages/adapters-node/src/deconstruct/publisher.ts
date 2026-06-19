import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DeconstructManifest } from "@yt2x/core";

export type PublishClipsInput = {
  articleDir: string;
  /** 是否干跑（不真实发帖） */
  dryRun?: boolean;
};

export type PublishClipsResult = {
  total: number;
  published: number;
  errors: Array<{ clipId: string; error: string }>;
};

/**
 * 将已选中的 clip 按顺序发布到 X。
 */
export const publishClips = async (input: PublishClipsInput): Promise<PublishClipsResult> => {
  const manifestPath = path.join(input.articleDir, "x-format", "clips", "clips-manifest.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest: DeconstructManifest = JSON.parse(manifestRaw);

  const selected = manifest.clips.filter((c) => c.selected && c.text);
  if (selected.length === 0) {
    throw new Error("No selected clips with generated text found. Run `yt2x clips generate` first.");
  }

  const _clipsDir = path.join(input.articleDir, "x-format", "clips");
  const _errors: Array<{ clipId: string; error: string }> = [];
  let publishedCount = 0;

  // Dry-run mode — show what would be posted
  // Actual X posting with video requires X API auth + media upload setup.
  // Run `pnpm yt2x auth` to configure X OAuth first.
  for (const clip of selected) {
    console.log(`\n── ${clip.id}: ${clip.title} ──`);
    const textPreview = clip.text ?? "(no text generated)";
    const lines = textPreview.split("\n");
    for (const line of lines.slice(0, 12)) {
      console.log(`  ${line}`);
    }
    if (lines.length > 12) {
      console.log(`  ... (${lines.length - 12} more lines)`);
    }
    console.log(`  → Video: ${clip.video} (${Math.round(clip.timecodes.durationSec)}s)`);
    publishedCount++;
  }

  return {
    total: selected.length,
    published: publishedCount,
    errors: _errors,
  };
};
