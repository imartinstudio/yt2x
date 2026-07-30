import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmPort } from "@yt2x/core";
import type { ProcessRunner } from "../process/index.js";
import { buildBilingualAss, mergeBilingualSrt } from "./bilingual-subtitles.js";
import {
  burnBilingualSubtitles,
  measureBilingualSubtitleLayout,
} from "./burn-bilingual-subtitles.js";
import type { BurnProgressCallback } from "./burn-subtitles.js";
import { burnZhSubtitlesForVideo } from "./burn-zh-subtitles-for-video.js";
import { resolvePythonWithFasterWhisper, resolvePythonWithTorchaudio } from "./resolve-python.js";
import { translateSrt } from "./srt-translator.js";
import {
  auditSubtitleArtifacts,
  isSubtitleAuditReadyForDelivery,
  subtitleAuditAdvisoryIssues,
  type SubtitleAuditIssue,
  type SubtitleAuditResult,
} from "./audit-subtitles.js";
import {
  projectSemanticBilingualSubtitles,
  SemanticProjectionError,
  type SemanticBilingualProjection,
  type SubtitleLayoutMeasurement,
  type WordTiming,
} from "./semantic-bilingual-subtitles.js";

const FORCED_ALIGN_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "src", "acquire", "forced-align.py",
);

const TRANSCRIBE_LOCAL_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "src", "acquire", "transcribe-local.py",
);

export type SubtitleSourceMode = "auto" | "youtube" | "transcribe" | "local" | "file";

/** 本地语音识别扩展点。首版通过外部命令配置（如 YT2X_TRANSCRIBE_COMMAND）。 */
export type TranscriptionRunner = {
  transcribe(opts: {
    videoPath: string;
    outputPath: string;
    language: string;
    signal?: AbortSignal;
  }): Promise<void>;
};
export type SubtitleSourceMethod =
  | "youtube_subtitles"
  | "youtube_auto_subtitles"
  | "local_transcription"
  | "file";

export type SubtitleManifest = {
  version: 1 | 2;
  source_video: string;
  source_language: string;
  target_language: string;
  source_method?: SubtitleSourceMethod;
  source_subtitle?: string;
  target_subtitle?: string;
  burned_video?: string;
  translation_method?: "llm" | "manual" | "external_command";
  /** v2: bilingual SRT asset path (relative to video dir) */
  bilingual_subtitle?: string;
  /** v2: bilingual ASS asset path (relative to video dir) */
  bilingual_ass?: string;
  /** v2: subtitle burn visual style identifier (only written when bilingual is active) */
  burn_style?: "zh-default" | "bilingual-explainer-v1";
  warnings: string[];
};

export type PrepareSourceSubtitleOptions = {
  videoDir: string;
  sourceLang: string;
  targetLang: string;
  source: SubtitleSourceMode;
  /** Prefer the requested source language over an already-translated target track. */
  preferSourceLanguage?: boolean;
  file?: string;
  runner?: ProcessRunner;
  signal?: AbortSignal;
};

export type PrepareSourceSubtitleResult = {
  manifest: SubtitleManifest;
  sourceSubtitle?: string;
};

type RawCue = {
  index: number;
  start: string;
  end: string;
  text: string[];
};

const TIMING_RE =
  /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})/u;

const subtitleManifestPath = (videoDir: string): string =>
  path.join(videoDir, "video", "subtitle-manifest.json");

const sourceSubtitlePath = (videoDir: string): string =>
  path.join(videoDir, "video", "full.en.srt");

const relativeVideoPath = (fullPath: string): string => `video/${path.basename(fullPath)}`;

const normalizeSrtTimestamp = (value: string): string => {
  const normalized = value.replace(".", ",");
  const parts = normalized.split(":");
  const withHours = parts.length === 2 ? ["00", ...parts] : parts;
  const [hours = "00", minutes = "00", seconds = "00,000"] = withHours;
  const [whole = "00", millis = "000"] = seconds.split(",");
  return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}:${whole.padStart(2, "0")},${millis.padEnd(3, "0").slice(0, 3)}`;
};

export const parseSubtitleBlocks = (raw: string): RawCue[] => {
  const cues: RawCue[] = [];
  let currentStart = "";
  let currentEnd = "";
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentStart.length > 0 && currentLines.length > 0) {
      cues.push({
        index: cues.length + 1,
        start: currentStart,
        end: currentEnd,
        text: currentLines.map((line) => line.trim()).filter((line) => line.length > 0),
      });
    }
    currentStart = "";
    currentEnd = "";
    currentLines = [];
  };

  for (const rawLine of raw.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.toUpperCase() === "WEBVTT" || line.toUpperCase() === "VTT") {
      continue;
    }
    if (/^\d+$/u.test(line)) {
      continue;
    }
    if (
      line.startsWith("NOTE") ||
      line.startsWith("STYLE") ||
      line.startsWith("REGION") ||
      line.startsWith("Kind:") ||
      line.startsWith("Language:")
    ) {
      continue;
    }
    const timing = TIMING_RE.exec(line);
    if (timing !== null) {
      flush();
      currentStart = normalizeSrtTimestamp(timing[1]!);
      currentEnd = normalizeSrtTimestamp(timing[2]!);
      continue;
    }
    if (currentStart.length > 0) {
      currentLines.push(line);
    }
  }

  flush();
  return cues;
};

export const serializeSrtBlocks = (cues: readonly RawCue[]): string => {
  const blocks = cues.map((cue, idx) =>
    [
      String(idx + 1),
      `${cue.start} --> ${cue.end}`,
      ...cue.text,
    ].join("\n"),
  );
  return `${blocks.join("\n\n")}\n`;
};

const MIN_CUE_DURATION_MS = 500;
const MAX_MERGE_DURATION_MS = 6_000;
/** Max characters in merged cue text — prevents over-merging into unreadable blocks. */
const MAX_MERGED_CHARS = 80;

const timestampToMs = (ts: string): number => {
  const parts = ts.split(":");
  const h = parts[0] ?? "00";
  const m = parts[1] ?? "00";
  const rest = parts[2] ?? "00,000";
  const [s = "00", ms = "000"] = rest.split(",");
  return parseInt(h) * 3_600_000 + parseInt(m) * 60_000 + parseInt(s) * 1000 + parseInt(ms);
};

const cueDurationMs = (cue: RawCue): number => timestampToMs(cue.end) - timestampToMs(cue.start);

/**
 * Detect YouTube auto-caption overlap between consecutive cues.
 * YouTube's two-line subtitle format slides one line at a time:
 *   A: "Line 1\nLine 2"  →  B: "Line 2\nLine 3"
 * Returns true if the last line of A matches the first line of B.
 */
const hasLineOverlap = (linesA: readonly string[], linesB: readonly string[]): boolean => {
  if (linesA.length === 0 || linesB.length === 0) return false;
  const lastA = linesA[linesA.length - 1]!.trim().toLowerCase();
  const firstB = linesB[0]!.trim().toLowerCase();
  return lastA.length > 5 && lastA === firstB;
};

/**
 * Merge B into A, removing B's first line (which duplicates A's last line).
 */
const mergeLineOverlap = (linesA: readonly string[], linesB: readonly string[]): string[] => {
  return [...linesA, ...linesB.slice(1)];
};

/**
 * Clean up fragmented SRT content.
 *
 * Merges consecutive cues when:
 * 1. Sliding-window overlap — the end of A matches the start of B (YouTube pattern)
 * 2. Incremental duplication — one text is a substring of the other (Whisper Flow)
 * 3. Ultra-short duration — cue under 500ms is unreadable alone
 *
 * Max merge duration cap (8 s) prevents cascading.
 */
export const cleanupSrt = (srtContent: string): string => {
  const cues = parseSubtitleBlocks(srtContent);
  if (cues.length <= 1) return srtContent;

  const merged: RawCue[] = [];
  let current: RawCue = { ...cues[0]!, text: [...cues[0]!.text] };

  for (let i = 1; i < cues.length; i++) {
    const next = cues[i]!;
    const currentFlat = current.text.join(" ");
    const nextFlat = next.text.join(" ");
    const duration = cueDurationMs(current);
    const combinedDuration = timestampToMs(next.end) - timestampToMs(current.start);
    const lineMatch = hasLineOverlap(current.text, next.text);
    const isSubstring = nextFlat.includes(currentFlat) || currentFlat.includes(nextFlat);

    const mergedCharCount = lineMatch
      ? current.text.join(" ").length + next.text.slice(1).join(" ").length
      : Math.max(currentFlat.length, nextFlat.length);

    const shouldMerge =
      combinedDuration <= MAX_MERGE_DURATION_MS &&
      mergedCharCount <= MAX_MERGED_CHARS &&
      (lineMatch || isSubstring || duration < MIN_CUE_DURATION_MS);

    if (shouldMerge) {
      const newText = lineMatch
        ? mergeLineOverlap(current.text, next.text)
        : nextFlat.length > currentFlat.length
          ? next.text
          : current.text;
      current = {
        index: current.index,
        start: current.start,
        end: next.end,
        text: newText,
      };
    } else {
      merged.push(current);
      current = { ...next, text: [...next.text] };
    }
  }

  merged.push(current);
  return serializeSrtBlocks(merged);
};

const normalizedCueText = (cue: RawCue): string =>
  cue.text.join(" ").replace(/\s+/gu, " ").trim().toLocaleLowerCase();

/** Reject a common Whisper hallucination: the same cue repeated for a long run. */
export const assertNoRepeatedTranscriptionCues = (srtContent: string): void => {
  let previous = "";
  let repeatedRun = 0;

  for (const cue of parseSubtitleBlocks(srtContent)) {
    const text = normalizedCueText(cue);
    if (text.length === 0) continue;
    repeatedRun = text === previous ? repeatedRun + 1 : 1;
    previous = text;
    if (repeatedRun >= 6) {
      throw new Error(
        "local transcription contains repeated subtitle cues; verify --subtitle-source-lang or use auto",
      );
    }
  }
};

export const convertSubtitleTextToSrt = (raw: string): string => {
  const cues = parseSubtitleBlocks(raw);
  if (cues.length === 0) {
    throw new Error("subtitle file did not contain any timed cues");
  }
  return serializeSrtBlocks(cues);
};

/**
 * Detect the likely language of subtitle content by sampling text cues.
 * Returns "zh" if CJK characters dominate, "en" if Latin dominates, or undefined if indeterminate.
 *
 * This is a lightweight heuristic — it does NOT use an NLP library.
 * Used to verify that the declared source_language matches actual content,
 * preventing translation from being skipped when language metadata is wrong.
 */
export const detectSubtitleLanguage = (srtContent: string): "zh" | "en" | undefined => {
  const cues = parseSubtitleBlocks(srtContent);
  const sampleText = cues
    .flatMap((c) => c.text)
    .join(" ")
    .slice(0, 4_000); // first 4k chars is enough

  let cjk = 0;
  let latin = 0;

  for (const ch of sampleText) {
    const cp = ch.codePointAt(0)!;
    // CJK Unified Ideographs + Extensions + Compatibility + Radicals
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
      (cp >= 0x20000 && cp <= 0x2a6df) || // CJK Extension B
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
      (cp >= 0x2f800 && cp <= 0x2fa1f) // CJK Compatibility Supplement
    ) {
      cjk++;
    } else if (
      (cp >= 0x41 && cp <= 0x5a) || // A-Z
      (cp >= 0x61 && cp <= 0x7a) // a-z
    ) {
      latin++;
    }
  }

  if (cjk > 5 && cjk > latin) return "zh";
  if (latin > 5 && latin > cjk) return "en";
  return undefined;
};

const writeManifest = async (videoDir: string, manifest: SubtitleManifest): Promise<void> => {
  await mkdir(path.join(videoDir, "video"), { recursive: true });
  await writeFile(subtitleManifestPath(videoDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
};

const sourceLangPattern = (sourceLang: string): RegExp => {
  const escaped = sourceLang.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // 中文语言代码变体匹配：zh-CN / zh-Hans / zh / zh-TW / zh-Hant 等
  if (/^zh(?:[-_](?:CN|Hans|Hant|TW|SG|HK|MO))?$/iu.test(sourceLang)) {
    return /\.(?:zh(?:[-_](?:CN|Hans|Hant|TW|SG|HK|MO))?)(?:-orig)?\.(?:srt|vtt)$/iu;
  }
  return new RegExp(`\\.${escaped}(?:-orig)?\\.(?:srt|vtt)$`, "iu");
};

const inferSubtitleLanguageFromName = (name: string, fallback: string): string => {
  const match = /\.(zh(?:[-_](?:CN|Hans|Hant|TW|SG|HK|MO))?|[a-z]{2,3}(?:[-_][a-z0-9]+)?)(?:-orig)?\.(?:srt|vtt)$/iu.exec(name);
  return match?.[1]?.replace("_", "-") ?? fallback;
};

/** Normalize YouTube uploader_id (e.g. @nateherk) for watermark display. */
const normalizeUploaderHandle = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
};

/** Read uploader_id from metadata.json for watermark attribution. */
const resolveWatermarkUploaderId = async (videoDir: string): Promise<string | undefined> => {
  try {
    const metaRaw = await readFile(path.join(videoDir, "metadata.json"), "utf8");
    const meta = JSON.parse(metaRaw) as { uploader_id?: string };
    return normalizeUploaderHandle(meta.uploader_id);
  } catch {
    return undefined;
  }
};

const subtitleLanguagePriority = (name: string, requestedLang: string): number => {
  const lang = inferSubtitleLanguageFromName(name, requestedLang);
  if (/^zh[-_]CN$/iu.test(lang)) return 0;
  if (/^zh[-_]Hans$/iu.test(lang)) return 1;
  if (/^zh$/iu.test(lang)) return 2;
  if (/^zh[-_](?:Hant|TW|HK|MO)$/iu.test(lang)) return 3;
  return 4;
};

const findYoutubeSubtitle = async (
  videoDir: string,
  sourceLang: string,
): Promise<{ file: string; method: SubtitleSourceMethod; language: string } | null> => {
  const names = await readdir(videoDir).catch(() => []);
  const langRe = sourceLangPattern(sourceLang);
  const candidates = names
    .filter((name) => langRe.test(name))
    .filter((name) => !name.startsWith("full."))
    .sort((a, b) => {
      const autoA = a.includes("-orig.") ? 1 : 0;
      const autoB = b.includes("-orig.") ? 1 : 0;
      return (
        autoA - autoB ||
        subtitleLanguagePriority(a, sourceLang) - subtitleLanguagePriority(b, sourceLang) ||
        a.localeCompare(b)
      );
    });
  const first = candidates[0];
  if (first === undefined) return null;
  return {
    file: path.join(videoDir, first),
    method: first.includes("-orig.") ? "youtube_auto_subtitles" : "youtube_subtitles",
    language: inferSubtitleLanguageFromName(first, sourceLang),
  };
};

const isChineseLanguageCode = (lang: string): boolean => /^zh(?:[-_][a-z0-9]+)?$/iu.test(lang);

const isTraditionalChineseCode = (lang: string): boolean =>
  /^zh[-_](?:Hant|TW|HK|MO)$/iu.test(lang);

const isSimplifiedChineseCode = (lang: string): boolean =>
  /^zh(?:[-_](?:CN|Hans|SG))?$/iu.test(lang);

const isAlreadyTargetLanguage = (sourceLang: string, targetLang: string): boolean => {
  if (sourceLang === targetLang) return true;
  if (!isChineseLanguageCode(sourceLang) || !isChineseLanguageCode(targetLang)) return false;

  if (isSimplifiedChineseCode(targetLang)) {
    // Bare "zh" is ambiguous — YouTube often tags Traditional Chinese subtitles as just "zh".
    // Don't treat it as pre-matched; let translation run so opencc-js can convert if needed.
    if (/^zh$/iu.test(sourceLang)) return false;
    return isSimplifiedChineseCode(sourceLang) && !isTraditionalChineseCode(sourceLang);
  }

  return true;
};

export const prepareSourceSubtitle = async (
  opts: PrepareSourceSubtitleOptions,
): Promise<PrepareSourceSubtitleResult> => {
  const warnings: string[] = [];
  const manifest: SubtitleManifest = {
    version: 1,
    source_video: "video/full.mp4",
    source_language: opts.sourceLang,
    target_language: opts.targetLang,
    warnings,
  };
  const dest = sourceSubtitlePath(opts.videoDir);
  await mkdir(path.dirname(dest), { recursive: true });

  let sourceFile: string | null = null;
  let method: SubtitleSourceMethod | undefined;

  if (opts.source === "file") {
    if (opts.file === undefined) {
      throw new Error("--subtitle-source file requires --subtitle-file");
    }
    sourceFile = opts.file;
    method = "file";
  } else if (opts.source === "transcribe") {
    if (opts.runner === undefined) {
      throw new Error("--subtitle-source transcribe requires a process runner");
    }
    const videoPath = path.join(opts.videoDir, "video", "full.mp4");
    const modelPath = process.env.WHISPER_MODEL ?? path.join(os.homedir(), ".cache", "whisper-models", "ggml-base.bin");
    const langArg = opts.sourceLang === "auto" ? "auto" : opts.sourceLang;
    // whisper-cli 不支持直接读 MP4 容器，先提取音频为 WAV
    const wavPath = path.join(opts.videoDir, "video", `transcribe-audio-${Date.now()}.wav`);

    try {
      await opts.runner.run({
        command: "ffmpeg",
        args: ["-y", "-i", videoPath, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", wavPath],
        timeoutMs: 120_000,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });

      const tmpOutput = path.join(opts.videoDir, "video", `transcribe-tmp-${Date.now()}`);
      await opts.runner.run({
        command: "whisper-cli",
        args: [
          "-m", modelPath,
          "-l", langArg,
          "-osrt",
          "-of", tmpOutput,
          wavPath,
        ],
        timeoutMs: 600_000,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      sourceFile = tmpOutput + ".srt";

      // 清理临时 WAV
      await rm(wavPath).catch(() => {});
      method = "local_transcription";

      // Detect actual language from transcription output and correct manifest.
      // The user-declared sourceLang may not match the audio (e.g. --subtitle-source-lang zh
      // on an English video). Trusting the declared language blindly causes the translation
      // step to be skipped — burned "Chinese" subtitles end up in English.
      try {
        const transcribedText = await readFile(sourceFile, "utf8");
        const detected = detectSubtitleLanguage(transcribedText);
        if (detected !== undefined && detected !== manifest.source_language) {
          manifest.source_language = detected;
        }
      } catch {
        // Keep declared source_language if detection fails
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`local transcription failed: ${message}`);
    }
  } else {
    // 单语中文流程优先复用目标语言字幕；双语流程则必须保留源语言轨，
    // 否则 full.en.srt 可能实际写入中文，最终将中文与中文合并成“中英”字幕。
    const langsToTry = opts.sourceLang !== opts.targetLang
      ? (opts.preferSourceLanguage ? [opts.sourceLang] : [opts.targetLang, opts.sourceLang])
      : [opts.sourceLang];
    let actualLang = "";
    for (const lang of langsToTry) {
      const found = await findYoutubeSubtitle(opts.videoDir, lang);
      if (found !== null) {
        sourceFile = found.file;
        method = found.method;
        actualLang = found.language;
        break;
      }
    }
    if (sourceFile === null && opts.source === "auto" && opts.preferSourceLanguage && opts.runner !== undefined) {
      return prepareSourceSubtitle({
        ...opts,
        source: "transcribe",
      });
    }
    if (sourceFile === null) {
      warnings.push(`no YouTube subtitle file found (tried: ${langsToTry.join(", ")})`);
      // 即使没找到也更新 manifest 里的 source_language，方便排查
      manifest.source_language = opts.targetLang;
    } else {
      manifest.source_language = actualLang;
    }
  }

  if (sourceFile === null) {
    await writeManifest(opts.videoDir, {
      ...manifest,
      ...(method !== undefined ? { source_method: method } : {}),
    });
    return { manifest: { ...manifest, ...(method !== undefined ? { source_method: method } : {}) } };
  }

  const ext = path.extname(sourceFile).toLowerCase();
  if (ext === ".srt") {
    await copyFile(sourceFile, dest);
  } else if (ext === ".vtt") {
    const raw = await readFile(sourceFile, "utf8");
    await writeFile(dest, convertSubtitleTextToSrt(raw), "utf8");
  } else {
    throw new Error(`unsupported subtitle file extension: ${ext}`);
  }

  // Clean up Whisper fragmentation: merge duplicate cues, consolidate short durations
  const rawSrt = await readFile(dest, "utf8");
  const cleanedSrt = cleanupSrt(rawSrt);
  if (method === "local_transcription") {
    assertNoRepeatedTranscriptionCues(cleanedSrt);
  }
  await writeFile(dest, cleanedSrt, "utf8");

  const completed: SubtitleManifest = {
    ...manifest,
    source_method: method ?? "file",
    source_subtitle: relativeVideoPath(dest),
  };
  await writeManifest(opts.videoDir, completed);
  return { manifest: completed, sourceSubtitle: dest };
};

export type VideoSubtitleOptions = {
  mode: "off" | "srt" | "burned" | "both";
  sourceLang: string;
  targetLang: string;
  source: "auto" | "youtube" | "transcribe" | "local" | "file";
  file?: string;
};

export type RunSubtitlePipelineOptions = {
  videoDir: string;
  subtitle: VideoSubtitleOptions;
  llm?: LlmPort;
  llmModel?: string;
  runner: ProcessRunner;
  signal?: AbortSignal;
  /** When set, burned video is written to this root dir instead of videoDir.
   *  E.g. "files/articles" → "files/articles/<videoId>/video/full.zh-burned.mp4" */
  burnedVideoOutDir?: string;
  /** 原片已有中文硬字幕时跳过烧录（默认 true） */
  skipBurnIfChineseBurned?: boolean;
  /** 强制重新烧录，覆盖已有 burnt video 并跳过硬字幕检测 */
  force?: boolean;
  /** 视频原语言（来自 YouTube metadata.language），用于 Layer 1 跳过判断 */
  videoLanguage?: string;
  /** 双语字幕模式：off / srt / ass / burned / all */
  subtitleBilingual?: "off" | "srt" | "ass" | "burned" | "all";
  /** 硬字幕烧制样式：zh-default / bilingual-explainer */
  subtitleBurnStyle?: "zh-default" | "bilingual-explainer";
  /** 烧录等长耗时子阶段的进度回调（detail 为人类可读描述，fraction ∈ [0,1]）。 */
  onProgress?: (detail: string, fraction: number) => void;
  /**
   * 用词级强制对齐（forced alignment, MMS_FA via torchaudio）替代按字符占比
   * 猜测的分句时长。默认关闭——探测/运行 torchaudio 有真实耗时（每视频多跑
   * 一次音频对齐），且这是本仓库唯一依赖 torch 的重型可选能力，不应该悄悄
   * 对所有用户生效。显式开启后，探测不到 torchaudio 或对齐失败都会静默退回
   * 原有按比例猜测的行为，不阻塞流水线。
   */
  enableForcedAlignment?: boolean;
};

export type RunSubtitlePipelineResult = {
  manifest: SubtitleManifest;
  warnings: string[];
};

/** 把烧录阶段事件转成进度条可显示的 detail + fraction。 */
const reportBurnProgress = (
  onProgress: ((detail: string, fraction: number) => void) | undefined,
  prefix: string,
): BurnProgressCallback | undefined => {
  if (onProgress === undefined) {
    return undefined;
  }
  return (e) => {
    const fraction = e.total > 0 ? e.done / e.total : 0;
    const detail =
      e.phase === "render"
        ? `${prefix}字幕渲染 ${e.done}/${e.total}`
        : e.phase === "frames"
          ? `${prefix}帧序列 ${e.done}/${e.total}`
          : `${prefix}烧录 ${Math.round(fraction * 100)}%`;
    onProgress(detail, fraction);
  };
};

/** The name the acquire step writes and every manifest records. */
const SOURCE_VIDEO_NAME = "full.mp4";

/**
 * Resolves the downloaded source video inside `<videoDir>/video`.
 *
 * `full.mp4` wins outright, because that is what acquire writes and what the
 * manifests already claim (`source_video: "video/full.mp4"`). That directory
 * is not exclusively ours, though — hand-cut test clips get parked there too,
 * and the previous "first *.mp4 that isn't a burned output" scan picked
 * `clip30.mp4` over `full.mp4` on nothing but alphabetical order: it burned a
 * 30-second excerpt straight over a 13-minute delivery while the manifest
 * still said full.mp4. Silent and destructive.
 *
 * The scan survives as a fallback so download trees whose source still carries
 * its YouTube title keep working, but the result says whether it had to fall
 * back, so callers can surface an unexpected pick instead of burning it.
 */
export const resolveSourceVideo = async (
  videoDir: string,
): Promise<{ name: string; preferred: boolean } | undefined> => {
  const names = await readdir(path.join(videoDir, "video")).catch(() => [] as string[]);
  if (names.includes(SOURCE_VIDEO_NAME)) return { name: SOURCE_VIDEO_NAME, preferred: true };
  const fallback = names.find((name) => /\.mp4$/iu.test(name) && !/burned/iu.test(name));
  return fallback === undefined ? undefined : { name: fallback, preferred: false };
};

/** Warns when the burn is about to use something other than `full.mp4`. */
const warnOnUnpreferredSource = (
  warnings: string[],
  source: { name: string; preferred: boolean },
): void => {
  if (source.preferred) return;
  warnings.push(
    `burning "${source.name}" as the source video: no ${SOURCE_VIDEO_NAME} in the download tree`,
  );
};

const SEMANTIC_VERSION = 1;
const TRANSLATION_RULE_VERSION = "semantic-bilingual-v1";
const LAYOUT_RULE_VERSION = "baocut-layout-v1";
const STYLE_VERSION = "baocut-bilingual-v1";

type ArticleBilingualManifest = {
  kind: "semantic-bilingual";
  status: "ready" | "failed";
  stages: {
    translation: "done" | "failed";
    alignment: "done" | "failed";
    segmentation: "done" | "failed";
    layout: "done" | "failed";
  };
  version: number;
  sourceSha256: string;
  translationRuleVersion: string;
  llmModel: string;
  layoutRuleVersion: string;
  styleVersion: string;
  resolvedFonts: { zh: string; en: string };
  videoWidth: number;
  videoHeight: number;
  videoWidthFraction: number;
  groups?: SemanticBilingualProjection["groups"];
  files?: Record<"en" | "zh" | "bilingual", { sha256: string }>;
  quality: { readyForBurn: boolean; issues: SubtitleAuditIssue[] };
  error?: { code: string; message: string };
};

const contentSha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const semanticDeliveryQuality = (
  report: SubtitleAuditResult,
  mode: "off" | "srt" | "ass" | "burned" | "all",
): ArticleBilingualManifest["quality"] => ({
  readyForBurn: mode !== "off" && isSubtitleAuditReadyForDelivery(report, mode),
  issues: report.issues,
});

/**
 * Reading-speed findings no longer block delivery (see
 * ADVISORY_PRESENTATION_CODES), so they have to be *said out loud* instead —
 * silently shipping disclosed debt is how it stops getting looked at. The
 * findings also stay in the manifest's `quality.issues` for `subtitle audit`
 * and `subtitle repair` to work from.
 */
const pushAdvisoryWarnings = (warnings: string[], report: SubtitleAuditResult): void => {
  const advisory = subtitleAuditAdvisoryIssues(report);
  if (advisory.length === 0) return;
  warnings.push(
    `${advisory.length} reading-speed finding(s) shipped as presentation debt ` +
      `(run \`yt2x subtitle repair\` to attempt a fix): ` +
      advisory.map((issue) => `${issue.code}@${issue.timestamp ?? "?"}`).join(", "),
  );
};

const atomicWrite = async (filePath: string, content: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
};

const findReadOnlyBilingualSource = async (
  videoDir: string,
  subtitle: VideoSubtitleOptions,
): Promise<{ content: string; path: string } | undefined> => {
  if (subtitle.source === "file" && subtitle.file !== undefined) {
    const raw = await readFile(subtitle.file, "utf8");
    return {
      content: path.extname(subtitle.file).toLowerCase() === ".srt"
        ? raw
        : convertSubtitleTextToSrt(raw),
      path: subtitle.file,
    };
  }
  const directories = [videoDir, path.join(videoDir, "video")];
  for (const directory of directories) {
    const names = await readdir(directory).catch(() => [] as string[]);
    const match = names.find((name) => {
      const lower = name.toLowerCase();
      const isSubtitle = (lower.endsWith(".srt") || lower.endsWith(".vtt")) &&
        lower.includes(`.${subtitle.sourceLang.toLowerCase()}.`);
      if (!isSubtitle) return false;
      // "local" (faster-whisper) and the default YouTube-caption source are
      // independent, coexisting channels — never silently fall back between
      // them, or a stale/missing local transcript would burn YouTube-derived
      // subtitles while the user believes they selected local.
      return subtitle.source === "local" ? lower.includes(".local.") : !lower.includes(".local.");
    });
    if (match !== undefined) {
      const sourcePath = path.join(directory, match);
      const raw = await readFile(sourcePath, "utf8");
      return {
        content: match.toLowerCase().endsWith(".srt") ? raw : convertSubtitleTextToSrt(raw),
        path: sourcePath,
      };
    }
  }
  return undefined;
};

/**
 * The local channel's word timings live in a sibling "*.words.json" file
 * next to the SRT (written by transcribe-local.py). Best-effort: a missing
 * or unreadable sidecar degrades to the proportional-length timing guess,
 * same as any other absent wordTimings source.
 */
const loadLocalWordTimings = async (srtPath: string): Promise<WordTiming[] | undefined> => {
  const wordsPath = srtPath.replace(/\.srt$/iu, ".words.json");
  try {
    const raw = await readFile(wordsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(
      (e): e is WordTiming =>
        typeof e === "object" && e !== null &&
        typeof (e as WordTiming).word === "string" &&
        typeof (e as WordTiming).start === "number" &&
        typeof (e as WordTiming).end === "number",
    );
  } catch {
    return undefined;
  }
};

/**
 * Cache validity is *integrity*, not verdict: are the artifacts on disk really
 * the ones this source SRT and this model produced under the current
 * translation rules, and do they still hash to what the manifest recorded?
 * The caller re-audits the reused artifacts and rewrites the verdict from that
 * fresh report, so gating reuse on the *recorded* verdict only meant a
 * manifest failed by an old rule could never be re-blessed — every retry threw
 * away good artifacts to buy a different random translation. `--force` remains
 * the way to deliberately ask for a fresh roll.
 *
 * The failure path writes a manifest with neither `files` nor `groups`, so the
 * genuinely unusable case is still rejected below.
 */
const readValidArticleCache = async (opts: {
  articleVideoDir: string;
  sourceSha256: string;
  model: string;
}): Promise<ArticleBilingualManifest | undefined> => {
  try {
    const raw = await readFile(path.join(opts.articleVideoDir, "full.bilingual.semantic.json"), "utf8");
    const manifest = JSON.parse(raw) as ArticleBilingualManifest;
    if (
      manifest.kind !== "semantic-bilingual" ||
      manifest.files === undefined ||
      manifest.groups === undefined ||
      manifest.sourceSha256 !== opts.sourceSha256 ||
      manifest.translationRuleVersion !== TRANSLATION_RULE_VERSION ||
      manifest.llmModel !== opts.model
    ) return undefined;
    const entries = [
      ["en", "full.en.srt"],
      ["zh", "full.zh.srt"],
      ["bilingual", "full.bilingual.srt"],
    ] as const;
    for (const [key, filename] of entries) {
      const content = await readFile(path.join(opts.articleVideoDir, filename), "utf8");
      if (contentSha256(content) !== manifest.files[key].sha256) return undefined;
    }
    return manifest;
  } catch {
    return undefined;
  }
};

/**
 * Best-effort word-level timing via forced alignment (see forced-align.py).
 * A pure optimization, never a requirement: returns undefined whenever
 * torchaudio isn't available, no source video can be found, or anything in
 * the process fails — callers must fall back to the existing proportional
 * split-point guess, never treat a missing result as an error.
 */
const computeWordTimings = async (opts: {
  videoDir: string;
  sourceSrt: string;
  runner: ProcessRunner;
  signal?: AbortSignal;
}): Promise<WordTiming[] | undefined> => {
  const pythonBin = await resolvePythonWithTorchaudio();
  if (pythonBin === undefined) return undefined;

  const source = await resolveSourceVideo(opts.videoDir);
  if (source === undefined) return undefined;
  const mp4 = source.name;

  const words = parseSubtitleBlocks(opts.sourceSrt)
    .flatMap((cue) => cue.text.join(" ").split(/\s+/u))
    .filter((w) => w.length > 0);
  if (words.length === 0) return undefined;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-align-"));
  try {
    const wavPath = path.join(tempDir, "audio.wav");
    const wordsPath = path.join(tempDir, "words.json");
    const outputPath = path.join(tempDir, "alignment.json");

    await opts.runner.run({
      command: "ffmpeg",
      args: [
        "-y", "-i", path.join(opts.videoDir, "video", mp4),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        wavPath,
      ],
      timeoutMs: 120_000,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    await writeFile(wordsPath, JSON.stringify(words), "utf8");

    const result = await opts.runner.run({
      command: pythonBin,
      args: [FORCED_ALIGN_SCRIPT, "--audio", wavPath, "--words", wordsPath, "--output", outputPath],
      timeoutMs: 600_000,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (result.exitCode !== 0) return undefined;

    const raw = await readFile(outputPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(
      (e): e is WordTiming =>
        typeof e === "object" && e !== null &&
        typeof (e as WordTiming).word === "string" &&
        typeof (e as WordTiming).start === "number" &&
        typeof (e as WordTiming).end === "number",
    );
  } catch {
    return undefined;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

export type LocalTranscriptionResult = {
  srtPath: string;
  wordsPath: string;
  cueCount: number;
};

/**
 * Local transcription channel (see transcribe-local.py): an independent
 * alternative to the YouTube-caption source, not a replacement for it. Writes
 * "full.local.<lang>.srt" / "full.local.<lang>.words.json" next to the
 * existing "full.<lang>.srt" without touching it — both sources coexist on
 * disk, selected at burn time via `--subtitle-source local`.
 *
 * Unlike computeWordTimings (a silent best-effort optimization inside the
 * main pipeline), this is an explicit, user-invoked step: callers should
 * surface both the "not available" (undefined) and thrown-error cases,
 * rather than swallowing them.
 */
export const transcribeLocal = async (opts: {
  videoDir: string;
  language: string;
  runner: ProcessRunner;
  model?: string;
  signal?: AbortSignal;
}): Promise<LocalTranscriptionResult | undefined> => {
  const pythonBin = await resolvePythonWithFasterWhisper();
  if (pythonBin === undefined) return undefined;

  const videoSubdir = path.join(opts.videoDir, "video");
  const source = await resolveSourceVideo(opts.videoDir);
  if (source === undefined) return undefined;
  const mp4 = source.name;

  const srtPath = path.join(videoSubdir, `full.local.${opts.language}.srt`);
  const wordsPath = path.join(videoSubdir, `full.local.${opts.language}.words.json`);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-transcribe-local-"));
  try {
    const wavPath = path.join(tempDir, "audio.wav");
    await opts.runner.run({
      command: "ffmpeg",
      args: [
        "-y", "-i", path.join(videoSubdir, mp4),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        wavPath,
      ],
      timeoutMs: 120_000,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    const result = await opts.runner.run({
      command: pythonBin,
      args: [
        TRANSCRIBE_LOCAL_SCRIPT,
        "--audio", wavPath,
        "--language", opts.language,
        ...(opts.model !== undefined ? ["--model", opts.model] : []),
        "--srt-output", srtPath,
        "--words-output", wordsPath,
      ],
      timeoutMs: 1_800_000,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (result.exitCode !== 0) {
      throw new Error(`local transcription failed: ${result.stderr || `exit ${result.exitCode}`}`);
    }

    const srtContent = await readFile(srtPath, "utf8");
    const cueCount = parseSubtitleBlocks(srtContent).length;
    return { srtPath, wordsPath, cueCount };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

const runArticleBilingualPipeline = async (
  opts: RunSubtitlePipelineOptions,
): Promise<RunSubtitlePipelineResult | undefined> => {
  const bilingualMode = opts.subtitleBilingual ?? "off";
  if (bilingualMode === "off" || opts.burnedVideoOutDir === undefined) return undefined;
  const source = await findReadOnlyBilingualSource(opts.videoDir, opts.subtitle);
  if (source === undefined) return undefined;
  if (opts.llm === undefined || opts.llmModel === undefined) {
    throw new Error("bilingual subtitle generation requires LLM config");
  }

  const warnings: string[] = [];
  const articleVideoDir = path.join(
    opts.burnedVideoOutDir,
    path.basename(opts.videoDir),
    "video",
  );
  const sourceSha256 = contentSha256(source.content);
  const measureLayout = async (srt: string): Promise<SubtitleLayoutMeasurement[]> =>
    measureBilingualSubtitleLayout({
      srtContent: srt,
      videoWidth: 1280,
      videoHeight: 720,
      runner: opts.runner,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  const cached = opts.force === true ? undefined : await readValidArticleCache({
    articleVideoDir,
    sourceSha256,
    model: opts.llmModel,
  });
  if (cached !== undefined) {
    const [enSrt, zhSrt, bilingualSrt] = await Promise.all([
      readFile(path.join(articleVideoDir, "full.en.srt"), "utf8"),
      readFile(path.join(articleVideoDir, "full.zh.srt"), "utf8"),
      readFile(path.join(articleVideoDir, "full.bilingual.srt"), "utf8"),
    ]);
    const measurements = await measureLayout(bilingualSrt);
    const audit = auditSubtitleArtifacts({
      sourceSrt: source.content,
      enSrt,
      zhSrt,
      bilingualSrt,
      manifest: cached,
      measurements,
    });
    const quality = semanticDeliveryQuality(audit, bilingualMode);
    pushAdvisoryWarnings(warnings, audit);
    const resolvedFonts = measurements[0]?.resolvedFonts ?? cached.resolvedFonts;
    const refreshed = {
      ...cached,
      layoutRuleVersion: LAYOUT_RULE_VERSION,
      styleVersion: STYLE_VERSION,
      resolvedFonts,
      videoWidth: 1280,
      videoHeight: 720,
      videoWidthFraction: 0.8,
      quality,
      status: quality.readyForBurn ? "ready" : "failed",
      stages: {
        ...cached.stages,
        layout: quality.readyForBurn ? "done" : "failed",
      },
    };
    if (JSON.stringify(refreshed) !== JSON.stringify(cached)) {
      await atomicWrite(
        path.join(articleVideoDir, "full.bilingual.semantic.json"),
        `${JSON.stringify(refreshed, null, 2)}\n`,
      );
    }
    await atomicWrite(
      path.join(articleVideoDir, "full.bilingual.audit.json"),
      `${JSON.stringify(audit, null, 2)}\n`,
    );
    if (!quality.readyForBurn) {
      throw new Error("semantic bilingual quality gate blocked delivery");
    }
    if (bilingualMode === "burned" || bilingualMode === "all") {
      const source = await resolveSourceVideo(opts.videoDir);
      if (source === undefined) {
        throw new Error("downloaded source video is required for bilingual subtitle burning");
      }
      warnOnUnpreferredSource(warnings, source);
      const mp4 = source.name;
      await burnBilingualSubtitles({
        srtPath: path.join(articleVideoDir, "full.bilingual.srt"),
        enSrtPath: path.join(articleVideoDir, "full.en.srt"),
        zhSrtPath: path.join(articleVideoDir, "full.zh.srt"),
        videoPath: path.join(opts.videoDir, "video", mp4),
        outputPath: path.join(articleVideoDir, "full.bilingual-burned.mp4"),
        runner: opts.runner,
        ...(opts.force !== undefined ? { force: opts.force } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    }
    return {
      manifest: {
        version: 2,
        source_video: "video/full.mp4",
        source_language: opts.subtitle.sourceLang,
        target_language: opts.subtitle.targetLang,
        source_method: opts.subtitle.source === "file"
          ? "file"
          : opts.subtitle.source === "local"
            ? "local_transcription"
            : "youtube_subtitles",
        bilingual_subtitle: "video/full.bilingual.srt",
        warnings,
      },
      warnings,
    };
  }

  // The local channel already carries word-level timing from the ASR pass
  // itself (see transcribe-local.py) — reuse it directly instead of paying
  // for a second, separate forced-alignment pass over the same audio.
  const wordTimings = opts.subtitle.source === "local"
    ? await loadLocalWordTimings(source.path)
    : opts.enableForcedAlignment === true
      ? await computeWordTimings({
          videoDir: opts.videoDir,
          sourceSrt: source.content,
          runner: opts.runner,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        })
      : undefined;

  let projection: SemanticBilingualProjection;
  try {
    projection = await projectSemanticBilingualSubtitles({
      sourceSrt: source.content,
      llm: opts.llm,
      model: opts.llmModel,
      measureLayout,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(wordTimings !== undefined ? { wordTimings } : {}),
    });
  } catch (error: unknown) {
    if (!(error instanceof SemanticProjectionError)) throw error;
    const failedManifest: ArticleBilingualManifest = {
      kind: "semantic-bilingual",
      status: "failed",
      stages: {
        translation: "failed",
        alignment: "failed",
        segmentation: "failed",
        layout: "failed",
      },
      version: SEMANTIC_VERSION,
      sourceSha256,
      translationRuleVersion: TRANSLATION_RULE_VERSION,
      llmModel: opts.llmModel,
      layoutRuleVersion: LAYOUT_RULE_VERSION,
      styleVersion: STYLE_VERSION,
      resolvedFonts: { zh: "unknown", en: "unknown" },
      videoWidth: 1280,
      videoHeight: 720,
      videoWidthFraction: 0.8,
      quality: { readyForBurn: false, issues: [] },
      error: { code: error.code, message: error.message },
    };
    await atomicWrite(
      path.join(articleVideoDir, "full.bilingual.semantic.json"),
      `${JSON.stringify(failedManifest, null, 2)}\n`,
    );
    throw error;
  }

  const measurements = await measureLayout(projection.bilingualSrt);
  const resolvedFonts = measurements[0]?.resolvedFonts ?? { zh: "unknown", en: "unknown" };
  await Promise.all([
    atomicWrite(path.join(articleVideoDir, "full.en.srt"), projection.enSrt),
    atomicWrite(path.join(articleVideoDir, "full.zh.srt"), projection.zhSrt),
    atomicWrite(path.join(articleVideoDir, "full.bilingual.srt"), projection.bilingualSrt),
  ]);
  const [enSrt, zhSrt, bilingualSrt] = await Promise.all([
    readFile(path.join(articleVideoDir, "full.en.srt"), "utf8"),
    readFile(path.join(articleVideoDir, "full.zh.srt"), "utf8"),
    readFile(path.join(articleVideoDir, "full.bilingual.srt"), "utf8"),
  ]);
  const audit = auditSubtitleArtifacts({
    sourceSrt: source.content,
    enSrt,
    zhSrt,
    bilingualSrt,
    manifest: { sourceSha256 },
    measurements,
  });
  projection = { ...projection, enSrt, zhSrt, bilingualSrt };
  const quality = semanticDeliveryQuality(audit, bilingualMode);
  pushAdvisoryWarnings(warnings, audit);
  const files = {
    en: { sha256: contentSha256(enSrt) },
    zh: { sha256: contentSha256(zhSrt) },
    bilingual: { sha256: contentSha256(bilingualSrt) },
  };
  const articleManifest: ArticleBilingualManifest = {
    kind: "semantic-bilingual",
    status: quality.readyForBurn ? "ready" : "failed",
    stages: {
      translation: "done",
      alignment: "done",
      segmentation: "done",
      layout: quality.readyForBurn ? "done" : "failed",
    },
    version: SEMANTIC_VERSION,
    sourceSha256,
    translationRuleVersion: TRANSLATION_RULE_VERSION,
    llmModel: opts.llmModel,
    layoutRuleVersion: LAYOUT_RULE_VERSION,
    styleVersion: STYLE_VERSION,
    resolvedFonts,
    videoWidth: 1280,
    videoHeight: 720,
    videoWidthFraction: 0.8,
    groups: projection.groups,
    files,
    quality,
  };
  await Promise.all([
    atomicWrite(
      path.join(articleVideoDir, "full.bilingual.semantic.json"),
      `${JSON.stringify(articleManifest, null, 2)}\n`,
    ),
    atomicWrite(
      path.join(articleVideoDir, "full.bilingual.audit.json"),
      `${JSON.stringify(audit, null, 2)}\n`,
    ),
  ]);
  if (!quality.readyForBurn) {
    throw new Error("semantic bilingual quality gate blocked delivery");
  }
  const validatedManifest = await readValidArticleCache({
    articleVideoDir,
    sourceSha256,
    model: opts.llmModel,
  });
  if (validatedManifest === undefined) {
    throw new Error("semantic bilingual delivery manifest or subtitle hashes failed validation");
  }

  if (bilingualMode === "ass" || bilingualMode === "all") {
    await atomicWrite(
      path.join(articleVideoDir, "full.bilingual.ass"),
      buildBilingualAss(projection.enSrt, projection.zhSrt, {
        zhFont: resolvedFonts.zh,
        enFont: resolvedFonts.en,
        videoWidth: 1280,
        videoHeight: 720,
      }),
    );
  }

  if (bilingualMode === "burned" || bilingualMode === "all") {
    const source = await resolveSourceVideo(opts.videoDir);
    if (source === undefined) {
      throw new Error("downloaded source video is required for bilingual subtitle burning");
    }
    warnOnUnpreferredSource(warnings, source);
    const mp4 = source.name;
    await burnBilingualSubtitles({
      srtPath: path.join(articleVideoDir, "full.bilingual.srt"),
      enSrtPath: path.join(articleVideoDir, "full.en.srt"),
      zhSrtPath: path.join(articleVideoDir, "full.zh.srt"),
      videoPath: path.join(opts.videoDir, "video", mp4),
      outputPath: path.join(articleVideoDir, "full.bilingual-burned.mp4"),
      runner: opts.runner,
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  return {
    manifest: {
      version: 2,
      source_video: "video/full.mp4",
      source_language: opts.subtitle.sourceLang,
      target_language: opts.subtitle.targetLang,
      source_method: opts.subtitle.source === "file" ? "file" : "youtube_subtitles",
      bilingual_subtitle: "video/full.bilingual.srt",
      ...(bilingualMode === "ass" || bilingualMode === "all"
        ? { bilingual_ass: "video/full.bilingual.ass" }
        : {}),
      ...(bilingualMode === "burned" || bilingualMode === "all"
        ? { burned_video: "video/full.bilingual-burned.mp4" }
        : {}),
      warnings,
    },
    warnings,
  };
};

export const runSubtitlePipeline = async (
  opts: RunSubtitlePipelineOptions,
): Promise<RunSubtitlePipelineResult> => {
  const requestedBilingualMode = opts.subtitleBilingual ?? "off";
  if (requestedBilingualMode !== "off" && opts.burnedVideoOutDir === undefined) {
    throw new Error("article output directory is required for bilingual subtitle delivery");
  }
  const articleResult = await runArticleBilingualPipeline(opts);
  if (articleResult !== undefined) return articleResult;
  if (requestedBilingualMode !== "off") {
    throw new Error(
      `downloaded source subtitle for language "${opts.subtitle.sourceLang}" is required for bilingual subtitle delivery`,
    );
  }
  const { videoDir, subtitle } = opts;
  const mode = subtitle.mode;
  const warnings: string[] = [];
  const mustHaveSubtitles =
    mode === "burned" ||
    opts.subtitleBilingual === "burned" ||
    opts.subtitleBilingual === "all";

  const subResult = await prepareSourceSubtitle({
    videoDir,
    sourceLang: subtitle.sourceLang,
    targetLang: subtitle.targetLang,
    source: subtitle.source,
    preferSourceLanguage: opts.subtitleBilingual !== undefined && opts.subtitleBilingual !== "off",
    ...(subtitle.file !== undefined ? { file: subtitle.file } : {}),
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  warnings.push(...subResult.manifest.warnings);
  let manifest = { ...subResult.manifest };

  if (subResult.sourceSubtitle === undefined) {
    if (mustHaveSubtitles) {
      const reqDesc =
        opts.subtitleBilingual === "burned" || opts.subtitleBilingual === "all"
          ? "--subtitle-bilingual burned/all"
          : "--subtitle-zh burned";
      throw new Error(
        `no subtitles available. ${reqDesc} requires subtitle source. ` +
          "Provide subtitles via --subtitle-source file --subtitle-file, or ensure YouTube subtitles are available.",
      );
    }
    return { manifest, warnings };
  }

  const zhSrtPath = path.join(videoDir, "video", "full.zh.srt");
  if (opts.force) {
    await rm(zhSrtPath).catch(() => {});
  }
  let hasZhSrt = false;
  try {
    await access(zhSrtPath);
    hasZhSrt = true;
  } catch {
    hasZhSrt = false;
  }

  // When bilingual mode is active, validate that the existing zh.srt has the
  // same cue count as the source en.srt. If the en.srt was regenerated (e.g.
  // cleanupSrt merged cues), the stale zh.srt must be re-translated so the
  // bilingual merge can align cues 1:1.
  const bilingualActive = opts.subtitleBilingual !== undefined && opts.subtitleBilingual !== "off";
  if (hasZhSrt && bilingualActive && subResult.sourceSubtitle !== undefined) {
    try {
      const enRaw = await readFile(subResult.sourceSubtitle, "utf8");
      const zhRaw = await readFile(zhSrtPath, "utf8");
      const enCues = parseSubtitleBlocks(enRaw);
      const zhCues = parseSubtitleBlocks(zhRaw);
      if (enCues.length !== zhCues.length) {
        warnings.push(
          `existing zh.srt has ${zhCues.length} cues but source en.srt has ${enCues.length} cues; re-translating for bilingual alignment`,
        );
        await rm(zhSrtPath).catch(() => {});
        hasZhSrt = false;
        // Remove stale translation fields from manifest
        const { target_subtitle: _ts, translation_method: _tm, ...restManifest } = manifest;
        manifest = { ...restManifest };
      }
    } catch {
      // If we can't validate, proceed with existing zh.srt
    }
  }

  const hasLlm = opts.llm !== undefined && opts.llmModel !== undefined;
  const sourceLangCodeMatchesTarget = isAlreadyTargetLanguage(
    manifest.source_language,
    subtitle.targetLang,
  );

  // Verify that the source subtitle content actually matches the declared language.
  // Prevents skipping translation when language metadata is wrong (e.g. source_language
  // is "zh" but the SRT file contains English text from a misconfigured transcription).
  let contentMatchesTargetLang = sourceLangCodeMatchesTarget;
  if (sourceLangCodeMatchesTarget && subResult.sourceSubtitle !== undefined) {
    try {
      const sampleText = await readFile(subResult.sourceSubtitle, "utf8");
      const detected = detectSubtitleLanguage(sampleText);
      if (detected !== undefined && subtitle.targetLang.startsWith("zh") && detected !== "zh") {
        contentMatchesTargetLang = false;
        warnings.push(
          `source_language is ${manifest.source_language} but content detected as ${detected}; will translate`,
        );
      }
    } catch {
      // If we can't read the file, trust the language code
    }
  }

  // When sourceLangCodeMatchesTarget is false but the source IS Chinese (e.g. bare
  // "zh" vs target "zh-CN"), the language code alone is ambiguous — bare "zh" could
  // be either Simplified or Traditional. Run content detection to check whether the
  // subtitle content is already Simplified Chinese; if so, skip translation + burn.
  if (!sourceLangCodeMatchesTarget && !contentMatchesTargetLang &&
      isChineseLanguageCode(manifest.source_language) &&
      isSimplifiedChineseCode(subtitle.targetLang) &&
      subResult.sourceSubtitle !== undefined) {
    try {
      const sampleText = await readFile(subResult.sourceSubtitle, "utf8");
      const detected = detectSubtitleLanguage(sampleText);
      if (detected === "zh") {
        // Content IS Chinese — now check if it's already Simplified
        const { simplifyChinese } = await import("./simplify-chinese.js");
        const simplified = await simplifyChinese(sampleText.slice(0, 3_000));
        if (simplified === sampleText.slice(0, 3_000)) {
          // Already Simplified Chinese — skip translation + burn
          contentMatchesTargetLang = true;
          warnings.push(
            `source_language is ${manifest.source_language} but content is already Simplified Chinese; skipping translation`,
          );
        }
      }
    } catch {
      // If detection fails, fall through to normal translation path
    }
  }

  // Additionally, when the language code says "already Chinese" but the actual subtitle
  // content is Traditional Chinese, force translation so we burn Simplified Chinese.
  // detectSubtitleLanguage above can't distinguish Simplified from Traditional (both
  // are in the same CJK Unicode range), so we use opencc-js TW→CN conversion as a
  // detector: if the output differs from the input, the source is Traditional Chinese.
  if (contentMatchesTargetLang && isSimplifiedChineseCode(subtitle.targetLang) && subResult.sourceSubtitle !== undefined) {
    try {
      const sampleText = await readFile(subResult.sourceSubtitle, "utf8");
      const { simplifyChinese } = await import("./simplify-chinese.js");
      const simplified = await simplifyChinese(sampleText.slice(0, 3_000));
      if (simplified !== sampleText.slice(0, 3_000)) {
        contentMatchesTargetLang = false;
        warnings.push(
          `source_language is ${manifest.source_language} but subtitle content appears to be Traditional Chinese; will translate to Simplified Chinese`,
        );
      }
    } catch {
      // If detection fails, trust the language code
    }
  }

  // 如果源字幕已经是目标语言（语言码匹配 + 内容验证通过），直接复制，无需翻译。
  // zh-Hant / zh-TW / zh-HK 不能在 zh-CN 目标下跳过，否则硬字幕会烧录繁体。
  if (!hasZhSrt && contentMatchesTargetLang) {
    await copyFile(subResult.sourceSubtitle, zhSrtPath);
    hasZhSrt = true;
    manifest = {
      ...manifest,
      target_subtitle: "video/full.zh.srt",
      translation_method: "manual",
    };
  }

  // Only translate if zh.srt doesn't already exist and source is NOT target language
  if (!hasZhSrt && !contentMatchesTargetLang && hasLlm) {
    try {
      const enSrt = await readFile(subResult.sourceSubtitle, "utf8");
      const { srt: zhSrt, warnings: translationWarnings } = await translateSrt(enSrt, {
        llm: opts.llm!,
        model: opts.llmModel!,
        sourceLang: manifest.source_language,
        targetLang: subtitle.targetLang,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      await writeFile(zhSrtPath, zhSrt, "utf8");
      hasZhSrt = true;
      manifest = {
        ...manifest,
        target_subtitle: "video/full.zh.srt",
        translation_method: "llm",
      };
      warnings.push(...translationWarnings);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (mustHaveSubtitles) {
        throw new Error(`Chinese subtitle translation failed: ${message}`);
      }
      warnings.push(`Chinese subtitle translation failed: ${message}`);
    }
  } else if (!hasZhSrt && mustHaveSubtitles) {
    throw new Error(
      "Chinese subtitle translation requires LLM config (--llm-provider). Set YT2X_LLM_PROVIDER or pass --llm-provider.",
    );
  }

  if ((mode === "burned" || mode === "both") && hasZhSrt) {
    const watermarkVideo = await resolveWatermarkUploaderId(videoDir);
    const articleZhSrtPath = opts.burnedVideoOutDir !== undefined
      ? path.join(opts.burnedVideoOutDir, path.basename(videoDir), "video", "full.zh.srt")
      : undefined;
    const burnSrtPath = articleZhSrtPath === undefined
      ? zhSrtPath
      : await access(articleZhSrtPath)
        .then(() => articleZhSrtPath)
        .catch(() => zhSrtPath);
    const burnResult = await burnZhSubtitlesForVideo({
      videoDir,
      srtPath: burnSrtPath,
      runner: opts.runner,
      ...(opts.burnedVideoOutDir !== undefined ? { burnedVideoOutDir: opts.burnedVideoOutDir } : {}),
      ...(opts.skipBurnIfChineseBurned !== undefined
        ? { skipIfChineseBurned: opts.skipBurnIfChineseBurned }
        : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.videoLanguage !== undefined ? { videoLanguage: opts.videoLanguage } : {}),
      ...(watermarkVideo !== undefined ? { watermarkVideo } : {}),
      watermarkXlate: "@php_martin",
      ...(() => {
        const onProgress = reportBurnProgress(opts.onProgress, "中文");
        return onProgress !== undefined ? { onProgress } : {};
      })(),
    });

    if (burnResult.burnedPath !== undefined) {
      manifest = { ...manifest, burned_video: burnResult.burnedPath };
    }

    if (burnResult.skipReason === "already_exists") {
      warnings.push("burned video already exists, skipping burn step");
    } else if (burnResult.skipReason === "video_is_chinese") {
      warnings.push(
        "video original language is Chinese, skipping subtitle burn (Layer 1)",
      );
    } else if (burnResult.skipReason === "chinese_burned_detected") {
      warnings.push(
        "original video already has burned Chinese subtitles (detected), skipping re-burn",
      );
    } else if (burnResult.skipReason === "missing_mp4") {
      warnings.push("no MP4 video file found for subtitle burning");
    }
  }

  // ── Bilingual subtitle generation ──
  const bilingualMode = opts.subtitleBilingual ?? "off";
  const bilingualMustHave =
    bilingualMode === "burned" || bilingualMode === "all";

  if (bilingualMode !== "off" && !hasZhSrt) {
    if (bilingualMustHave) {
      throw new Error(
        "Chinese subtitle translation required for --subtitle-bilingual burned/all. " +
          "Provide LLM config (--llm-provider) or ensure Chinese subtitles are available.",
      );
    }
  }

  if (bilingualMode !== "off" && subResult.sourceSubtitle !== undefined && hasZhSrt) {
    const enSrtPath = subResult.sourceSubtitle;
    const zhSrtPath = path.join(videoDir, "video", "full.zh.srt");
    const burnStyle = opts.subtitleBurnStyle === "bilingual-explainer"
      ? "bilingual-explainer-v1"
      : undefined;

    try {
      const enSrtContent = await readFile(enSrtPath, "utf8");
      const zhSrtContent = await readFile(zhSrtPath, "utf8");

      // Generate bilingual SRT
      if (bilingualMode === "srt" || bilingualMode === "ass" || bilingualMode === "burned" || bilingualMode === "all") {
        const bilingualSrt = mergeBilingualSrt(enSrtContent, zhSrtContent);
        const bilingualSrtPath = path.join(videoDir, "video", "full.bilingual.srt");
        await writeFile(bilingualSrtPath, bilingualSrt, "utf8");
        manifest = {
          ...manifest,
          bilingual_subtitle: "video/full.bilingual.srt",
        };

        // Copy to article dir if specified
        if (opts.burnedVideoOutDir !== undefined) {
          const articleVideoDir = path.join(opts.burnedVideoOutDir, path.basename(videoDir), "video");
          await mkdir(articleVideoDir, { recursive: true });
          await copyFile(
            bilingualSrtPath,
            path.join(articleVideoDir, "full.bilingual.srt"),
          ).catch(() => {});
        }
      }

      // Generate bilingual ASS
      if (bilingualMode === "ass" || bilingualMode === "burned" || bilingualMode === "all") {
        const bilingualAss = buildBilingualAss(enSrtContent, zhSrtContent, {
          zhFont: opts.subtitleBurnStyle === "bilingual-explainer" ? "PingFang SC" : "PingFang SC",
          enFont: "Arial",
          videoWidth: 1280,
          videoHeight: 720,
        });
        const bilingualAssPath = path.join(videoDir, "video", "full.bilingual.ass");
        await writeFile(bilingualAssPath, bilingualAss, "utf8");
        manifest = {
          ...manifest,
          bilingual_ass: "video/full.bilingual.ass",
        };

        // Copy to article dir if specified
        if (opts.burnedVideoOutDir !== undefined) {
          const articleVideoDir = path.join(opts.burnedVideoOutDir, path.basename(videoDir), "video");
          await mkdir(articleVideoDir, { recursive: true });
          await copyFile(
            bilingualAssPath,
            path.join(articleVideoDir, "full.bilingual.ass"),
          ).catch(() => {});
        }
      }

      // Burn bilingual subtitles
      if (bilingualMode === "burned" || bilingualMode === "all") {
        const bilingualSrtPath = path.join(videoDir, "video", "full.bilingual.srt");
        const source = await resolveSourceVideo(videoDir);
        if (source !== undefined) warnOnUnpreferredSource(warnings, source);
        const mp4File = source?.name;
        if (mp4File !== undefined) {
          const videoPath = path.join(videoDir, "video", mp4File);
          const burnedSubdir =
            opts.burnedVideoOutDir !== undefined
              ? path.join(opts.burnedVideoOutDir, path.basename(videoDir), "video")
              : path.join(videoDir, "video");
          const burnedOutput = path.join(burnedSubdir, "full.bilingual-burned.mp4");

          // Read uploader handle for watermark (e.g. @nateherk from metadata.uploader_id)
          const watermarkVideo = await resolveWatermarkUploaderId(videoDir);

          const burnResult = await burnBilingualSubtitles({
            srtPath: bilingualSrtPath,
            videoPath,
            outputPath: burnedOutput,
            runner: opts.runner,
            enSrtPath,
            zhSrtPath,
            ...(opts.force !== undefined ? { force: opts.force } : {}),
            ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
            ...(watermarkVideo !== undefined ? { watermarkVideo } : {}),
            watermarkXlate: "@php_martin",
            ...(() => {
              const onProgress = reportBurnProgress(opts.onProgress, "双语");
              return onProgress !== undefined ? { onProgress } : {};
            })(),
          });

          warnings.push(...burnResult.warnings);

          if (burnResult.burned) {
            manifest = {
              ...manifest,
              version: 2,
              burned_video: "video/full.bilingual-burned.mp4",
              ...(burnStyle !== undefined ? { burn_style: burnStyle } : {}),
            };
          }
        } else {
          warnings.push("no MP4 video file found for bilingual subtitle burning");
        }
      }

      // Upgrade manifest version if bilingual fields are present
      if (manifest.bilingual_subtitle !== undefined || manifest.bilingual_ass !== undefined) {
        manifest = {
          ...manifest,
          version: 2,
          ...(burnStyle !== undefined ? { burn_style: burnStyle } : {}),
        };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (bilingualMode === "burned" || bilingualMode === "all") {
        throw new Error(`bilingual subtitle generation failed: ${message}`);
      }
      warnings.push(`bilingual subtitle generation failed: ${message}`);
    }
  }

  // Write final manifest
  await writeManifest(videoDir, { ...manifest, warnings });
  return { manifest: { ...manifest, warnings }, warnings };
};
