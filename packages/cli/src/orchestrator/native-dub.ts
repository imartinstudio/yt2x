import { access } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EDGE_TTS_VOICE,
  DEFAULT_OUT_DIR,
  DUB_TIMING_FILE,
  createEdgeTtsAdapter,
  dubDirFor,
  generateDubScript,
  readDubCues,
  resolveZhSubtitlePath,
  sanitizeVideoId,
  synthesizeDubLines,
  writeDubScript,
  writeDubTimingReport,
} from "@yt2x/adapters-node";
import { isTtsError, mergeCuesIntoSegments, type MergeCuesOptions } from "@yt2x/core";
import { logger } from "../logger.js";
import { printCliErrorBlock } from "../diagnostics/error-format.js";
import { NATIVE_EXIT, resolveNativeLlm, type NativeLlmCliFlags } from "./native-stage-common.js";

/**
 * `yt2x dub` 编排：full.zh.srt → 自然句 → 朗读化改写 → 逐句 TTS → 时长报告。
 *
 * PR1 只出配音稿和时长数据，不碰视频。时长报告**只记录不阻断**——阈值要等这批
 * 真实数据出来才能定，现在就拿一个拍脑袋的阈值卡人只会挡住取数。
 */

const DEFAULT_ARTICLE_ROOT = "files/articles";

export type DubFlags = NativeLlmCliFlags & {
  videoId?: string;
  outDir?: string;
  articleOutDir?: string;
  voice?: string;
  /** edge-tts 可执行文件路径，默认走 PATH。 */
  ttsCommand?: string;
  ffprobePath?: string;
  maxGapMs?: string;
  maxChars?: string;
  maxDurationMs?: string;
  /** 只生成配音稿，不合成音频（省 TTS 时间，用来先审稿）。 */
  scriptOnly?: boolean;
  force?: boolean;
};

const EXIT_INPUT_MISSING = NATIVE_EXIT.NO_INPUT;

/** TtsError → 退出码。UNAVAILABLE 是"环境没装好"，和缺 LLM 配置同级。 */
const exitFromTtsKind = (kind: string): number => {
  if (kind === "UNAVAILABLE" || kind === "BAD_REQUEST") return NATIVE_EXIT.CONFIG_MISSING;
  if (kind === "AUTH") return NATIVE_EXIT.LLM_AUTH;
  if (kind === "QUOTA") return NATIVE_EXIT.LLM_QUOTA;
  if (kind === "NETWORK" || kind === "RATE_LIMIT") return NATIVE_EXIT.LLM_NETWORK;
  return 1;
};

const parsePositiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const mergeOptionsFrom = (flags: DubFlags): MergeCuesOptions => {
  const options: MergeCuesOptions = {};
  const maxGapMs = parsePositiveInt(flags.maxGapMs);
  const maxChars = parsePositiveInt(flags.maxChars);
  const maxDurationMs = parsePositiveInt(flags.maxDurationMs);
  if (maxGapMs !== undefined) options.maxGapMs = maxGapMs;
  if (maxChars !== undefined) options.maxChars = maxChars;
  if (maxDurationMs !== undefined) options.maxDurationMs = maxDurationMs;
  return options;
};

const fileExists = async (candidate: string): Promise<boolean> =>
  access(candidate)
    .then(() => true)
    .catch(() => false);

export const executeNativeDub = async (flags: DubFlags): Promise<number> => {
  if (flags.videoId === undefined || flags.videoId.trim().length === 0) {
    printCliErrorBlock({
      command: "dub",
      reason: "Missing target. Dub requires --video-id <id>.",
      hints: ["Run `yt2x subtitle` first so full.zh.srt exists."],
      retryCommand: "pnpm yt2x dub --video-id <videoId>",
    });
    return EXIT_INPUT_MISSING;
  }
  const videoId = sanitizeVideoId(flags.videoId);

  const llm = resolveNativeLlm(flags);
  if (!llm.ok) {
    printCliErrorBlock({
      command: "dub",
      subject: videoId,
      reason: llm.reason,
      hints: ["Configure an LLM provider and API key before rewriting the dubbing script."],
      retryCommand: "pnpm yt2x llm ping",
    });
    return llm.exitCode;
  }

  const outRoot = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
  const articleRoot = path.resolve(flags.articleOutDir ?? DEFAULT_ARTICLE_ROOT);
  const dubDir = dubDirFor(articleRoot, videoId);
  const voice = flags.voice ?? DEFAULT_EDGE_TTS_VOICE;

  if (flags.force !== true && (await fileExists(path.join(dubDir, DUB_TIMING_FILE)))) {
    logger.info({ videoId, dubDir }, "dub artifacts already exist, skipping (use --force to redo)");
    return 0;
  }

  let srtPath: string;
  try {
    srtPath = await resolveZhSubtitlePath({ articleRoot, outRoot, videoId });
  } catch (err: unknown) {
    printCliErrorBlock({
      command: "dub",
      subject: videoId,
      reason: err instanceof Error ? err.message : String(err),
      hints: ["Run `yt2x subtitle --video-id <videoId>` to produce full.zh.srt."],
      retryCommand: `pnpm yt2x dub --video-id ${videoId}`,
    });
    return EXIT_INPUT_MISSING;
  }

  const cues = await readDubCues(srtPath);
  const segments = mergeCuesIntoSegments(cues, mergeOptionsFrom(flags));
  if (segments.length === 0) {
    printCliErrorBlock({
      command: "dub",
      subject: videoId,
      reason: `No usable subtitle cues in ${srtPath}.`,
      hints: ["The Chinese subtitle file is empty — re-run the subtitle stage."],
      retryCommand: `pnpm yt2x subtitle --video-id ${videoId}`,
    });
    return EXIT_INPUT_MISSING;
  }

  logger.info(
    { videoId, srtPath, cues: cues.length, segments: segments.length, model: llm.model },
    "yt2x dub: rewriting the dubbing script…",
  );

  try {
    const { script, warnings, rewrittenCount, fallbackCount } = await generateDubScript({
      llm: llm.adapter,
      model: llm.model,
      videoId,
      sourceSubtitle: path.relative(path.dirname(dubDir), srtPath),
      segments,
    });
    for (const warning of warnings) logger.warn({ videoId }, `dub script: ${warning}`);

    const scriptPath = await writeDubScript(dubDir, script);
    logger.info({ videoId, scriptPath, rewrittenCount, fallbackCount }, "dub script written");

    if (flags.scriptOnly === true) return 0;

    const tts = createEdgeTtsAdapter({
      ...(flags.ttsCommand !== undefined ? { command: flags.ttsCommand } : {}),
    });
    logger.info({ videoId, engine: tts.id, voice, lines: script.lines.length }, "yt2x dub: synthesizing…");

    const { report, warnings: synthWarnings } = await synthesizeDubLines({
      tts,
      script,
      voice,
      dubDir,
      ...(flags.ffprobePath !== undefined ? { ffprobePath: flags.ffprobePath } : {}),
      onLineDone: (done, total) => {
        if (done % 20 === 0 || done === total) {
          logger.info({ videoId, done, total }, "yt2x dub: synthesis progress");
        }
      },
    });
    for (const warning of synthWarnings) logger.warn({ videoId }, `dub synthesis: ${warning}`);

    const reportPath = await writeDubTimingReport(dubDir, report);
    // 只记录不阻断：这些数字是 PR3 定阈值的输入，不是本次运行的合格线
    logger.info(
      {
        videoId,
        reportPath,
        lineCount: report.lineCount,
        medianRatio: Number(report.medianRatio.toFixed(3)),
        overflowCount: report.overflowCount,
        totalDriftMs: report.totalDriftMs,
      },
      "yt2x dub: done (timing is recorded, not enforced in this stage)",
    );
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    printCliErrorBlock({
      command: "dub",
      subject: videoId,
      reason: message,
      ...(isTtsError(err) ? { details: `TTS error kind: ${err.kind}` } : {}),
      hints: isTtsError(err)
        ? ["Install edge-tts with `pipx install edge-tts`, then retry."]
        : ["Check the LLM provider configuration and the subtitle artifacts."],
      retryCommand: `pnpm yt2x dub --video-id ${videoId}`,
    });
    return isTtsError(err) ? exitFromTtsKind(err.kind) : 1;
  }
};
