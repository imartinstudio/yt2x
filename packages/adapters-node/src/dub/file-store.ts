import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSrtTimestampToMs, type DubCue, type DubScript, type DubTimingReport } from "@yt2x/core";
import { parseSubtitleBlocks } from "../acquire/video-subtitles.js";

/**
 * 配音产物布局（沿用 files/articles/<videoId>/ 约定）：
 *
 *   files/articles/<videoId>/dub/
 *     dub-script.json      配音稿
 *     dub-timing.json      倍率 1.0 的实测时长报告
 *     lines/0001.mp3 ...   逐句音频
 */

export const DUB_DIR_NAME = "dub";
export const DUB_SCRIPT_FILE = "dub-script.json";
export const DUB_TIMING_FILE = "dub-timing.json";
export const DUB_LINES_DIR = "lines";

export const dubDirFor = (articleRoot: string, videoId: string): string =>
  path.join(articleRoot, videoId, DUB_DIR_NAME);

const exists = async (candidate: string): Promise<boolean> =>
  access(candidate)
    .then(() => true)
    .catch(() => false);

/**
 * full.zh.srt 在两处都可能存在：subtitle 阶段写到 article 目录，早期 pipeline 写在
 * 下载目录。两处都找，找不到就报出两条候选路径——只报一条会让人以为另一条不该有。
 */
export const resolveZhSubtitlePath = async (input: {
  articleRoot: string;
  outRoot: string;
  videoId: string;
}): Promise<string> => {
  const candidates = [
    path.join(input.articleRoot, input.videoId, "video", "full.zh.srt"),
    path.join(input.outRoot, input.videoId, "video", "full.zh.srt"),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(
    `No Chinese subtitle found for "${input.videoId}". Looked at: ${candidates.join(", ")}. Run \`yt2x subtitle\` first.`,
  );
};

/** 把 SRT 文本解析成 DubCue：时间戳在这里一次性转成毫秒，之后全是数值运算。 */
export const parseDubCues = (srt: string): DubCue[] => {
  const cues: DubCue[] = [];
  for (const block of parseSubtitleBlocks(srt)) {
    const text = block.text.join(" ").trim();
    if (text.length === 0) continue;
    const startMs = parseSrtTimestampToMs(block.start);
    const endMs = parseSrtTimestampToMs(block.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    cues.push({ index: block.index, startMs, endMs, text });
  }
  return cues;
};

export const readDubCues = async (srtPath: string): Promise<DubCue[]> =>
  parseDubCues(await readFile(srtPath, "utf8"));

/** 临时文件 + rename。中途崩溃不会留下半截 JSON 让下一次运行读到坏数据。 */
const atomicWrite = async (filePath: string, content: string | Uint8Array): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  if (typeof content === "string") {
    await writeFile(tmpPath, content, "utf8");
  } else {
    await writeFile(tmpPath, content);
  }
  await rename(tmpPath, filePath);
};

export const writeDubScript = async (dubDir: string, script: DubScript): Promise<string> => {
  const filePath = path.join(dubDir, DUB_SCRIPT_FILE);
  await atomicWrite(filePath, `${JSON.stringify(script, null, 2)}\n`);
  return filePath;
};

export const writeDubTimingReport = async (
  dubDir: string,
  report: DubTimingReport,
): Promise<string> => {
  const filePath = path.join(dubDir, DUB_TIMING_FILE);
  await atomicWrite(filePath, `${JSON.stringify(report, null, 2)}\n`);
  return filePath;
};

/** 行音频文件名，4 位补零，保证 `ls` 和 ffmpeg concat 的字典序等于播放顺序。 */
export const dubLineAudioName = (index: number, format: string): string =>
  `${String(index).padStart(4, "0")}.${format}`;

export type WrittenDubLineAudio = {
  /** 绝对路径，给 ffprobe 用。 */
  absolutePath: string;
  /** 相对 dub 目录的路径，写进报告——绝对路径进产物会让目录搬家后全失效。 */
  relativePath: string;
};

export const writeDubLineAudio = async (
  dubDir: string,
  index: number,
  audio: Uint8Array,
  format: string,
): Promise<WrittenDubLineAudio> => {
  const relativePath = `${DUB_LINES_DIR}/${dubLineAudioName(index, format)}`;
  const absolutePath = path.join(dubDir, DUB_LINES_DIR, dubLineAudioName(index, format));
  await atomicWrite(absolutePath, audio);
  return { absolutePath, relativePath };
};

export const readDubScript = async (dubDir: string): Promise<DubScript> =>
  JSON.parse(await readFile(path.join(dubDir, DUB_SCRIPT_FILE), "utf8")) as DubScript;
