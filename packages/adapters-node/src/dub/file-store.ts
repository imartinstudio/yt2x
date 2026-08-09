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
 *     full.zh-dub.srt      双语反向 SRT（中文在上、英文在下），交给统一烧录路径
 *     full.zh-dub.zh.srt   中文单语，只供双语质量门的三份 SRT 一致性检查比对
 *     full.zh-dub.en.srt   英文单语，同上
 *     full.zh-dubbed.mp4   统一烧录后的成片（不再由 dub 自己产出，见 remix.ts）
 */

export const DUB_DIR_NAME = "dub";
export const DUB_SCRIPT_FILE = "dub-script.json";
export const DUB_TIMING_FILE = "dub-timing.json";
export const DUB_PLAN_FILE = "dub-plan.json";
export const DUB_PLACEMENT_FILE = "dub-placement.json";
/** 落点报告的当前 schema 版本；schema 与两条错误信息共用，避免三处各写一个字面量。 */
export const DUB_PLACEMENT_VERSION = 3;
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

/** 中文单语变体，仅供双语质量门的三份 SRT 一致性检查用，不单独烧录。 */
export const dubZhSrtPathFor = (articleRoot: string, videoId: string): string =>
  path.join(articleRoot, videoId, "video", "full.zh-dub.zh.srt");

/** 英文单语变体，用途同上。 */
export const dubEnSrtPathFor = (articleRoot: string, videoId: string): string =>
  path.join(articleRoot, videoId, "video", "full.zh-dub.en.srt");

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

export const DUB_SCRIPT_VERSION = 3;

/**
 * version 必须锁死在 3：术语 profile 指纹加入后，旧版 2 不能复用（sourceWords 取代
 * sourceSubtitle、sourceText 从中文变英文、cueIndices 语义从字幕条变话语单元、新增
 * droppedCount），旧版 1 的落盘文件语义完全不同。读回不校验会让旧缓存被静默复用——
 * 门禁会用错误基准判定信息损失，而 gate 恰好因为 sourceText 又变回中文而"通过"，
 * 问题被完全掩盖（见 docs/DUB-TASK.md 对应验收记录）。
 */
export const DubScriptSchema = z.object({
  version: z.literal(DUB_SCRIPT_VERSION),
  videoId: z.string().min(1),
  sourceWords: z.string().min(1),
  rewriteModel: z.string().min(1),
  technicalTermProfileFingerprint: z.string().min(1),
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
        `Invalid or incompatible ${DUB_SCRIPT_FILE} in ${dubDir} (expected schema version ${DUB_SCRIPT_VERSION}): ` +
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

const DubPlacedLineSchema = z.object({
  index: z.number().int(),
  action: z.enum(["keep", "speed", "stretch", "delay"]),
  rate: z.number().positive(),
  text: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  audioFile: z.string().min(1),
});

/**
 * 磁盘上的落点报告必须通过 runtime 校验，口径与 DubTimingReportSchema 一致——
 * 残缺内容（例如被手工命令覆写成只剩 audioEndMs 的对象）必须报错，而不是被当作
 * 有效产物静默消费。version 锁死在 3：runId/generatedAt 是本次改动新增的来源
 * 标记（见 issue #110），旧版本没有这两个字段，不提供兼容读取。
 */
export const DubPlacementReportSchema = z.object({
  version: z.literal(DUB_PLACEMENT_VERSION),
  runId: z.string().min(1),
  generatedAt: z.string().min(1),
  videoId: z.string().min(1),
  engine: z.string().min(1),
  voice: z.string().min(1),
  lines: z.array(DubPlacedLineSchema).min(1),
  extendMs: z.number(),
  audioEndMs: z.number().nonnegative(),
  speedCount: z.number().int().nonnegative(),
  stretchCount: z.number().int().nonnegative(),
  delayCount: z.number().int().nonnegative(),
  keepCount: z.number().int().nonnegative(),
});

/**
 * 校验失败（含旧版本号、残缺字段）时抛出可定位的错误，而不是把裸 JSON 当
 * DubPlacementReport 塞回去——目前唯一的读取方是 dub-replay 的协商核对，读回
 * 出错时它会把这份报告当作不可用，而不是拿残缺数据继续对账。
 */
export const readDubPlacementReport = async (dubDir: string): Promise<DubPlacementReport> => {
  const raw: unknown = JSON.parse(await readFile(path.join(dubDir, DUB_PLACEMENT_FILE), "utf8"));
  const parsed = DubPlacementReportSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  // 「版本过期」与「内容残缺」要分开说。前者重跑一次就有，后者才是本文件存在的理由
  // （issue #110 的事故：报告被覆写成只剩总时长，分析者拿残缺数据得出错误结论）。
  // 把两者压成同一条 `Invalid ...` 会让人对着一份内容完好、只是版本旧的文件去查代码
  // ——正是这道校验本该消除的那类误判。
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version !== DUB_PLACEMENT_VERSION) {
    throw new Error(
      `${DUB_PLACEMENT_FILE} in ${dubDir} is from an older schema (found version ${version}, ` +
        `expected ${DUB_PLACEMENT_VERSION}). It is a regenerable intermediate — re-run \`yt2x dub\` ` +
        "for this video. The file itself is not damaged.",
    );
  }
  throw new Error(
    `Invalid ${DUB_PLACEMENT_FILE} in ${dubDir} (expected schema version ${DUB_PLACEMENT_VERSION}): ` +
      `${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
  );
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
