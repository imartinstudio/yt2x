import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const SUBTITLE_EXTS = new Set([".vtt", ".srt"]);

export const listSubtitleFiles = async (videoDir: string): Promise<string[]> => {
  const files: string[] = [];

  const scanDir = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      const ext = path.extname(name).toLowerCase();
      if (!SUBTITLE_EXTS.has(ext)) {
        continue;
      }
      try {
        const st = await stat(full);
        if (st.isFile()) {
          files.push(full);
        }
      } catch {
        // skip
      }
    }
  };

  // 根目录（yt-dlp 下载的原始字幕文件）
  await scanDir(videoDir);
  // video/ 子目录（transcribe 等本地生成的 subtitle files）
  await scanDir(path.join(videoDir, "video"));

  return files.sort();
};

export const subtitleChoiceScore = (
  filePath: string,
  preferredLang: string | null,
): [number, number, number, string] => {
  const nameLower = path.basename(filePath).toLowerCase();
  const lang = (preferredLang ?? "").trim().toLowerCase();
  if (lang) {
    let tier: number;
    if (nameLower.includes(`.${lang}-orig.`)) {
      tier = 0;
    } else if (nameLower.includes(`.${lang}.`)) {
      tier = 1;
    } else {
      tier = 2;
    }
    const orig = nameLower.includes("-orig.") ? 0 : 1;
    return [tier, orig, nameLower.length, nameLower];
  }
  const tier = nameLower.includes("-orig.") ? 0 : 1;
  return [tier, 0, nameLower.length, nameLower];
};

export const chooseSubtitleFile = async (
  videoDir: string,
  preferredLang: string | null,
): Promise<string | null> => {
  const subtitles = await listSubtitleFiles(videoDir);
  if (subtitles.length === 0) {
    return null;
  }
  subtitles.sort((a, b) => {
    const sa = subtitleChoiceScore(a, preferredLang);
    const sb = subtitleChoiceScore(b, preferredLang);
    for (let i = 0; i < sa.length; i++) {
      const av = sa[i]!;
      const bv = sb[i]!;
      if (av < bv) {
        return -1;
      }
      if (av > bv) {
        return 1;
      }
    }
    return 0;
  });
  return subtitles[0] ?? null;
};

export const subtitleFingerprint = async (videoDir: string): Promise<Map<string, number>> => {
  const files = await listSubtitleFiles(videoDir);
  const fp = new Map<string, number>();
  for (const f of files) {
    try {
      const st = await stat(f);
      fp.set(f, st.mtimeMs);
    } catch {
      // skip
    }
  }
  return fp;
};

export const fingerprintChanged = (
  before: Map<string, number>,
  after: Map<string, number>,
): boolean => {
  for (const key of after.keys()) {
    if (!before.has(key)) {
      return true;
    }
  }
  for (const [pathKey, mtime] of after) {
    const prev = before.get(pathKey);
    if (prev === undefined || Math.abs(mtime - prev) > 500) {
      return true;
    }
  }
  return false;
};
