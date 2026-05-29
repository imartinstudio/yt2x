import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmPort } from "@yt2x/core";
import type { ProcessRunner } from "../process/index.js";
import { burnSubtitles } from "./burn-subtitles.js";
import { translateSrt } from "./srt-translator.js";

export type SubtitleSourceMode = "auto" | "youtube" | "transcribe" | "file";

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
  version: 1;
  source_video: string;
  source_language: string;
  target_language: string;
  source_method?: SubtitleSourceMethod;
  source_subtitle?: string;
  target_subtitle?: string;
  burned_video?: string;
  translation_method?: "llm" | "manual" | "external_command";
  warnings: string[];
};

export type PrepareSourceSubtitleOptions = {
  videoDir: string;
  sourceLang: string;
  targetLang: string;
  source: SubtitleSourceMode;
  file?: string;
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

export const convertSubtitleTextToSrt = (raw: string): string => {
  const cues = parseSubtitleBlocks(raw);
  if (cues.length === 0) {
    throw new Error("subtitle file did not contain any timed cues");
  }
  return serializeSrtBlocks(cues);
};

const writeManifest = async (videoDir: string, manifest: SubtitleManifest): Promise<void> => {
  await mkdir(path.join(videoDir, "video"), { recursive: true });
  await writeFile(subtitleManifestPath(videoDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
};

const sourceLangPattern = (sourceLang: string): RegExp => {
  const escaped = sourceLang.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\.${escaped}(?:-orig)?\\.(?:srt|vtt)$`, "iu");
};

const findYoutubeSubtitle = async (
  videoDir: string,
  sourceLang: string,
): Promise<{ file: string; method: SubtitleSourceMethod } | null> => {
  const names = await readdir(videoDir).catch(() => []);
  const langRe = sourceLangPattern(sourceLang);
  const candidates = names
    .filter((name) => langRe.test(name))
    .filter((name) => !name.startsWith("full."))
    .sort((a, b) => {
      const autoA = a.includes("-orig.") ? 1 : 0;
      const autoB = b.includes("-orig.") ? 1 : 0;
      return autoA - autoB || a.localeCompare(b);
    });
  const first = candidates[0];
  if (first === undefined) return null;
  return {
    file: path.join(videoDir, first),
    method: first.includes("-orig.") ? "youtube_auto_subtitles" : "youtube_subtitles",
  };
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
    warnings.push("local transcription source is not implemented yet");
    method = "local_transcription";
  } else {
    const found = await findYoutubeSubtitle(opts.videoDir, opts.sourceLang);
    if (found !== null) {
      sourceFile = found.file;
      method = found.method;
    } else {
      warnings.push(`no ${opts.sourceLang} YouTube subtitle file found`);
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
  source: "auto" | "youtube" | "transcribe" | "file";
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
};

export type RunSubtitlePipelineResult = {
  manifest: SubtitleManifest;
  warnings: string[];
};

export const runSubtitlePipeline = async (
  opts: RunSubtitlePipelineOptions,
): Promise<RunSubtitlePipelineResult> => {
  const { videoDir, subtitle } = opts;
  const mode = subtitle.mode;
  const warnings: string[] = [];
  const mustHaveSubtitles = mode === "burned";

  const subResult = await prepareSourceSubtitle({
    videoDir,
    sourceLang: subtitle.sourceLang,
    targetLang: subtitle.targetLang,
    source: subtitle.source,
    ...(subtitle.file !== undefined ? { file: subtitle.file } : {}),
  });
  warnings.push(...subResult.manifest.warnings);
  let manifest = { ...subResult.manifest };

  if (subResult.sourceSubtitle === undefined) {
    if (mustHaveSubtitles) {
      throw new Error(
        "no English subtitles available. --subtitle-zh burned requires subtitle source. " +
          "Provide subtitles via --subtitle-source file --subtitle-file, or ensure YouTube subtitles are downloaded.",
      );
    }
    return { manifest, warnings };
  }

  const zhSrtPath = path.join(videoDir, "video", "full.zh.srt");
  let hasZhSrt = false;
  try {
    await access(zhSrtPath);
    hasZhSrt = true;
  } catch {
    hasZhSrt = false;
  }

  const hasLlm = opts.llm !== undefined && opts.llmModel !== undefined;

  // Only translate if zh.srt doesn't already exist
  if (!hasZhSrt && hasLlm) {
    try {
      const enSrt = await readFile(subResult.sourceSubtitle, "utf8");
      const zhSrt = await translateSrt(enSrt, {
        llm: opts.llm!,
        model: opts.llmModel!,
        sourceLang: subtitle.sourceLang,
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
    const videoSubdir = path.join(videoDir, "video");
    const names = await readdir(videoSubdir).catch(() => [] as string[]);
    const mp4File = names.find((n) => /\.mp4$/i.test(n));
    if (mp4File !== undefined) {
      const videoId = path.basename(videoDir);
      const videoPath = path.join(videoSubdir, mp4File);

      // Route burned output: if burnedVideoOutDir is set, write to articles/
      // instead of downloads/. Original video stays in downloads.
      const burnedSubdir =
        opts.burnedVideoOutDir !== undefined
          ? path.join(opts.burnedVideoOutDir, videoId, "video")
          : videoSubdir;
      const burnedPath = path.join(burnedSubdir, "full.zh-burned.mp4");

      await mkdir(burnedSubdir, { recursive: true });
      await burnSubtitles({
        videoPath,
        srtPath: zhSrtPath,
        outputPath: burnedPath,
        runner: opts.runner,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      manifest = { ...manifest, burned_video: burnedPath };
    } else {
      warnings.push("no MP4 video file found for subtitle burning");
    }
  }

  // Write final manifest
  await writeManifest(videoDir, { ...manifest, warnings });
  return { manifest: { ...manifest, warnings }, warnings };
};
