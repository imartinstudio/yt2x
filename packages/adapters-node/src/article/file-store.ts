import type { Dirent } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArticleVisualPlanItem, AvailableVisual, YouTubeMetadata } from "@yt2x/core";

/**
 * Native article 输出根目录（扁平）：articleOutDir/videoId/article.md
 */
export const DEFAULT_ARTICLE_OUT_DIR = "files/articles";

export type StructuredNotesArtifacts = {
  videoDir: string;
  videoId: string;
  structuredNotesMd: string;
  metadata: YouTubeMetadata;
};

export type NativeArticleRunRecord = {
  v: 1;
  platform: "x";
  videoId: string;
  model: string;
  finishReason: string;
  generatedAt: string;
  durationMs: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
};

export type ReadStructuredNotesError = {
  videoDir: string;
  missing: string[];
};

/**
 * 读取生成 article 所需的笔记产物（仅需 structured-notes + metadata）。
 */
export const readStructuredNotesArtifacts = async (videoDir: string): Promise<StructuredNotesArtifacts> => {
  const notesPath = path.join(videoDir, "structured-notes.md");
  const metadataPath = path.join(videoDir, "metadata.json");
  const [notesRaw, metadataRaw] = await Promise.all([safeReadText(notesPath), safeReadText(metadataPath)]);
  const missing: string[] = [];
  if (notesRaw === null) missing.push("structured-notes.md");
  if (metadataRaw === null) missing.push("metadata.json");
  if (missing.length > 0) {
    const err: Error & ReadStructuredNotesError = Object.assign(
      new Error(
        'Video directory "' +
          videoDir +
          '" is missing required notes outputs: ' +
          missing.join(", ") +
          ". Run yt2x notes first.",
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
    throw new Error('metadata.json in "' + videoDir + '" is not valid JSON: ' + m);
  }
  return {
    videoDir,
    videoId: path.basename(videoDir),
    structuredNotesMd: notesRaw!,
    metadata,
  };
};

/**
 * 扫描 notesOutDir：已有 structured-notes.md、且 native article 目录下尚无 article.md。
 */
export const findPendingNativeArticleDirs = async (
  notesOutDir: string,
  articleOutDir: string,
): Promise<string[]> => {
  let entries: Dirent[];
  try {
    entries = await readdir(notesOutDir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const pending: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const videoDir = path.join(notesOutDir, entry.name);
    const hasNotes = await fileExists(path.join(videoDir, "structured-notes.md"));
    if (!hasNotes) continue;
    const destArticle = path.join(articleOutDir, entry.name, "article.md");
    const hasArticle = await fileExists(destArticle);
    if (hasArticle) continue;
    pending.push(videoDir);
  }
  return pending.sort();
};

export type WriteNativeArticleResult = {
  articleDir: string;
  articlePath: string;
  runPath: string;
  coverPath: string | null;
};

/**
 * 原子写入 article.md 与 run.json，并在传入 notesVideoDir 时尝试复制封面图。
 */
/**
 * 校验 videoId 是安全目录名（只允许字母数字、连字符、下划线），防止路径遍历。
 */
export const isValidVideoId = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id);

export const writeNativeArticleBundle = async (
  articleOutDir: string,
  videoId: string,
  articleMd: string,
  run: NativeArticleRunRecord,
  options: { force?: boolean; notesVideoDir?: string } = {},
): Promise<WriteNativeArticleResult> => {
  if (!isValidVideoId(videoId)) {
    throw new Error(`Invalid videoId: "${videoId}". Expected alphanumeric, hyphens, and underscores only.`);
  }
  const articleDir = path.join(path.resolve(articleOutDir), videoId);
  const articlePath = path.join(articleDir, "article.md");
  const runPath = path.join(articleDir, "run.json");

  if (options.force !== true) {
    try {
      await stat(articlePath);
      throw new Error(
        articlePath + " already exists. Pass --force to overwrite, or delete it first.",
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  await mkdir(path.join(articleDir, "images"), { recursive: true });
  await atomicWriteUtf8(articlePath, articleMd);
  await atomicWriteUtf8(runPath, JSON.stringify(run, null, 2) + "\n");

  let coverPath: string | null = null;
  if (options.notesVideoDir !== undefined) {
    coverPath = await copyBestCoverFromNotesDir(options.notesVideoDir, articleDir);
  }

  return {
    articleDir,
    articlePath,
    runPath,
    coverPath,
  };
};

/**
 * 从笔记目录 screenshots 中挑一张图复制为 images/cover.*（由 writeNativeArticleBundle 在末尾调用）。
 */
export const copyBestCoverFromNotesDir = async (
  notesVideoDir: string,
  articleDir: string,
): Promise<string | null> => {
  const shotDir = path.join(notesVideoDir, "screenshots");
  let names: string[];
  try {
    names = await readdir(shotDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const allowed = /\.(webp|jpg|jpeg|png)$/i;
  const pick = names.filter((n) => allowed.test(n)).sort()[0];
  if (pick === undefined) return null;
  const ext = path.extname(pick).toLowerCase();
  const dest = path.join(articleDir, "images", "cover" + ext);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(path.join(shotDir, pick), dest);
  return dest;
};

/**
 * 将长文中的 screenshots/ 图片引用替换为 images/ 并复制实际文件。
 *
 * @param articleMd 原始长文内容
 * @param notesVideoDir 视频采集目录（含 screenshots/）
 * @param articleDir 文章输出目录（含 images/）
 * @param visualPlan LLM 生成的配图计划
 * @param availableVisuals 可用截图清单
 * @returns 替换后的长文内容
 */
export const renderArticleImages = async (
  articleMd: string,
  notesVideoDir: string,
  articleDir: string,
  visualPlan: ArticleVisualPlanItem[],
  availableVisuals: AvailableVisual[] | null | undefined,
): Promise<string> => {
  if (visualPlan.length === 0) return articleMd;

  const visuals = availableVisuals ?? [];
  const visualByPath = new Map<string, AvailableVisual>();
  for (const v of visuals) {
    const file = v.path.replace(/^screenshots\//, "");
    visualByPath.set(file, v);
  }

  let rendered = articleMd;
  const imagesDir = path.join(articleDir, "images");
  await mkdir(imagesDir, { recursive: true });

  for (const item of visualPlan) {
    // 找到对应的 available_visual
    const visual = visuals.find((v) => v.visual_id === item.visual_id);
    if (visual === undefined) continue;

    // 质量检查
    if (visual.quality.blur === "high" || visual.quality.blur === "unknown") continue;
    if (visual.quality.center_presenter === true) continue;

    const srcFile = visual.path.replace(/^screenshots\//, "");
    const srcPath = path.join(notesVideoDir, "screenshots", srcFile);

    // 验证源文件存在
    try {
      await stat(srcPath);
    } catch {
      // 源文件不存在 → 不写这个引用
      continue;
    }

    // 复制到文章 images 目录
    const ext = path.extname(srcFile);
    const destName = `${item.visual_id}${ext}`;
    const destPath = path.join(imagesDir, destName);
    await copyFile(srcPath, destPath);

    // 替换 Markdown 中的图片路径：screenshots/<file> → images/<destName>
    const oldRef = new RegExp(
      `!\\[([^\\]]*)\\]\\(screenshots/${escapeRegExp(srcFile)}\\)`,
      "g",
    );
    const newRef = `![${item.caption}](images/${destName})`;
    if (oldRef.test(rendered)) {
      rendered = rendered.replace(oldRef, newRef);
    }
  }

  return rendered;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

const atomicWriteUtf8 = async (targetPath: string, body: string): Promise<void> => {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = targetPath + "." + String(process.pid) + "." + String(Date.now()) + ".tmp";
  await writeFile(tmp, body, "utf8");
  await rename(tmp, targetPath);
};
