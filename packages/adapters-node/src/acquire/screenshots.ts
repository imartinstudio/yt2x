import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const RASTER_EXTS = new Set([".webp", ".jpg", ".jpeg", ".png"]);

export const screenshotsDirHasRaster = async (videoDir: string): Promise<boolean> => {
  const sd = path.join(videoDir, "screenshots");
  let entries: string[];
  try {
    entries = await readdir(sd);
  } catch {
    return false;
  }
  for (const name of entries) {
    const full = path.join(sd, name);
    try {
      const st = await stat(full);
      if (st.isFile() && RASTER_EXTS.has(path.extname(name).toLowerCase())) {
        return true;
      }
    } catch {
      // skip
    }
  }
  return false;
};

export const screenshotsDirHasOfficialYoutubeThumbnail = async (
  videoDir: string,
): Promise<boolean> => {
  const sd = path.join(videoDir, "screenshots");
  let entries: string[];
  try {
    entries = await readdir(sd);
  } catch {
    return false;
  }
  for (const name of entries) {
    const full = path.join(sd, name);
    try {
      const st = await stat(full);
      if (
        st.isFile() &&
        name.toLowerCase().startsWith("youtube_cover.") &&
        RASTER_EXTS.has(path.extname(name).toLowerCase())
      ) {
        return true;
      }
    } catch {
      // skip
    }
  }
  return false;
};
