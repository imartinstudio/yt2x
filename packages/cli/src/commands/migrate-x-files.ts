import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Migrate all platform files into their respective format directories.
 * Safe to run multiple times (idempotent).
 *
 * X → x-format/: x-*.md, x-*.json, images/ (except cover.webp), clips/
 * Xiaohongshu → xiaohongshu-format/: xiaohongshu-article.md, xiaohongshu-metadata.json
 * Bilibili → bilibili-format/: bilibili-article.md, bilibili-metadata.json
 * WeChat → wechat-format/: wechat-article.md, wechat-metadata.json
 *
 *
 * @returns Total number of files migrated (moved or copied).
 */
export const migrateXFilesToFormatDir = async (
  articlesRoot: string,
): Promise<number> => {
  let migrated = 0;
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(articlesRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  const xContentFiles = [
    "x-short.md", "x-short-visual.json",
    "x-thread.md", "x-hooks.json", "x-thread-visuals.json",
    "x-video-short.md", "article_for_x.md",
    "publish-result.json", "publish-preview.json",
  ];

  const platformMoves: Array<{ file: string; formatDir: string }> = [
    { file: "xiaohongshu-article.md", formatDir: "xiaohongshu-format" },
    { file: "xiaohongshu-metadata.json", formatDir: "xiaohongshu-format" },
    { file: "bilibili-article.md", formatDir: "bilibili-format" },
    { file: "bilibili-metadata.json", formatDir: "bilibili-format" },
    { file: "wechat-article.md", formatDir: "wechat-format" },
    { file: "wechat-metadata.json", formatDir: "wechat-format" },
  ];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(articlesRoot, entry.name);

    // Skip if article.md doesn't exist (not a video directory)
    try { await access(path.join(dir, "article.md")); } catch { continue; }

    const xFormatDir = path.join(dir, "x-format");

    // ── X content files: move root → x-format/ ──
    for (const file of xContentFiles) {
      const oldPath = path.join(dir, file);
      const newPath = path.join(xFormatDir, file);
      try { await access(oldPath); } catch { continue; }
      try { await access(newPath); continue; } catch { /* not yet */ }
      try {
        await mkdir(xFormatDir, { recursive: true });
        await rename(oldPath, newPath);
        migrated++;
      } catch { /* skip */ }
    }

    // ── images/ handling ──
    // scene_* files are article-level artifacts, NOT platform-specific. They belong at root.
    // x-table-* files are X platform artifacts, stay in x-format/images/.
    // cover.webp stays at root.
    const rootImagesDir = path.join(dir, "images");
    const xImagesDir = path.join(xFormatDir, "images");

    // 1) Move scene_* files from x-format/images/ back to root images/
    const movedBackToRoot: string[] = [];
    try {
      const xImages = await readdir(xImagesDir);
      for (const img of xImages) {
        if (!img.startsWith("scene_")) continue;
        const srcPath = path.join(xImagesDir, img);
        const dstPath = path.join(rootImagesDir, img);
        try { await access(dstPath); continue; } catch { /* not yet */ }
        try {
          await mkdir(rootImagesDir, { recursive: true });
          await rename(srcPath, dstPath);
          movedBackToRoot.push(img);
          migrated++;
        } catch { /* skip */ }
      }
    } catch { /* no x-format/images/ */ }

    // 2) Move remaining non-cover, non-scene images into x-format/images/
    const movedToXFormat: string[] = [];
    try {
      const rootImgs = await readdir(rootImagesDir);
      for (const img of rootImgs) {
        if (img === "cover.webp") continue; // keep at root
        if (img.startsWith("scene_")) continue; // scene_* stay at root
        const oldPath = path.join(rootImagesDir, img);
        const newPath = path.join(xImagesDir, img);
        try { await access(newPath); continue; } catch { /* not yet */ }
        try {
          await mkdir(xImagesDir, { recursive: true });
          await rename(oldPath, newPath);
          movedToXFormat.push(img);
          migrated++;
        } catch { /* skip */ }
      }
    } catch { /* no images/ */ }

    // 3) Rewrite article.md references to match actual file locations.
    //    Never strip references — only rewrite paths when files have moved.
    if (movedBackToRoot.length > 0 || movedToXFormat.length > 0) {
      try {
        const articlePath = path.join(dir, "article.md");
        let text = await readFile(articlePath, "utf8");
        let changed = false;

        // 3a) x-format/images/scene_* → images/scene_* (files moved back to root in step 1)
        for (const img of movedBackToRoot) {
          const escaped = img.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`!\\[([^\\]]*)\\]\\(x-format/images/${escaped}\\)`, "g");
          if (re.test(text)) {
            text = text.replace(re, `![$1](images/${img})`);
            changed = true;
          }
        }

        // 3b) images/xxx → x-format/images/xxx (files moved to x-format in step 2)
        for (const img of movedToXFormat) {
          const escaped = img.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`!\\[([^\\]]*)\\]\\(images/${escaped}\\)`, "g");
          if (re.test(text)) {
            text = text.replace(re, `![$1](x-format/images/${img})`);
            changed = true;
          }
        }

        if (changed) {
          await writeFile(articlePath, text, "utf8");
          migrated++;
        }
      } catch { /* skip */ }
    }

    // ── clips/ → x-format/clips/ ──
    const clipsDir = path.join(dir, "clips");
    try {
      const clipEntries = await readdir(clipsDir);
      const xClipsDir = path.join(xFormatDir, "clips");
      for (const clip of clipEntries) {
        const oldClipPath = path.join(clipsDir, clip);
        const newClipPath = path.join(xClipsDir, clip);
        try { await access(newClipPath); continue; } catch { /* not yet */ }
        try {
          await mkdir(xClipsDir, { recursive: true });
          await rename(oldClipPath, newClipPath);
          migrated++;
        } catch { /* skip */ }
      }
    } catch { /* no clips/ */ }

    // ── Platform article/metadata files → their format dirs ──
    for (const { file, formatDir } of platformMoves) {
      const oldPath = path.join(dir, file);
      const newPath = path.join(dir, formatDir, file);
      try { await access(oldPath); } catch { continue; }
      try { await access(newPath); continue; } catch { /* not yet */ }
      try {
        await mkdir(path.join(dir, formatDir), { recursive: true });
        await rename(oldPath, newPath);
        migrated++;
      } catch { /* skip */ }
    }
  }

  return migrated;
};
