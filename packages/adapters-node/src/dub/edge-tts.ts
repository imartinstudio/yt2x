import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TtsError,
  clampRate,
  type TtsErrorContext,
  type TtsPort,
  type TtsRateRange,
  type TtsRequest,
  type TtsResult,
} from "@yt2x/core";
import { defaultProcessRunner, isProcessError, type ProcessRunner } from "../process/index.js";
import { parseEdgeTtsSubtitles } from "./edge-tts-subtitles.js";

/**
 * edge-tts 适配器。
 *
 * edge-tts 是一个本地 CLI（微软 Edge 朗读服务的非官方客户端），没有 HTTP SDK，
 * 只能把音频写到文件再读回来：
 *
 *   edge-tts -t "文本" -v zh-CN-YunxiNeural --rate=+10% \
 *     --write-media out.mp3 --write-subtitles out.vtt
 *
 * `--write-subtitles` 给出短语级时间戳；第一条 cue 起点即前置 padding。
 * 免费、不计费，所以调试期用它跑真实时长分布；成片阶段再换 ElevenLabs。
 */

export const EDGE_TTS_ENGINE_ID = "edge-tts";

/** edge-tts 的 `--rate` 理论上无上限，但超出这个区间音质会崩，按可用范围声明。 */
export const EDGE_TTS_RATE_RANGE: TtsRateRange = { min: 0.5, max: 2.0 };

export const DEFAULT_EDGE_TTS_VOICE = "zh-CN-YunxiNeural";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 倍率 → edge-tts 的百分比字符串。1.0 → "+0%"，1.15 → "+15%"，0.9 → "-10%"。
 * 符号必须显式给出，edge-tts 不接受裸数字。
 */
export const formatEdgeTtsRate = (rate: number): string => {
  const percent = Math.round((rate - 1) * 100);
  return `${percent < 0 ? "-" : "+"}${Math.abs(percent)}%`;
};

export type EdgeTtsAdapterOptions = {
  runner?: ProcessRunner;
  /** 可执行文件名或绝对路径，默认 "edge-tts"。 */
  command?: string;
  timeoutMs?: number;
  /** 临时音频目录的父目录，默认系统 tmp。 */
  tmpDir?: string;
};

const errorContext = (voice?: string, retriable = false): TtsErrorContext => ({
  engine: EDGE_TTS_ENGINE_ID,
  ...(voice !== undefined ? { voice } : {}),
  retriable,
});

/**
 * 把 ProcessError 翻译成 TtsError。
 *
 * NOT_FOUND / SPAWN_FAILED 一定是 UNAVAILABLE——本地没装 edge-tts。这里必须硬失败，
 * 不能静默降级成"跳过这一句"：配音稿缺行会让 PR2 的对齐直接错位，而且时长分布
 * 会少掉最长的那些句子（合成越容易失败的往往越长），阈值就是错的。
 */
const toTtsError = (err: unknown, voice: string): TtsError => {
  if (isProcessError(err)) {
    if (err.kind === "NOT_FOUND" || err.kind === "SPAWN_FAILED") {
      return new TtsError(
        "UNAVAILABLE",
        'edge-tts is not installed or not on PATH. Install it with `pipx install edge-tts` (or `pip install edge-tts`).',
        errorContext(voice),
        { cause: err },
      );
    }
    if (err.kind === "TIMEOUT") {
      return new TtsError(
        "NETWORK",
        "edge-tts timed out. The Edge speech endpoint is remote — check connectivity and retry.",
        errorContext(voice, true),
        { cause: err },
      );
    }
    if (err.kind === "KILLED") {
      return new TtsError("UNKNOWN", "edge-tts was cancelled.", errorContext(voice), {
        cause: err,
      });
    }
    const stderr = err.context.stderrExcerpt ?? "";
    if (/no audio was received/iu.test(stderr)) {
      return new TtsError(
        "BAD_RESPONSE",
        "edge-tts returned no audio. The voice may be unavailable or the text unsupported.",
        errorContext(voice),
        { cause: err },
      );
    }
    if (/invalid voice|not a valid voice/iu.test(stderr)) {
      return new TtsError(
        "BAD_REQUEST",
        `edge-tts rejected the voice "${voice}". Run \`edge-tts --list-voices\` to see valid ids.`,
        errorContext(voice),
        { cause: err },
      );
    }
    return new TtsError("UNKNOWN", "edge-tts failed.", errorContext(voice), { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new TtsError("UNKNOWN", `edge-tts failed: ${message}`, errorContext(voice), {
    cause: err,
  });
};

export const createEdgeTtsAdapter = (options: EdgeTtsAdapterOptions = {}): TtsPort => {
  const runner = options.runner ?? defaultProcessRunner;
  const command = options.command ?? "edge-tts";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const synthesize = async (req: TtsRequest): Promise<TtsResult> => {
    const text = req.text.trim();
    if (text.length === 0) {
      throw new TtsError("BAD_REQUEST", "TTS text is empty.", errorContext(req.voice));
    }
    if (req.voice.trim().length === 0) {
      throw new TtsError("BAD_REQUEST", "TTS voice is empty.", errorContext());
    }
    const format = req.format ?? "mp3";
    if (format !== "mp3") {
      throw new TtsError(
        "BAD_REQUEST",
        `edge-tts only writes mp3, "${format}" was requested. Convert downstream with ffmpeg.`,
        errorContext(req.voice),
      );
    }

    const rate = clampRate(req.rate, EDGE_TTS_RATE_RANGE);
    const workDir = await mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), "yt2x-edge-tts-"));
    const outPath = path.join(workDir, "line.mp3");
    const subtitlesPath = path.join(workDir, "line.vtt");
    try {
      await runner.run({
        command,
        args: [
          "-t",
          text,
          "-v",
          req.voice,
          `--rate=${formatEdgeTtsRate(rate)}`,
          "--write-media",
          outPath,
          "--write-subtitles",
          subtitlesPath,
        ],
        timeoutMs,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });

      let audio: Uint8Array;
      try {
        audio = new Uint8Array(await readFile(outPath));
      } catch (err: unknown) {
        throw new TtsError(
          "BAD_RESPONSE",
          "edge-tts exited successfully but wrote no audio file.",
          errorContext(req.voice),
          { cause: err },
        );
      }
      if (audio.byteLength === 0) {
        throw new TtsError(
          "BAD_RESPONSE",
          "edge-tts wrote a zero-byte audio file.",
          errorContext(req.voice),
        );
      }

      let subtitlesRaw: string;
      try {
        subtitlesRaw = await readFile(subtitlesPath, "utf8");
      } catch (err: unknown) {
        throw new TtsError(
          "BAD_RESPONSE",
          "edge-tts exited successfully but wrote no subtitles file. Timing requires --write-subtitles.",
          errorContext(req.voice),
          { cause: err },
        );
      }

      let speechTiming: TtsResult["speechTiming"];
      try {
        speechTiming = parseEdgeTtsSubtitles(subtitlesRaw);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new TtsError(
          "BAD_RESPONSE",
          `edge-tts subtitles were unusable: ${detail}`,
          errorContext(req.voice),
          { cause: err },
        );
      }

      return {
        audio,
        format: "mp3",
        voice: req.voice,
        rate,
        speechTiming,
        durationMs: speechTiming.speechDurationMs,
      };
    } catch (err: unknown) {
      if (err instanceof TtsError) throw err;
      throw toTtsError(err, req.voice);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { id: EDGE_TTS_ENGINE_ID, rateRange: EDGE_TTS_RATE_RANGE, synthesize };
};
