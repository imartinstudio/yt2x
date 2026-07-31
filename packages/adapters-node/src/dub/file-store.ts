import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type DubGateReport,
  type DubNegotiatePlan,
  type DubPlacementReport,
  type DubScript,
  type DubTimingReport,
  type TimedWord,
} from "@yt2x/core";
import { resolveSourceVideo } from "../acquire/video-subtitles.js";

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
 * 本地转录（faster-whisper，见 transcribe-local.py）产出的词级时间戳只写在下载
 * 目录一处，不像 full.zh.srt 有 article/downloads 两个历史候选——配音的本地转录
 * 通道就是它的唯一真源（见 docs/dub-context-glossary 的“字幕通道”定义）。
 */
export const resolveDubWordsPath = async (input: {
  outRoot: string;
  videoId: string;
  /** 转录源语言，默认 "en"（配音目前只支持英文源）。 */
  language?: string;
}): Promise<string> => {
  const language = input.language ?? "en";
  const candidate = path.join(
    input.outRoot,
    input.videoId,
    "video",
    `full.local.${language}.words.json`,
  );
  if (await exists(candidate)) return candidate;
  throw new Error(
    `No local word-level transcript found for "${input.videoId}". Looked at: ${candidate}. ` +
      "Run `yt2x subtitle transcribe-local <videoId>` first.",
  );
};

const DubWordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
});

/**
 * 把 transcribe-local.py 写出的词级时间戳解析成 TimedWord[]：时间戳在这里一次性
 * 从秒转成毫秒，之后全是整数毫秒运算。
 */
export const parseDubWords = (raw: string): TimedWord[] => {
  const parsed: unknown = JSON.parse(raw);
  const words = z.array(DubWordSchema).parse(parsed);
  return words.map((w) => ({
    word: w.word,
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
  }));
};

export const readDubWords = async (wordsPath: string): Promise<TimedWord[]> =>
  parseDubWords(await readFile(wordsPath, "utf8"));

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

const DubScriptLineSchema = z.object({
  index: z.number().int(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  targetDurationMs: z.number().nonnegative(),
  text: z.string(),
  sourceText: z.string(),
  cueIndices: z.array(z.number().int()),
});

/**
 * version 必须锁死在 2：PR3 切换到本地转录通道后 schema 实质变了（sourceWords 取代
 * sourceSubtitle、sourceText 从中文变英文、cueIndices 语义从字幕条变话语单元、新增
 * droppedCount），旧版 1 的落盘文件语义完全不同。读回不校验会让旧缓存被静默复用——
 * 门禁会用错误基准判定信息损失，而 gate 恰好因为 sourceText 又变回中文而"通过"，
 * 问题被完全掩盖（见 docs/DUB-TASK.md 对应验收记录）。
 */
export const DubScriptSchema = z.object({
  version: z.literal(2),
  videoId: z.string().min(1),
  sourceWords: z.string().min(1),
  rewriteModel: z.string().min(1),
  lines: z.array(DubScriptLineSchema),
  droppedCount: z.number().int().nonnegative(),
});

/**
 * 校验失败（含旧版本号）时直接拒绝复用缓存并抛错，而不是把裸 JSON 当 DubScript
 * 塞回去——调用方（native-dub.ts）捕获后应当把它当缓存未命中处理，重新生成。
 */
export const readDubScript = async (dubDir: string): Promise<DubScript> => {
  const filePath = path.join(dubDir, DUB_SCRIPT_FILE);
  const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
  const parsed = DubScriptSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid or incompatible ${DUB_SCRIPT_FILE} in ${dubDir} (expected schema version 2): ` +
        `${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. ` +
        "This is likely a pre-PR3 cache from the old Chinese-subtitle dubbing path — delete the " +
        "file or re-run with --force to regenerate it.",
    );
  }
  return parsed.data;
};

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
 * 解析源视频路径：只从下载目录取原始素材。
 * 内容目录（articles）是产物写入目标，不得作为素材来源；缺失时明确报错。
 * `articleRoot` 保留在签名中供调用方传入，但故意不参与候选，避免退回加工产物。
 */
export const resolveDubSourceVideo = async (input: {
  articleRoot: string;
  outRoot: string;
  videoId: string;
}): Promise<{ videoPath: string; videoDir: string; preferred: boolean }> => {
  void input.articleRoot;
  const videoDir = path.join(input.outRoot, input.videoId);
  const looked = [path.join(videoDir, "video")];
  const source = await resolveSourceVideo(videoDir);
  if (source !== undefined) {
    return {
      videoPath: path.join(videoDir, "video", source.name),
      videoDir,
      preferred: source.preferred,
    };
  }
  throw new Error(
    `No source video found for "${input.videoId}". Looked under: ${looked.join(", ")}. ` +
      `Dubbing requires the original under downloads (not processed copies under articles). ` +
      `Run \`yt2x acquire\` first.`,
  );
};
