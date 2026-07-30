import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  parseSrtTimestampToMs,
  type DubCue,
  type DubGateReport,
  type DubNegotiatePlan,
  type DubPlacementReport,
  type DubScript,
  type DubTimingReport,
} from "@yt2x/core";
import { parseSubtitleBlocks, resolveSourceVideo } from "../acquire/video-subtitles.js";

/**
 * 配音产物布局（沿用 files/articles/<videoId>/ 约定）：
 *
 *   files/articles/<videoId>/dub/
 *     dub-script.json      配音稿
 *     dub-timing.json      倍率 1.0 的实测时长报告
 *     dub-plan.json        时长协商计划
 *     dub-placement.json   最终落点（反向 SRT / 混音的输入）
 *     dub-report.json      门禁报告（PR3）
 *     lines/0001.mp3 ...   逐句音频
 *     demucs/no_vocals.wav
 *     voice.wav / mixed.m4a
 *   files/articles/<videoId>/video/
 *     full.zh-dub.srt
 *     full.zh-dubbed.mp4
 */

export const DUB_DIR_NAME = "dub";
export const DUB_SCRIPT_FILE = "dub-script.json";
export const DUB_TIMING_FILE = "dub-timing.json";
export const DUB_PLAN_FILE = "dub-plan.json";
export const DUB_PLACEMENT_FILE = "dub-placement.json";
export const DUB_REPORT_FILE = "dub-report.json";
export const DUB_LINES_DIR = "lines";
export const DUB_DEMUCS_DIR = "demucs";

export const dubDirFor = (articleRoot: string, videoId: string): string =>
  path.join(articleRoot, videoId, DUB_DIR_NAME);

export const dubDemucsDirFor = (dubDir: string): string => path.join(dubDir, DUB_DEMUCS_DIR);

export const dubbedVideoPathFor = (articleRoot: string, videoId: string): string =>
  path.join(articleRoot, videoId, "video", "full.zh-dubbed.mp4");

export const dubReverseSrtPathFor = (articleRoot: string, videoId: string): string =>
  path.join(articleRoot, videoId, "video", "full.zh-dub.srt");

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

/** 磁盘上的 timing 报告必须通过 runtime 校验——字段缺失不能带着 undefined 进协商。 */
const DubLineTimingSchema = z.object({
  index: z.number().int(),
  targetDurationMs: z.number().nonnegative(),
  synthesizedMs: z.number().positive(),
  ratio: z.number().nonnegative(),
  charCount: z.number().int().nonnegative(),
  audioFile: z.string().min(1),
});

export const DubTimingReportSchema = z.object({
  version: z.literal(1),
  videoId: z.string().min(1),
  engine: z.string().min(1),
  voice: z.string().min(1),
  lineCount: z.number().int().nonnegative(),
  medianRatio: z.number(),
  overflowCount: z.number().int().nonnegative(),
  totalDriftMs: z.number(),
  lines: z.array(DubLineTimingSchema).min(1),
});

export const readDubTimingReport = async (dubDir: string): Promise<DubTimingReport> => {
  const raw: unknown = JSON.parse(await readFile(path.join(dubDir, DUB_TIMING_FILE), "utf8"));
  const parsed = DubTimingReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${DUB_TIMING_FILE} in ${dubDir}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
};

export const writeDubPlan = async (dubDir: string, plan: DubNegotiatePlan): Promise<string> => {
  const filePath = path.join(dubDir, DUB_PLAN_FILE);
  await atomicWrite(filePath, `${JSON.stringify(plan, null, 2)}\n`);
  return filePath;
};

export const writeDubPlacement = async (
  dubDir: string,
  report: DubPlacementReport,
): Promise<string> => {
  const filePath = path.join(dubDir, DUB_PLACEMENT_FILE);
  await atomicWrite(filePath, `${JSON.stringify(report, null, 2)}\n`);
  return filePath;
};

export const writeDubGateReport = async (
  dubDir: string,
  report: DubGateReport,
): Promise<string> => {
  const filePath = path.join(dubDir, DUB_REPORT_FILE);
  await atomicWrite(filePath, `${JSON.stringify(report, null, 2)}\n`);
  return filePath;
};

/**
 * 解析源视频路径：优先 article 目录下的 video/full.mp4，其次下载目录。
 * 与 subtitle 烧录同一套 resolveSourceVideo 规则。
 */
export const resolveDubSourceVideo = async (input: {
  articleRoot: string;
  outRoot: string;
  videoId: string;
}): Promise<{ videoPath: string; videoDir: string; preferred: boolean }> => {
  const candidates = [
    path.join(input.articleRoot, input.videoId),
    path.join(input.outRoot, input.videoId),
  ];
  const looked: string[] = [];
  for (const videoDir of candidates) {
    looked.push(path.join(videoDir, "video"));
    const source = await resolveSourceVideo(videoDir);
    if (source !== undefined) {
      return {
        videoPath: path.join(videoDir, "video", source.name),
        videoDir,
        preferred: source.preferred,
      };
    }
  }
  throw new Error(
    `No source video found for "${input.videoId}". Looked under: ${looked.join(", ")}. Run \`yt2x acquire\` first.`,
  );
};
