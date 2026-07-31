import { access } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EDGE_TTS_VOICE,
  DEFAULT_OUT_DIR,
  ELEVENLABS_API_KEY_ENV,
  applyDubNegotiation,
  createEdgeTtsAdapter,
  createElevenLabsAdapter,
  defaultProcessRunner,
  dubDemucsDirFor,
  dubDirFor,
  dubbedVideoPathFor,
  dubReverseSrtPathFor,
  extractDubSourceWindow,
  generateDubScript,
  guardDubSourceAgainstHardSubtitles,
  isDemucsError,
  isDubHardSubtitleError,
  probeDemucs,
  readDubWords,
  readDubScript,
  readDubTimingReport,
  readElevenLabsApiKeyFromEnv,
  readElevenLabsVoiceFromEnv,
  remixDubbedVideo,
  resolveDubSourceVideo,
  resolveDubWordsPath,
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
  buildNegotiateInputs,
  evaluateDubGate,
  filterUtterancesByTimeRange,
  formatReverseSrt,
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
 * `yt2x dub` 编排（PR3）：
 *
 *   Demucs 探测 → 配音稿 → 自然语速 TTS → 时长协商 → 门禁 → 分离 BGM →
 *   反向 SRT → 混音 + 可选重烧 → full.zh-dubbed.mp4
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
  scriptOnly?: boolean;
  timingOnly?: boolean;
  skipBurn?: boolean;
  /** 写出 dub-report.json 但不因 hard issue 阻断（调试用）。 */
  skipGate?: boolean;
  force?: boolean;
  /** 只处理源片 [startMs, endMs) 时间窗；不裁文件进 downloads。 */
  startMs?: string;
  endMs?: string;
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

const parsePositiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const segmentOptionsFrom = (flags: DubFlags): SegmentUtterancesOptions => {
  const options: SegmentUtterancesOptions = {};
  const maxDurationMs = parsePositiveInt(flags.maxDurationMs);
  if (maxDurationMs !== undefined) options.maxDurationMs = maxDurationMs;
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
  const hasTimeRange = timeRange.startMs !== undefined || timeRange.endMs !== undefined;
  // 时间窗冒烟写到 dub/work/，避免覆盖全片 full.zh-dubbed.mp4 / 复用全片缓存。
  const dubbedPath = hasTimeRange
    ? path.join(
        dubDir,
        "work",
        `window-${timeRange.startMs ?? 0}-${timeRange.endMs ?? "end"}.zh-dubbed.mp4`,
      )
    : dubbedVideoPathFor(articleRoot, videoId);

  if (flags.force !== true && (await fileExists(dubbedPath))) {
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
      pythonPath = await probeDemucs({
        ...(flags.pythonPath !== undefined ? { pythonPath: flags.pythonPath } : {}),
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
      ...(videoDurationMs !== undefined ? { videoDurationMs } : {}),
    });
    const planPath = await writeDubPlan(hasTimeRange ? synthDir : dubDir, plan);
    logger.info(
      {
        videoId,
        planPath,
        keep: plan.keepCount,
        speed: plan.speedCount,
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
    const demucsDir = dubDemucsDirFor(dubDir);
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

    // ── 7. 反向 SRT + 混音重烧 ──
    const reverseSrt = formatReverseSrt(placement.lines);
    const reverseSrtPath = dubReverseSrtPathFor(articleRoot, videoId);
    logger.info({ videoId, dubbedPath }, "yt2x dub: remixing and muxing…");
    const remix = await remixDubbedVideo({
      videoPath: sourceVideo.videoPath,
      noVocalsPath: separated.noVocalsPath,
      placedLines: placement.lines,
      dubDir: synthDir,
      reverseSrt,
      reverseSrtPath,
      outputPath: dubbedPath,
      extendMs: placement.extendMs,
      ...(flags.ffmpegPath !== undefined ? { ffmpegPath: flags.ffmpegPath } : {}),
      ...(flags.ffprobePath !== undefined ? { ffprobePath: flags.ffprobePath } : {}),
      ...(flags.skipBurn === true ? { skipBurn: true } : {}),
    });

    logger.info(
      {
        videoId,
        outputPath: remix.outputPath,
        burned: remix.burned,
        skippedBurnReason: remix.skippedBurnReason,
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
