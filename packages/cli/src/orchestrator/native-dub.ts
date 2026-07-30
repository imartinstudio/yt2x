import { access } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EDGE_TTS_VOICE,
  DEFAULT_OUT_DIR,
  ELEVENLABS_API_KEY_ENV,
  applyDubNegotiation,
  createEdgeTtsAdapter,
  createElevenLabsAdapter,
  dubDemucsDirFor,
  dubDirFor,
  dubbedVideoPathFor,
  dubReverseSrtPathFor,
  generateDubScript,
  isDemucsError,
  probeDemucs,
  readDubCues,
  readDubScript,
  readDubTimingReport,
  readElevenLabsApiKeyFromEnv,
  readElevenLabsVoiceFromEnv,
  remixDubbedVideo,
  resolveDubSourceVideo,
  resolveZhSubtitlePath,
  sanitizeVideoId,
  separateDemucs,
  synthesizeDubLines,
  writeDubGateReport,
  writeDubPlacement,
  writeDubPlan,
  writeDubScript,
  writeDubTimingReport,
} from "@yt2x/adapters-node";
import {
  buildNegotiateInputs,
  evaluateDubGate,
  formatReverseSrt,
  isTtsError,
  mergeCuesIntoSegments,
  planDubNegotiation,
  type MergeCuesOptions,
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
  maxGapMs?: string;
  maxChars?: string;
  maxDurationMs?: string;
  scriptOnly?: boolean;
  timingOnly?: boolean;
  skipBurn?: boolean;
  /** 写出 dub-report.json 但不因 hard issue 阻断（调试用）。 */
  skipGate?: boolean;
  force?: boolean;
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

const resolveDubEngine = (raw: string | undefined): DubEngineId => {
  const value = (raw ?? "edge-tts").trim().toLowerCase();
  if (value === "edge-tts" || value === "edge") return "edge-tts";
  if (value === "elevenlabs" || value === "eleven") return "elevenlabs";
  throw new Error(`Unknown --dub-engine "${raw}". Use edge-tts or elevenlabs.`);
};

type ResolvedTts =
  | { ok: true; tts: TtsPort; voice: string; engine: DubEngineId }
  | { ok: false; exitCode: number; reason: string };

const resolveDubTts = (flags: DubFlags, engine: DubEngineId): ResolvedTts => {
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

  const outRoot = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
  const articleRoot = path.resolve(flags.articleOutDir ?? DEFAULT_ARTICLE_ROOT);
  const dubDir = dubDirFor(articleRoot, videoId);
  const dubbedPath = dubbedVideoPathFor(articleRoot, videoId);

  if (flags.force !== true && (await fileExists(dubbedPath))) {
    logger.info({ videoId, dubbedPath }, "dubbed video already exists, skipping (use --force to redo)");
    return 0;
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

  // 成片路径才需要源视频；--script-only / --timing-only 可以没有 full.mp4
  const needsVideo = flags.scriptOnly !== true && flags.timingOnly !== true;
  let sourceVideo: { videoPath: string; preferred: boolean } | undefined;
  let pythonPath: string | undefined;

  if (needsVideo) {
    // Demucs 探测必须前置于后续计费调用（改短 LLM / 调速 TTS）和分离本身
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

    try {
      sourceVideo = await resolveDubSourceVideo({ articleRoot, outRoot, videoId });
      if (!sourceVideo.preferred) {
        logger.warn(
          { videoId, videoPath: sourceVideo.videoPath },
          "dub: source is not full.mp4 — proceeding with the resolved file",
        );
      }
    } catch (err: unknown) {
      printCliErrorBlock({
        command: "dub",
        subject: videoId,
        reason: err instanceof Error ? err.message : String(err),
        hints: ["Run `yt2x acquire` so video/full.mp4 exists."],
        retryCommand: `pnpm yt2x dub --video-id ${videoId}`,
      });
      return EXIT_INPUT_MISSING;
    }
  }

  try {
    // ── 2. 配音稿（可复用） ──
    let script = flags.force === true ? undefined : await readDubScript(dubDir).catch(() => undefined);
    if (script === undefined) {
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

      const generated = await generateDubScript({
        llm: llm.adapter,
        model: llm.model,
        videoId,
        sourceSubtitle: path.relative(path.dirname(dubDir), srtPath),
        segments,
      });
      for (const warning of generated.warnings) logger.warn({ videoId }, `dub script: ${warning}`);
      script = generated.script;
      const scriptPath = await writeDubScript(dubDir, script);
      logger.info(
        {
          videoId,
          scriptPath,
          rewrittenCount: generated.rewrittenCount,
          fallbackCount: generated.fallbackCount,
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

    // ── 3. 自然语速合成 + 时长报告（可复用；换引擎必须重跑） ──
    let timing =
      flags.force === true ? undefined : await readDubTimingReport(dubDir).catch(() => undefined);
    if (timing !== undefined && timing.engine !== tts.id) {
      logger.info(
        { videoId, cachedEngine: timing.engine, engine: tts.id },
        "dub-timing.json engine mismatch — re-synthesizing",
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
        dubDir,
        ...(flags.ffprobePath !== undefined ? { ffprobePath: flags.ffprobePath } : {}),
        onLineDone: (done, total) => {
          if (done % 20 === 0 || done === total) {
            logger.info({ videoId, done, total }, "yt2x dub: synthesis progress");
          }
        },
      });
      for (const warning of synthWarnings) logger.warn({ videoId }, `dub synthesis: ${warning}`);
      timing = report;
      const reportPath = await writeDubTimingReport(dubDir, timing);
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
    const plan = planDubNegotiation({
      videoId,
      lines: negotiateInputs,
      rateRange: tts.rateRange,
    });
    const planPath = await writeDubPlan(dubDir, plan);
    logger.info(
      {
        videoId,
        planPath,
        keep: plan.keepCount,
        speed: plan.speedCount,
        shorten: plan.shortenCount,
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
      dubDir,
      existingAudioByIndex: existingAudio,
      llm: llm.adapter,
      model: llm.model,
      ...(flags.ffprobePath !== undefined ? { ffprobePath: flags.ffprobePath } : {}),
      onLineDone: (done, total) => {
        if (done % 20 === 0 || done === total) {
          logger.info({ videoId, done, total }, "yt2x dub: negotiation apply progress");
        }
      },
    });
    for (const warning of applyWarnings) logger.warn({ videoId }, `dub negotiate: ${warning}`);
    const placementPath = await writeDubPlacement(dubDir, placement);
    logger.info(
      {
        videoId,
        placementPath,
        extendMs: placement.extendMs,
        audioEndMs: placement.audioEndMs,
        shorten: placement.shortenCount,
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
    });
    const gatePath = await writeDubGateReport(dubDir, gate);
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
      dubDir,
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
