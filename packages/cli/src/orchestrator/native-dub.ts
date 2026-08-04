import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EDGE_TTS_VOICE,
  DEFAULT_OUT_DIR,
  DEFAULT_WATERMARK_SUBTITLER,
  ELEVENLABS_API_KEY_ENV,
  applyDubNegotiation,
  burnBilingualSubtitles,
  createEdgeTtsAdapter,
  createElevenLabsAdapter,
  defaultProcessRunner,
  dubDemucsDirFor,
  dubDirFor,
  dubbedVideoPathFor,
  dubEnSrtPathFor,
  dubReverseSrtPathFor,
  dubZhSrtPathFor,
  evaluateDubBilingualGate,
  extractDubSourceWindow,
  generateDubScript,
  guardDubSourceAgainstHardSubtitles,
  isDemucsError,
  isDubHardSubtitleError,
  muxDubbedVideo,
  probeDemucs,
  readDubWords,
  readDubScript,
  readDubTimingReport,
  readElevenLabsApiKeyFromEnv,
  readElevenLabsVoiceFromEnv,
  remixDubbedAudio,
  resolveDubSourceVideo,
  resolveDubWordsPath,
  resolvePythonWithDemucs,
  resolveWatermarkUploaderId,
  sanitizeVideoId,
  separateDemucs,
  synthesizeDubLines,
  probeAudioDurationMs,
  writeDubGateReport,
  writeDubPlacement,
  writeDubPlan,
  writeDubScript,
  writeDubTimingReport,
} from "@yt2x/adapters-node";
import {
  DEFAULT_STRETCH_MAX_OCCUPANCY,
  PREFERRED_RATE_MIN,
  buildNegotiateInputs,
  evaluateDubGate,
  filterUtterancesByTimeRange,
  formatReverseEnSrt,
  formatReverseSrt,
  formatReverseZhSrt,
  isTtsError,
  planDubNegotiation,
  resolveMaxExtendMs,
  segmentUtterances,
  type DubScript,
  type DubTimingReport,
  type SegmentUtterancesOptions,
  type TtsPort,
} from "@yt2x/core";
import { logger } from "../logger.js";
import { printCliErrorBlock } from "../diagnostics/error-format.js";
import { NATIVE_EXIT, resolveNativeLlm, type NativeLlmCliFlags } from "./native-stage-common.js";

/**
 * `yt2x dub` 编排（PR3 起步，PR4「统一交付」改造）：
 *
 *   Demucs 探测 → 配音稿 → 自然语速 TTS → 时长协商 → 配音门禁（gate.ts）→
 *   分离 BGM → 反向双语 SRT（中/英/双语三份）→ 双语质量门（readyForBurn）→
 *   混音 + 按需冻结帧 → 双语烧录一次完成换音轨 + 烧字幕 → full.zh-dubbed.mp4
 *
 * 两道门都得过才烧（见 docs/DUB-TASK.md「统一交付」）：配音门禁管时长/间隔/丢句/译文
 * 预算占用，双语质量门管字幕布局/字体回退/三份 SRT 一致性/术语保护，两者维度不同、
 * 缺一不可。配音自 PR4 起不再自建烧录——混音与冻结帧仍在这里做，但最终的字幕烧录
 * 统一交给 `burnBilingualSubtitles`（双语字幕交付路径本身也在用的同一个函数），
 * 用它的「替换音轨」参数在同一次 ffmpeg 调用里换音轨 + 烧字幕，不再多编码一次。
 *
 * 引擎默认 edge-tts（调试）；成片用 `--dub-engine elevenlabs`。
 * pipeline `--dub` 默认走 elevenlabs。
 */

const DEFAULT_ARTICLE_ROOT = "files/articles";

export type DubEngineId = "edge-tts" | "elevenlabs";

export type DubFlags = NativeLlmCliFlags & {
  videoId?: string;
  outDir?: string;
  articleOutDir?: string;
  /** 最终视频输出路径；不传则写入默认的 full.zh-dubbed.mp4。 */
  outputPath?: string;
  voice?: string;
  /** TTS 引擎：edge-tts（默认）| elevenlabs。 */
  dubEngine?: string;
  ttsCommand?: string;
  elevenlabsBaseUrl?: string;
  elevenlabsModel?: string;
  ffprobePath?: string;
  ffmpegPath?: string;
  demucsModel?: string;
  pythonPath?: string;
  maxDurationMs?: string;
  minDurationMs?: string;
  scriptOnly?: boolean;
  timingOnly?: boolean;
  skipBurn?: boolean;
  /** 写出 dub-report.json 但不因 hard issue 阻断（调试用）。 */
  skipGate?: boolean;
  force?: boolean;
  /** 只处理源片 [startMs, endMs) 时间窗；不裁文件进 downloads。 */
  startMs?: string;
  endMs?: string;
  /** 原声垫底音量，相对中文配音 1.0（默认 0.2）；0 退回两路混音，不引入静音输入。 */
  originalVoiceVolume?: string;
  /** 反事实试听：覆盖协商阶段的语速下限；不传则使用当前默认值。 */
  preferredRateMin?: string;
  /** 覆盖水印的「字幕：」署名；传空字符串则不写这一行。不传用默认署名。 */
  watermarkSubtitler?: string;
};

const EXIT_INPUT_MISSING = NATIVE_EXIT.NO_INPUT;
/** 门禁硬失败。 */
const EXIT_GATE_BLOCKED = NATIVE_EXIT.PARTIAL_FAILURE;

const exitFromTtsKind = (kind: string): number => {
  if (kind === "UNAVAILABLE" || kind === "BAD_REQUEST") return NATIVE_EXIT.CONFIG_MISSING;
  if (kind === "AUTH") return NATIVE_EXIT.LLM_AUTH;
  if (kind === "QUOTA") return NATIVE_EXIT.LLM_QUOTA;
  if (kind === "NETWORK" || kind === "RATE_LIMIT") return NATIVE_EXIT.LLM_NETWORK;
  return 1;
};

const parseNonNegativeInt = (raw: string | undefined, label: string): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${label}: expected a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
};

const parseDubTimeRange = (
  flags: DubFlags,
): { startMs?: number; endMs?: number } => {
  const startMs = parseNonNegativeInt(flags.startMs, "--start-ms");
  const endMs = parseNonNegativeInt(flags.endMs, "--end-ms");
  if (startMs === undefined && endMs === undefined) return {};
  if (endMs !== undefined && (startMs ?? 0) >= endMs) {
    throw new Error(`Invalid dub time range: --end-ms (${endMs}) must be greater than --start-ms (${startMs ?? 0}).`);
  }
  return {
    ...(startMs !== undefined ? { startMs } : {}),
    ...(endMs !== undefined ? { endMs } : {}),
  };
};

/**
 * 导出给单测直接验证 `--original-voice-volume` 的解析：不传时返回 undefined（下游用
 * remix.ts 的 DEFAULT_ORIGINAL_VOICE_VOLUME 兜底，行为与不传参数前完全一致），传入负数
 * 或非数字即报错。0 是合法值——它触发 remix.ts 的两路混音回退，不在这里特殊处理。
 */
export const parseOriginalVoiceVolume = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `Invalid --original-voice-volume: expected a non-negative number, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
};

/**
 * 导出给单测直接验证 `--preferred-rate-min` 的解析。这个参数只覆盖本次协商，
 * 不改变默认值；这样两版试听成片可以共享同一份脚本、自然语速时长和其余参数，
 * 唯一变量就是反向放慢的语速地板（见 issue #134）。
 */
export const negotiationOptionsFrom = (
  flags: Pick<DubFlags, "preferredRateMin">,
): { preferredRateMin?: number } => {
  if (flags.preferredRateMin === undefined) return {};
  const value = Number(flags.preferredRateMin);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid --preferred-rate-min: expected a positive number, got ${JSON.stringify(flags.preferredRateMin)}`,
    );
  }
  return { preferredRateMin: value };
};

export { DEFAULT_WATERMARK_SUBTITLER };

/**
 * Watermark attribution for the dub burn, resolved the same way the subtitle delivery
 * path resolves it: source channel from `metadata.json`, subtitler from the shared
 * default. `--watermark-subtitler ""` suppresses only the 「字幕：」 line, so a run can
 * credit the channel alone; with no channel either, the overlay is skipped entirely.
 */
export const resolveDubWatermark = async (
  videoDir: string,
  flags: Pick<DubFlags, "watermarkSubtitler">,
): Promise<{ watermarkVideo?: string; watermarkSubtitler?: string }> => {
  const watermarkVideo = await resolveWatermarkUploaderId(videoDir);
  const subtitler = flags.watermarkSubtitler ?? DEFAULT_WATERMARK_SUBTITLER;
  return {
    ...(watermarkVideo !== undefined ? { watermarkVideo } : {}),
    ...(subtitler.trim().length > 0 ? { watermarkSubtitler: subtitler } : {}),
  };
};

/**
 * Resolve the final video path without changing the intermediate artifact layout. A separate
 * output path lets two rate-floor auditions share the cached script, natural-rate timing, and
 * Demucs outputs while keeping both rendered videos for side-by-side listening.
 */
export const resolveDubOutputPath = (
  flags: Pick<DubFlags, "outputPath">,
  input: {
    articleRoot: string;
    videoId: string;
    timeRange: { startMs?: number; endMs?: number };
  },
): string => {
  const requested = flags.outputPath?.trim();
  if (requested !== undefined) {
    if (requested.length === 0) {
      throw new Error("Invalid --output-path: expected a non-empty path");
    }
    const resolved = path.resolve(requested);
    const articleVideoRoot = path.resolve(input.articleRoot, input.videoId, "video");
    const relative = path.relative(articleVideoRoot, resolved);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Invalid --output-path: output must stay under ${articleVideoRoot}; files/downloads is read-only`,
      );
    }
    return resolved;
  }

  const hasTimeRange = input.timeRange.startMs !== undefined || input.timeRange.endMs !== undefined;
  if (hasTimeRange) {
    return path.join(
      dubDirFor(input.articleRoot, input.videoId),
      "work",
      `window-${input.timeRange.startMs ?? 0}-${input.timeRange.endMs ?? "end"}.zh-dubbed.mp4`,
    );
  }
  return dubbedVideoPathFor(input.articleRoot, input.videoId);
};

const auditionManifestPathFor = (outputPath: string): string => `${outputPath}.audition.json`;

const ensureExistingDubAuditionManifest = async (input: {
  outputPath: string;
  videoId: string;
  preferredRateMin?: number;
  flags: Pick<DubFlags, "force" | "skipGate" | "skipBurn">;
}): Promise<void> => {
  const manifestPath = auditionManifestPathFor(input.outputPath);
  if (await fileExists(manifestPath)) return;
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        status: "reused-existing-output",
        videoId: input.videoId,
        outputPath: input.outputPath,
        preferredRateMin: input.preferredRateMin ?? PREFERRED_RATE_MIN,
        stretchMaxOccupancy: DEFAULT_STRETCH_MAX_OCCUPANCY,
        flags: {
          force: input.flags.force === true,
          skipGate: input.flags.skipGate === true,
          skipBurn: input.flags.skipBurn === true,
        },
        gates: null,
        note: "The output already existed, so this invocation did not rerun dubbing or evaluate gates. Use --force to regenerate it.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const parsePositiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/**
 * `--min-duration-ms` 默认值推导。
 *
 * `dubTranslateCharBudget`（core/dub/translate-prompts.ts）把可用时长换算成字符预算：
 * `budget = floor((availableMs - fixedOverheadMs) / msPerChar)`，clamp 到最低 1 字。任何
 * 目标时长不超过固定开销的话语单元，预算都会被 clamp 到 1-2 字——这正是真实全片里
 * 17/149（11.4%，`zh-CN-YunxiNeural` 时代的观测）译文被压成单字的根因（例如
 * "You need to understand things like scope." → 「懂」）。
 *
 * 只把默认值抬到刚好越过固定开销不够：那样预算仍只有 1-2 字，塞不下一个完整分句。
 * 反推需要多少字才够表达完整意思——取约 10 个汉字（如"你需要理解范围这个概念"）作为
 * 「一个简短但完整的分句」的下限。
 *
 * **2026-08-01 随 `zh-CN-YunjianNeural` 重新标定后复核**：`TTS_FIXED_OVERHEAD_MS`
 * 1873→1132、`TTS_MS_PER_CHINESE_CHAR` 114.5→175.2，代入 `1132 + 175.2 × 10 ≈ 2884ms`，
 * 仍取整 3000ms——不变，因为它在新模型下留出的余量反而更大：`floor((3000-1132)/175.2)
 * = 10` 个字（旧模型下 `floor((3000-1873)/114.5) = 9` 个字），3000ms 仍然覆盖「10 个字
 * 的简短完整分句」这条判据，无需调整。低于此时长的话语单元在切分阶段就并入相邻单元，
 * 而不是把必然溢出的预算交给后续的翻译/时长协商去救。
 */
export const DEFAULT_MIN_DURATION_MS = 3_000;

/** 导出给单测直接验证 `--min-duration-ms` / `--max-duration-ms` 的解析与默认值。 */
export const segmentOptionsFrom = (flags: DubFlags): SegmentUtterancesOptions => {
  const options: SegmentUtterancesOptions = {};
  const maxDurationMs = parsePositiveInt(flags.maxDurationMs);
  if (maxDurationMs !== undefined) options.maxDurationMs = maxDurationMs;
  options.minDurationMs = parsePositiveInt(flags.minDurationMs) ?? DEFAULT_MIN_DURATION_MS;
  return options;
};

const fileExists = async (candidate: string): Promise<boolean> =>
  access(candidate)
    .then(() => true)
    .catch(() => false);

/**
 * 导出给 native-pipeline.ts 复用：`pipeline --dub` 需要在 notes/article 之前就校验
 * TTS 凭据是否可用（见下方 resolveDubTts 的导出注释），而引擎解析是凭据校验的前置步骤。
 */
export const resolveDubEngine = (raw: string | undefined): DubEngineId => {
  const value = (raw ?? "edge-tts").trim().toLowerCase();
  if (value === "edge-tts" || value === "edge") return "edge-tts";
  if (value === "elevenlabs" || value === "eleven") return "elevenlabs";
  throw new Error(`Unknown --dub-engine "${raw}". Use edge-tts or elevenlabs.`);
};

export type ResolvedTts =
  | { ok: true; tts: TtsPort; voice: string; engine: DubEngineId }
  | { ok: false; exitCode: number; reason: string };

/**
 * 导出给 native-pipeline.ts 复用：`pipeline --dub` 默认引擎是 elevenlabs，而这里的凭据
 * 校验此前只在 executeNativeDub 内部、script 生成**之后**才跑——pipeline 场景下等于
 * notes+article 的整片 LLM 翻译已经付过费才报 CONFIG_MISSING。构造适配器本身不产生
 * 网络请求，只在这里读环境变量/flags，可以安全地在 notes/article 之前调用一次。
 */
export const resolveDubTts = (flags: DubFlags, engine: DubEngineId): ResolvedTts => {
  if (engine === "edge-tts") {
    return {
      ok: true,
      engine,
      voice: flags.voice ?? DEFAULT_EDGE_TTS_VOICE,
      tts: createEdgeTtsAdapter({
        ...(flags.ttsCommand !== undefined ? { command: flags.ttsCommand } : {}),
      }),
    };
  }

  const apiKey = readElevenLabsApiKeyFromEnv();
  if (apiKey === undefined) {
    return {
      ok: false,
      exitCode: NATIVE_EXIT.CONFIG_MISSING,
      reason: `Missing ElevenLabs API key. Set one of: ${ELEVENLABS_API_KEY_ENV.join(", ")}.`,
    };
  }
  const voice = flags.voice ?? readElevenLabsVoiceFromEnv();
  if (voice === undefined || voice.trim().length === 0) {
    return {
      ok: false,
      exitCode: NATIVE_EXIT.CONFIG_MISSING,
      reason:
        "Missing ElevenLabs voice id. Pass --voice <id> or set ELEVENLABS_VOICE_ID (see https://elevenlabs.io/app/voice-library).",
    };
  }
  return {
    ok: true,
    engine,
    voice,
    tts: createElevenLabsAdapter({
      apiKey,
      ...(flags.elevenlabsBaseUrl !== undefined ? { baseUrl: flags.elevenlabsBaseUrl } : {}),
      ...(flags.elevenlabsModel !== undefined ? { modelId: flags.elevenlabsModel } : {}),
    }),
  };
};

/**
 * 校验磁盘上的 dub-timing.json 是否真的是当前 dub-script.json 合成出来的产物，而非
 * 一次被拒的旧 script 遗留下来的同名文件。dub-timing.json 的 schema 自 PR3 起未变过，
 * 单靠 zod 校验挡不住这种"形状对、内容配错"的复用——两者必须逐行 index 对齐、且
 * charCount 与当前 script 行的文本长度一致，否则 buildNegotiateInputs 会按 index 把
 * 新译文的时间轴配上旧改写稿合成的音频。
 */
const timingMatchesScript = (timing: DubTimingReport, script: DubScript): boolean => {
  if (timing.lineCount !== script.lines.length || timing.lines.length !== script.lines.length) {
    return false;
  }
  const byIndex = new Map(timing.lines.map((line) => [line.index, line]));
  return script.lines.every((scriptLine) => {
    const timingLine = byIndex.get(scriptLine.index);
    return timingLine !== undefined && timingLine.charCount === scriptLine.text.length;
  });
};

export const executeNativeDub = async (flags: DubFlags): Promise<number> => {
  if (flags.videoId === undefined || flags.videoId.trim().length === 0) {
    printCliErrorBlock({
      command: "dub",
      reason: "Missing target. Dub requires --video-id <id>.",
      hints: ["Run `yt2x subtitle transcribe-local <videoId>` first so full.local.en.words.json exists."],
      retryCommand: "pnpm yt2x dub --video-id <videoId>",
    });
    return EXIT_INPUT_MISSING;
  }
  const videoId = sanitizeVideoId(flags.videoId);

  const outRoot = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
  const articleRoot = path.resolve(flags.articleOutDir ?? DEFAULT_ARTICLE_ROOT);
  const dubDir = dubDirFor(articleRoot, videoId);

  let timeRange: { startMs?: number; endMs?: number };
  try {
    timeRange = parseDubTimeRange(flags);
  } catch (err: unknown) {
    printCliErrorBlock({
      command: "dub",
      subject: videoId,
      reason: err instanceof Error ? err.message : String(err),
      hints: ["Use --start-ms / --end-ms with non-negative integers (end > start)."],
      retryCommand: `pnpm yt2x dub --video-id ${videoId} --start-ms 0 --end-ms 90000`,
    });
    return EXIT_INPUT_MISSING;
  }
  let originalVoiceVolume: number | undefined;
  try {
    originalVoiceVolume = parseOriginalVoiceVolume(flags.originalVoiceVolume);
  } catch (err: unknown) {
    printCliErrorBlock({
      command: "dub",
      subject: videoId,
      reason: err instanceof Error ? err.message : String(err),
      hints: ["Use --original-voice-volume with a non-negative number, e.g. 0.2, 0.35, or 0 to drop the original voice."],
      retryCommand: `pnpm yt2x dub --video-id ${videoId} --original-voice-volume 0.2`,
    });
    return EXIT_INPUT_MISSING;
  }
  let negotiationOptions: { preferredRateMin?: number };
  try {
    negotiationOptions = negotiationOptionsFrom(flags);
  } catch (err: unknown) {
    printCliErrorBlock({
      command: "dub",
      subject: videoId,
      reason: err instanceof Error ? err.message : String(err),
      hints: ["Use --preferred-rate-min with a positive number, e.g. 0.85."],
      retryCommand: `pnpm yt2x dub --video-id ${videoId} --preferred-rate-min 0.85`,
    });
    return EXIT_INPUT_MISSING;
  }
  const hasTimeRange = timeRange.startMs !== undefined || timeRange.endMs !== undefined;
  let dubbedPath: string;
  try {
    // 时间窗默认写到 dub/work/；全片试听可通过 --output-path 保留多个成片版本。
    dubbedPath = resolveDubOutputPath(flags, { articleRoot, videoId, timeRange });
  } catch (err: unknown) {
    printCliErrorBlock({
      command: "dub",
      subject: videoId,
      reason: err instanceof Error ? err.message : String(err),
      hints: [
        `Use --output-path with a non-empty file path under ${path.join(articleRoot, videoId, "video")}, or omit it for the default output.`,
      ],
      retryCommand: `pnpm yt2x dub --video-id ${videoId} --output-path ./files/articles/${videoId}/video/rate-085.mp4`,
    });
    return EXIT_INPUT_MISSING;
  }

  if (flags.force !== true && (await fileExists(dubbedPath))) {
    if (flags.outputPath !== undefined) {
      try {
        await ensureExistingDubAuditionManifest({
          outputPath: dubbedPath,
          videoId,
          ...negotiationOptions,
          flags,
        });
      } catch (err: unknown) {
        printCliErrorBlock({
          command: "dub",
          subject: videoId,
          reason: err instanceof Error ? err.message : String(err),
          hints: ["Use a new --output-path, or pass --force to regenerate the audition output."],
          retryCommand: `pnpm yt2x dub --video-id ${videoId} --force --output-path ${dubbedPath}`,
        });
        return 1;
      }
    }
    logger.info({ videoId, dubbedPath }, "dubbed video already exists, skipping (use --force to redo)");
    return 0;
  }

  // 成片路径才需要源视频；--script-only / --timing-only 可以没有 full.mp4
  const needsVideo = flags.scriptOnly !== true && flags.timingOnly !== true;
  let sourceVideo: { videoPath: string; preferred: boolean } | undefined;
  let pythonPath: string | undefined;

  if (needsVideo) {
    try {
      sourceVideo = await resolveDubSourceVideo({ articleRoot, outRoot, videoId });
      logger.info(
        { videoId, videoPath: sourceVideo.videoPath, preferred: sourceVideo.preferred },
        "dub: using source video from downloads",
      );
      if (!sourceVideo.preferred) {
        logger.warn(
          { videoPath: sourceVideo.videoPath },
          "dub: source is not full.mp4 — proceeding with the resolved file",
        );
      }
    } catch (err: unknown) {
      printCliErrorBlock({
        command: "dub",
        subject: videoId,
        reason: err instanceof Error ? err.message : String(err),
        hints: ["Run `yt2x acquire` so video/full.mp4 exists under downloads."],
        retryCommand: `pnpm yt2x dub --video-id ${videoId}`,
      });
      return EXIT_INPUT_MISSING;
    }

    // 硬字幕检测必须先于 Demucs / LLM 改写 / TTS —— 否则会白花钱还产出不可用成片
    try {
      await guardDubSourceAgainstHardSubtitles(sourceVideo.videoPath, defaultProcessRunner);
    } catch (err: unknown) {
      printCliErrorBlock({
        command: "dub",
        subject: videoId,
        reason: err instanceof Error ? err.message : String(err),
        hints: [
          "检测到源片已有中文硬字幕：配音会改时间轴，保留旧硬字幕必然音字错位。",
          "换用 downloads 下未烧录字幕的原始素材后重试。",
          "字幕烧录流程仍可跳过叠烧；只有配音流程会因此拒绝执行。",
        ],
        retryCommand: `pnpm yt2x dub --video-id ${videoId}`,
      });
      return isDubHardSubtitleError(err) ? EXIT_INPUT_MISSING : 1;
    }

    if (timeRange.startMs !== undefined || timeRange.endMs !== undefined) {
      const windowPath = path.join(dubDir, "work", "source-window.mp4");
      try {
        await extractDubSourceWindow({
          videoPath: sourceVideo.videoPath,
          outputPath: windowPath,
          startMs: timeRange.startMs ?? 0,
          ...(timeRange.endMs !== undefined ? { endMs: timeRange.endMs } : {}),
          runner: defaultProcessRunner,
          ...(flags.ffmpegPath !== undefined ? { ffmpegPath: flags.ffmpegPath } : {}),
        });
        sourceVideo = {
          videoPath: windowPath,
          preferred: sourceVideo.preferred,
        };
        logger.info(
          {
            videoId,
            windowPath,
            startMs: timeRange.startMs ?? 0,
            endMs: timeRange.endMs,
          },
          "dub: using temporary source window (not written to downloads)",
        );
      } catch (err: unknown) {
        printCliErrorBlock({
          command: "dub",
          subject: videoId,
          reason: err instanceof Error ? err.message : String(err),
          hints: [
            "Failed to extract the --start-ms/--end-ms window from the downloads original.",
            "Check ffmpeg and the source timestamps.",
          ],
          retryCommand: `pnpm yt2x dub --video-id ${videoId}`,
        });
        return 1;
      }
    }
  }

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

  let wordsPath: string;
  try {
    wordsPath = await resolveDubWordsPath({ outRoot, videoId });
  } catch (err: unknown) {
    printCliErrorBlock({
      command: "dub",
      subject: videoId,
      reason: err instanceof Error ? err.message : String(err),
      hints: ["Run `yt2x subtitle transcribe-local <videoId>` to produce full.local.en.words.json."],
      retryCommand: `pnpm yt2x dub --video-id ${videoId}`,
    });
    return EXIT_INPUT_MISSING;
  }

  if (needsVideo) {
    // Demucs 探测前置于后续计费调用（翻译 LLM / 调速 TTS）和分离本身
    try {
      const autoPythonPath =
        flags.pythonPath === undefined ? await resolvePythonWithDemucs() : undefined;
      pythonPath = await probeDemucs({
        ...(flags.pythonPath !== undefined
          ? { pythonPath: flags.pythonPath }
          : autoPythonPath !== undefined
            ? { pythonPath: autoPythonPath }
            : {}),
      });
    } catch (err: unknown) {
      printCliErrorBlock({
        command: "dub",
        subject: videoId,
        reason: err instanceof Error ? err.message : String(err),
        hints: [
          "Install demucs before dubbing: `pip install demucs` (or set --python-path to a Python that has it).",
          "Demucs is required to keep background audio; dubbing will not silently drop the BGM.",
          "Use --script-only or --timing-only to stop before video work if you only need timing data.",
        ],
        retryCommand: `pnpm yt2x dub --video-id ${videoId}`,
      });
      return NATIVE_EXIT.CONFIG_MISSING;
    }
  }

  try {
    // ── 2. 配音稿（可复用） ──
    // 时间窗冒烟不得复用/覆盖全片缓存，否则 --start-ms/--end-ms 会被静默忽略。
    const reuseFullRunArtifacts = flags.force !== true && !hasTimeRange;
    let script = reuseFullRunArtifacts
      ? await readDubScript(dubDir).catch((err: unknown) => {
          // 缺文件是正常的首次运行；版本不匹配/校验失败则是需要说明的缓存拒绝，
          // 两者都落到"没有可复用缓存"，但后者应该被看见，不能悄悄发生。
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("ENOENT")) {
            logger.warn(
              { videoId, err: message },
              "dub: ignoring cached dub-script.json — regenerating",
            );
          }
          return undefined;
        })
      : undefined;
    // script 是否真的来自磁盘缓存（而非本次重新生成）——决定 dub-timing.json 和逐句音频
    // 能不能复用。旧 dub-timing.json 的 schema 从未随 PR3 变过，单靠版本号/结构校验挡不住
    // 「script 被拒后重新生成、timing 却还是旧链路产物」这种组合：timing 按 index 与新
    // script 配对（buildNegotiateInputs 不校验文本），会把新译文的字幕烧上画面、却混上旧
    // 改写稿合成的人声——参见 docs/DUB-TASK.md 对应记录。
    const scriptFromCache = script !== undefined;
    if (hasTimeRange && flags.force !== true) {
      logger.info(
        { videoId, startMs: timeRange.startMs ?? 0, endMs: timeRange.endMs },
        "dub: time range active — skipping full-run script/timing cache",
      );
    }
    if (script === undefined) {
      const words = await readDubWords(wordsPath);
      const utterances = filterUtterancesByTimeRange(
        segmentUtterances(words, segmentOptionsFrom(flags)),
        timeRange,
      );
      if (utterances.length === 0) {
        printCliErrorBlock({
          command: "dub",
          subject: videoId,
          reason: hasTimeRange
            ? `No usable speech in ${wordsPath} for time range ` +
              `[${timeRange.startMs ?? 0}, ${timeRange.endMs ?? "end"}).`
            : `No usable speech in ${wordsPath}.`,
          hints: hasTimeRange
            ? ["Widen --start-ms/--end-ms, or check that the local transcript covers that window."]
            : ["The local transcript is empty — re-run `yt2x subtitle transcribe-local`."],
          retryCommand: `pnpm yt2x subtitle transcribe-local ${videoId}`,
        });
        return EXIT_INPUT_MISSING;
      }

      logger.info(
        {
          videoId,
          wordsPath,
          words: words.length,
          utterances: utterances.length,
          model: llm.model,
          ...(hasTimeRange
            ? { startMs: timeRange.startMs ?? 0, endMs: timeRange.endMs }
            : {}),
        },
        "yt2x dub: translating the dubbing script…",
      );

      const generated = await generateDubScript({
        llm: llm.adapter,
        model: llm.model,
        videoId,
        sourceWords: path.relative(path.dirname(dubDir), wordsPath),
        utterances,
      });
      for (const warning of generated.warnings) logger.warn({ videoId }, `dub script: ${warning}`);
      script = generated.script;
      // 时间窗产物写到 dub/work/，避免污染全片 dub-script.json
      const scriptDir = hasTimeRange ? path.join(dubDir, "work") : dubDir;
      const scriptPath = await writeDubScript(scriptDir, script);
      logger.info(
        {
          videoId,
          scriptPath,
          translatedCount: generated.translatedCount,
          droppedCount: generated.droppedCount,
        },
        "dub script written",
      );
    } else {
      logger.info({ videoId }, "reusing existing dub-script.json");
    }

    if (flags.scriptOnly === true) return 0;

    let engine: DubEngineId;
    try {
      engine = resolveDubEngine(flags.dubEngine);
    } catch (err: unknown) {
      printCliErrorBlock({
        command: "dub",
        subject: videoId,
        reason: err instanceof Error ? err.message : String(err),
        hints: ["Use --dub-engine edge-tts or --dub-engine elevenlabs."],
        retryCommand: `pnpm yt2x dub --video-id ${videoId}`,
      });
      return NATIVE_EXIT.CONFIG_MISSING;
    }

    const resolvedTts = resolveDubTts(flags, engine);
    if (!resolvedTts.ok) {
      printCliErrorBlock({
        command: "dub",
        subject: videoId,
        reason: resolvedTts.reason,
        hints:
          engine === "elevenlabs"
            ? [
                "Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID, or pass --voice.",
                "For free local debugging use --dub-engine edge-tts.",
              ]
            : ["Install edge-tts with `pipx install edge-tts`."],
        retryCommand: `pnpm yt2x dub --video-id ${videoId} --dub-engine ${engine}`,
      });
      return resolvedTts.exitCode;
    }
    const { tts, voice } = resolvedTts;

    // 时间窗产物（脚本/timing/逐句音频）落在 dub/work，避免污染正片缓存；
    // 协商/混音必须读同一目录，否则 keep 行会指到不存在的 dub/lines。
    const synthDir = hasTimeRange ? path.join(dubDir, "work") : dubDir;

    // ── 3. 自然语速合成 + 时长报告（可复用；换引擎必须重跑） ──
    // scriptFromCache 为 false 时 script 是本次重新生成的（旧缓存被拒或首次运行），
    // 决不能再复用磁盘上的旧 dub-timing.json / dub/lines 音频——它们是配着被拒的旧
    // script 合成的，按 index 硬配对到新 script 上会出现"新字幕、旧人声"的错位。
    let timing =
      reuseFullRunArtifacts && scriptFromCache
        ? await readDubTimingReport(dubDir).catch(() => undefined)
        : undefined;
    if (timing !== undefined && timing.engine !== tts.id) {
      logger.info(
        { videoId, cachedEngine: timing.engine, engine: tts.id },
        "dub-timing.json engine mismatch — re-synthesizing",
      );
      timing = undefined;
    }
    if (timing !== undefined && !timingMatchesScript(timing, script)) {
      logger.warn(
        {
          videoId,
          cachedLineCount: timing.lineCount,
          scriptLineCount: script.lines.length,
        },
        "dub-timing.json does not match dub-script.json (line count/char count mismatch) — ignoring cached timing and re-synthesizing",
      );
      timing = undefined;
    }
    if (timing === undefined) {
      logger.info(
        { videoId, engine: tts.id, voice, lines: script.lines.length },
        "yt2x dub: synthesizing at natural rate…",
      );
      const { report, warnings: synthWarnings } = await synthesizeDubLines({
        tts,
        script,
        voice,
        dubDir: synthDir,
        ...(flags.ffprobePath !== undefined ? { ffprobePath: flags.ffprobePath } : {}),
        ...(flags.ffmpegPath !== undefined ? { ffmpegPath: flags.ffmpegPath } : {}),
        onLineDone: (done, total) => {
          if (done % 20 === 0 || done === total) {
            logger.info({ videoId, done, total }, "yt2x dub: synthesis progress");
          }
        },
      });
      for (const warning of synthWarnings) logger.warn({ videoId }, `dub synthesis: ${warning}`);
      timing = report;
      const reportPath = await writeDubTimingReport(synthDir, timing);
      logger.info(
        {
          videoId,
          reportPath,
          lineCount: timing.lineCount,
          medianRatio: Number(timing.medianRatio.toFixed(3)),
          overflowCount: timing.overflowCount,
          totalDriftMs: timing.totalDriftMs,
        },
        "yt2x dub: timing recorded",
      );
    } else {
      logger.info({ videoId, engine: timing.engine }, "reusing existing dub-timing.json");
    }

    if (flags.timingOnly === true) return 0;

    // ── 4. 时长协商 ──
    const negotiateInputs = buildNegotiateInputs(script.lines, timing.lines);
    let videoDurationMs: number | undefined =
      timeRange.endMs !== undefined
        ? Math.max(1, timeRange.endMs - (timeRange.startMs ?? 0))
        : undefined;
    if (videoDurationMs === undefined && sourceVideo !== undefined) {
      videoDurationMs = await probeAudioDurationMs({
        filePath: sourceVideo.videoPath,
        ...(flags.ffprobePath !== undefined ? { ffprobePath: flags.ffprobePath } : {}),
      });
    }
    const maxExtendMs = resolveMaxExtendMs({
      ...(videoDurationMs !== undefined ? { videoDurationMs } : {}),
    });
    const plan = planDubNegotiation({
      videoId,
      lines: negotiateInputs,
      rateRange: tts.rateRange,
      maxExtendMs,
      ...negotiationOptions,
      ...(videoDurationMs !== undefined ? { videoDurationMs } : {}),
    });
    const planPath = await writeDubPlan(hasTimeRange ? synthDir : dubDir, plan);
    logger.info(
      {
        videoId,
        planPath,
        keep: plan.keepCount,
        speed: plan.speedCount,
        stretch: plan.stretchCount,
        delay: plan.delayCount,
        extendMs: plan.extendMs,
      },
      "yt2x dub: negotiation plan ready",
    );

    const existingAudio = new Map(timing.lines.map((l) => [l.index, l.audioFile]));
    const { report: placement, warnings: applyWarnings } = await applyDubNegotiation({
      plan,
      tts,
      voice,
      dubDir: synthDir,
      existingAudioByIndex: existingAudio,
      ...(flags.ffprobePath !== undefined ? { ffprobePath: flags.ffprobePath } : {}),
      ...(flags.ffmpegPath !== undefined ? { ffmpegPath: flags.ffmpegPath } : {}),
      onLineDone: (done, total) => {
        if (done % 20 === 0 || done === total) {
          logger.info({ videoId, done, total }, "yt2x dub: negotiation apply progress");
        }
      },
    });
    for (const warning of applyWarnings) logger.warn({ videoId }, `dub negotiate: ${warning}`);
    const placementPath = await writeDubPlacement(hasTimeRange ? synthDir : dubDir, placement);
    logger.info(
      {
        videoId,
        placementPath,
        extendMs: placement.extendMs,
        audioEndMs: placement.audioEndMs,
        stretch: placement.stretchCount,
        delay: placement.delayCount,
      },
      "yt2x dub: placement ready",
    );

    // ── 5. 门禁 ──
    const gate = evaluateDubGate({
      videoId,
      timing,
      placement,
      script,
      thresholds: { maxExtendMs },
    });
    const gatePath = await writeDubGateReport(hasTimeRange ? synthDir : dubDir, gate);
    for (const issue of gate.issues) {
      const payload = { videoId, code: issue.code, severity: issue.severity };
      if (issue.severity === "hard") logger.error(payload, `dub gate: ${issue.message}`);
      else logger.warn(payload, `dub gate: ${issue.message}`);
    }
    logger.info(
      {
        videoId,
        gatePath,
        passed: gate.passed,
        blocked: gate.blocked,
        issueCount: gate.issues.length,
        extendMs: gate.metrics.extendMs,
        delayFraction: Number(gate.metrics.delayFraction.toFixed(3)),
      },
      "yt2x dub: gate evaluated",
    );
    if (gate.blocked && flags.skipGate !== true) {
      printCliErrorBlock({
        command: "dub",
        subject: videoId,
        reason: `Dub quality gate blocked delivery (${gate.issues.filter((i) => i.severity === "hard").length} hard issue(s)). See ${gatePath}.`,
        hints: [
          "Inspect dub-report.json / dub-placement.json, then re-run with a shorter script or --force.",
          "Use --skip-gate only for debugging; it will still write the report.",
        ],
        retryCommand: `pnpm yt2x dub --video-id ${videoId} --force`,
      });
      return EXIT_GATE_BLOCKED;
    }

    // ── 6. Demucs 分离 ──
    if (sourceVideo === undefined || pythonPath === undefined) {
      throw new Error("internal error: source video / demucs python missing for remix path");
    }
    // 时间窗冒烟写到 dub/work/demucs，与 dubbedPath / dub-script.json / reverseSrtPath
    // 的规则一致：否则 30 秒窗口的人声分离结果会落进全片共用的 dub/demucs/，下一次
    // 不带 --force 的全片跑会因 skipIfExists 命中这份 30 秒的 no_vocals.wav。
    const demucsDir = hasTimeRange ? path.join(dubDir, "work", "demucs") : dubDemucsDirFor(dubDir);
    logger.info({ videoId, demucsDir }, "yt2x dub: separating background audio with Demucs…");
    const separated = await separateDemucs({
      inputPath: sourceVideo.videoPath,
      outDir: demucsDir,
      pythonPath,
      ...(flags.demucsModel !== undefined ? { model: flags.demucsModel } : {}),
      skipIfExists: flags.force !== true,
    });
    logger.info(
      { videoId, noVocalsPath: separated.noVocalsPath, skipped: separated.skipped },
      "yt2x dub: Demucs ready",
    );

    // ── 7. 反向双语 SRT：中文、英文、双语三份，共用同一批 cue（同一个 index/时间戳空间）──
    const bilingualSrt = formatReverseSrt(placement.lines, script.lines);
    const zhSrt = formatReverseZhSrt(placement.lines, script.lines);
    const enSrt = formatReverseEnSrt(placement.lines, script.lines);
    // 时间窗冒烟写到 dub/work/，与 dubbedPath / dub-script.json 的规则一致，避免用
    // 短窗口的字幕覆盖全片的 video/full.zh-dub*.srt。
    const windowSuffix = `window-${timeRange.startMs ?? 0}-${timeRange.endMs ?? "end"}`;
    const bilingualSrtPath = hasTimeRange
      ? path.join(dubDir, "work", `${windowSuffix}.zh-dub.srt`)
      : dubReverseSrtPathFor(articleRoot, videoId);
    const zhSrtPath = hasTimeRange
      ? path.join(dubDir, "work", `${windowSuffix}.zh-dub.zh.srt`)
      : dubZhSrtPathFor(articleRoot, videoId);
    const enSrtPath = hasTimeRange
      ? path.join(dubDir, "work", `${windowSuffix}.zh-dub.en.srt`)
      : dubEnSrtPathFor(articleRoot, videoId);

    await mkdir(path.dirname(bilingualSrtPath), { recursive: true });
    const writeSrt = async (filePath: string, content: string): Promise<void> =>
      writeFile(filePath, content.endsWith("\n") || content.length === 0 ? content : `${content}\n`, "utf8");
    await Promise.all([
      writeSrt(bilingualSrtPath, bilingualSrt),
      writeSrt(zhSrtPath, zhSrt),
      writeSrt(enSrtPath, enSrt),
    ]);

    // ── 8. 双语质量门：与第 5 步的配音门禁相互独立，管字幕布局/字体回退/三份 SRT
    // 一致性/术语保护（见 docs/DUB-TASK.md「统一交付」）。两个门都得过才烧。 ──
    const bilingualGate = await evaluateDubBilingualGate({
      bilingualSrt,
      zhSrt,
      enSrt,
      videoWidth: 1280,
      videoHeight: 720,
      runner: defaultProcessRunner,
      // 每个话语单元的实测终点，供术语保护校验按话语单元分组比对（见 bilingual-gate.ts）。
      utteranceBoundariesMs: placement.lines.map((line) => line.endMs),
    });
    for (const issue of bilingualGate.issues) {
      logger.warn(
        { videoId, code: issue.code, severity: issue.severity },
        `dub bilingual gate: ${issue.message}`,
      );
    }
    logger.info(
      {
        videoId,
        readyForBurn: bilingualGate.readyForBurn,
        issueCount: bilingualGate.issues.length,
        issueCodes: bilingualGate.issues.map((issue) => issue.code),
      },
      "yt2x dub: bilingual delivery gate evaluated",
    );
    if (!bilingualGate.readyForBurn && flags.skipGate !== true) {
      printCliErrorBlock({
        command: "dub",
        subject: videoId,
        reason: `Bilingual subtitle quality gate blocked delivery (${bilingualGate.issues.length} issue(s)). See the "dub bilingual gate" log lines above.`,
        hints: [
          "字幕布局 / 字体回退 / 三份 SRT 一致性 / 术语保护未通过，检查上方 dub bilingual gate 日志。",
          "Use --skip-gate only for debugging; it does not write a separate report file.",
        ],
        retryCommand: `pnpm yt2x dub --video-id ${videoId} --force`,
      });
      return EXIT_GATE_BLOCKED;
    }

    const auditionManifestPath =
      flags.outputPath === undefined ? undefined : auditionManifestPathFor(dubbedPath);
    const writeDubAuditionManifest = async (render: {
      mode: "bilingual-burn" | "audio-only";
      burned?: boolean;
      skipped?: boolean;
    }): Promise<string | undefined> => {
      if (auditionManifestPath === undefined) return undefined;
      await mkdir(path.dirname(auditionManifestPath), { recursive: true });
      await writeFile(
        auditionManifestPath,
        `${JSON.stringify(
          {
            version: 1,
            videoId,
            outputPath: dubbedPath,
            preferredRateMin: negotiationOptions.preferredRateMin ?? PREFERRED_RATE_MIN,
            stretchMaxOccupancy: DEFAULT_STRETCH_MAX_OCCUPANCY,
            timeRange,
            flags: {
              force: flags.force === true,
              skipGate: flags.skipGate === true,
              skipBurn: flags.skipBurn === true,
            },
            sharedArtifacts: {
              script: path.join(synthDir, "dub-script.json"),
              timing: path.join(synthDir, "dub-timing.json"),
            },
            render,
            subtitleArtifacts: {
              bilingual: bilingualSrtPath,
              zh: zhSrtPath,
              en: enSrtPath,
            },
            plan: {
              keepCount: plan.keepCount,
              speedCount: plan.speedCount,
              stretchCount: plan.stretchCount,
              delayCount: plan.delayCount,
              extendMs: plan.extendMs,
            },
            placement: {
              audioEndMs: placement.audioEndMs,
              stretchCount: placement.stretchCount,
              delayCount: placement.delayCount,
              extendMs: placement.extendMs,
            },
            gates: {
              dub: {
                passed: gate.passed,
                blocked: gate.blocked,
                issues: gate.issues.map((issue) => ({
                  code: issue.code,
                  severity: issue.severity,
                })),
              },
              bilingual: {
                readyForBurn: bilingualGate.readyForBurn,
                issues: bilingualGate.issues.map((issue) => ({
                  code: issue.code,
                  severity: issue.severity,
                })),
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return auditionManifestPath;
    };

    // ── 9. 混音 + 按需冻结帧：交出中文音轨与（必要时）冻结延长后的画面，不再自建烧录 ──
    logger.info({ videoId, dubbedPath }, "yt2x dub: mixing the Chinese voice track…");
    const remix = await remixDubbedAudio({
      videoPath: sourceVideo.videoPath,
      noVocalsPath: separated.noVocalsPath,
      // 原声压低垫在成片里，不是整条替换掉——观众仍能听见讲者本人的语气。
      vocalsPath: separated.vocalsPath,
      placedLines: placement.lines,
      dubDir: synthDir,
      extendMs: placement.extendMs,
      ...(originalVoiceVolume !== undefined ? { originalVoiceVolume } : {}),
      ...(flags.ffmpegPath !== undefined ? { ffmpegPath: flags.ffmpegPath } : {}),
      ...(flags.ffprobePath !== undefined ? { ffprobePath: flags.ffprobePath } : {}),
    });

    if (flags.skipBurn === true) {
      // 调试用途：只换音轨，不烧字幕。冻结帧分支下 videoForBurnPath 已经是带正确
      // 音轨的完整成片；非冻结帧分支下还需要一次单独的 mux 才能落地最终文件。
      if (remix.replaceAudioPath !== undefined) {
        await muxDubbedVideo({
          videoPath: remix.videoForBurnPath,
          audioPath: remix.replaceAudioPath,
          outputPath: dubbedPath,
          videoPadMs: 0,
          outputDurationMs: remix.outputDurationMs,
          runner: defaultProcessRunner,
          ffmpegPath: flags.ffmpegPath ?? "ffmpeg",
          ...(flags.ffprobePath !== undefined ? { ffprobePath: flags.ffprobePath } : {}),
        });
      } else {
        await mkdir(path.dirname(dubbedPath), { recursive: true });
        await muxDubbedVideo({
          videoPath: remix.videoForBurnPath,
          audioPath: remix.mixedAudioPath,
          outputPath: dubbedPath,
          videoPadMs: 0,
          outputDurationMs: remix.outputDurationMs,
          runner: defaultProcessRunner,
          ffmpegPath: flags.ffmpegPath ?? "ffmpeg",
          ...(flags.ffprobePath !== undefined ? { ffprobePath: flags.ffprobePath } : {}),
        });
      }
      const manifestPath = await writeDubAuditionManifest({ mode: "audio-only" });
      if (manifestPath !== undefined) {
        logger.info({ videoId, manifestPath }, "yt2x dub: audition manifest written");
      }
      logger.info(
        { videoId, outputPath: dubbedPath, extendMs: remix.extendMs },
        "yt2x dub: done (--skip-burn, audio replaced only)",
      );
      return 0;
    }

    // ── 10. 双语烧录：同一次 ffmpeg 调用换音轨 + 烧字幕，只编码一次 ──
    logger.info({ videoId, dubbedPath }, "yt2x dub: burning bilingual subtitles…");
    const burn = await burnBilingualSubtitles({
      srtPath: bilingualSrtPath,
      enSrtPath,
      zhSrtPath,
      videoPath: remix.videoForBurnPath,
      outputPath: dubbedPath,
      runner: defaultProcessRunner,
      force: flags.force === true,
      ...(await resolveDubWatermark(path.join(outRoot, videoId), flags)),
      ...(remix.replaceAudioPath !== undefined ? { replaceAudioPath: remix.replaceAudioPath } : {}),
    });
    for (const warning of burn.warnings) logger.warn({ videoId }, `dub burn: ${warning}`);
    const manifestPath = await writeDubAuditionManifest({
      mode: "bilingual-burn",
      burned: burn.burned,
      skipped: burn.skipped,
    });
    if (manifestPath !== undefined) {
      logger.info({ videoId, manifestPath }, "yt2x dub: audition manifest written");
    }

    logger.info(
      {
        videoId,
        outputPath: dubbedPath,
        burned: burn.burned,
        skipped: burn.skipped,
        extendMs: remix.extendMs,
      },
      "yt2x dub: done",
    );
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    printCliErrorBlock({
      command: "dub",
      subject: videoId,
      reason: message,
      ...(isTtsError(err) ? { details: `TTS error kind: ${err.kind}` } : {}),
      ...(isDemucsError(err) ? { details: `Demucs error kind: ${err.kind}` } : {}),
      hints: isDemucsError(err)
        ? ["Install demucs with `pip install demucs`, then retry."]
        : isTtsError(err)
          ? ["Install edge-tts with `pipx install edge-tts`, then retry."]
          : ["Check the LLM provider configuration and the source video / subtitle artifacts."],
      retryCommand: `pnpm yt2x dub --video-id ${videoId}`,
    });
    if (isDemucsError(err)) return NATIVE_EXIT.CONFIG_MISSING;
    return isTtsError(err) ? exitFromTtsKind(err.kind) : 1;
  }
};
