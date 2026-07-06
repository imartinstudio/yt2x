import { mkdir, readFile, readdir, stat, symlink } from "node:fs/promises";
import path from "node:path";
import {
  buildDeconstructUserPrompt,
  DECONSTRUCT_SYSTEM_PROMPT,
  DeconstructLlmOutputSchema,
  type DeconstructInput,
  type DeconstructLlmOutput,
  type LlmPort,
  type SectionCandidate,
  estimateTokenCount,
  checkTokenBudget,
} from "@yt2x/core";

export type RunDeconstructInput = {
  llm: LlmPort;
  model: string;
  articleDir: string;
  signal?: AbortSignal;
};

export type RunDeconstructResult = {
  candidates: DeconstructLlmOutput;
  input: DeconstructInput;
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  durationMs: number;
};

/**
 * 读取 article dir 中的输入产物，准备给 LLM 的 deconstruct input。
 */
export const readDeconstructArtifacts = async (
  articleDir: string,
): Promise<DeconstructInput> => {
  const resolved = path.resolve(articleDir);
  const videoId = path.basename(resolved);

  // Read article.md
  const articlePath = path.join(resolved, "article.md");
  let articleMd: string;
  try {
    articleMd = await readFile(articlePath, "utf8");
  } catch {
    throw new Error(`article.md not found in ${resolved}. Run yt2x article first.`);
  }

  // Read SRT — try full.zh.srt first, then full.srt
  // Look in article video dir first, then fall back to downloads video dir.
  const videoDir = path.join(resolved, "video");
  const downloadVideoDir = path.join(
    path.dirname(path.dirname(resolved)),
    "downloads",
    videoId,
    "video",
  );
  const tryReadSrt = async (dir: string): Promise<{ path: string; content: string } | null> => {
    for (const name of ["full.zh.srt", "full.srt"]) {
      const p = path.join(dir, name);
      try {
        return { path: p, content: await readFile(p, "utf8") };
      } catch {
        continue;
      }
    }
    return null;
  };

  const srtResult = (await tryReadSrt(videoDir)) ?? (await tryReadSrt(downloadVideoDir));
  if (srtResult === null) {
    throw new Error(
      `No SRT subtitle found in ${videoDir}/ or ${downloadVideoDir}/. Run the subtitle pipeline first.`,
    );
  }
  const srtContent = srtResult.content;

  // Find video file — prefer burned, fallback to clip
  let videoPath: string;
  const videoFiles = ["full.zh-burned.mp4", "full.mp4", "clip.mp4"];
  let found: string | null = null;
  for (const vf of videoFiles) {
    const p = path.join(videoDir, vf);
    try {
      await stat(p);
      found = p;
      break;
    } catch {
      continue;
    }
  }
  if (found === null) {
    // Auto-link video from downloads directory.
    // When no subtitle burning is needed, the article/video/ dir may only
    // contain SRT files — the actual MP4 lives in downloads/<videoId>/video/.
    // Create a symlink instead of copying to save disk space.
    const downloadVideoDir = path.join(
      path.dirname(path.dirname(resolved)),
      "downloads",
      videoId,
      "video",
    );
    let linkedPath: string | null = null;
    for (const vf of videoFiles) {
      const src = path.join(downloadVideoDir, vf);
      try {
        await stat(src);
        await mkdir(videoDir, { recursive: true });
        const dest = path.join(videoDir, vf);
        await symlink(src, dest);
        linkedPath = dest;
        break;
      } catch {
        continue;
      }
    }
    if (linkedPath === null) {
      // Fallback: scan article video directory for any mp4/mkv
      const files = await readdir(videoDir);
      const mediaFile = files.find((f) => /\.(mp4|mkv|webm)$/i.test(f));
      if (mediaFile === undefined) {
        throw new Error(
          `No video file found in ${videoDir}/ or ${downloadVideoDir}/. Cannot cut clips without a video source.`,
        );
      }
      videoPath = path.join(videoDir, mediaFile);
    } else {
      videoPath = linkedPath;
    }
  } else {
    videoPath = found;
  }

  // Get video duration via ffprobe metadata (quick stat)
  let durationSec = 0;
  try {
    const run = await import("../process/runner.js").then((m) => m.defaultProcessRunner);
    const result = await run.run({
      command: "ffprobe",
      args: ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath],
      timeoutMs: 10_000,
    });
    durationSec = Math.round(parseFloat(result.stdout.trim()));
  } catch {
    // Non-critical: duration defaults to 0
  }

  return {
    articleDir: resolved,
    articleMd,
    srtContent,
    videoPath,
    videoId,
    durationSec,
  } as DeconstructInput;
};

/**
 * 调用 LLM 执行章节拆解，校验输出，返回结构化结果。
 */
export const runDeconstruct = async (
  input: RunDeconstructInput,
): Promise<RunDeconstructResult> => {
  const artifacts = await readDeconstructArtifacts(input.articleDir);

  // We don't have video title easily from article dir, try to extract from article.md
  const titleMatch = artifacts.articleMd.match(/^#\s+(.+)$/m);
  const videoTitle = titleMatch?.[1] ?? undefined;

  // Condense SRT from ~40K tokens down to ~4-6K tokens (saves ~85%)
  const condensedSrt = condenseSrtContent(artifacts.srtContent);
  const userPrompt = buildDeconstructUserPrompt({
    articleMd: artifacts.articleMd,
    srtContent: condensedSrt,
    videoTitle,
    videoDurationSec: artifacts.durationSec,
  });

  // Pre-flight token budget check
  const estimatedTokens = estimateTokenCount(DECONSTRUCT_SYSTEM_PROMPT) + estimateTokenCount(userPrompt);
  const budgetWarning = checkTokenBudget(estimatedTokens, input.model);
  if (budgetWarning !== null) {
    // Log warning but don't block — LLM may still handle it
    console.warn(`⚠️  ${budgetWarning.message}`);
  }

  const t0 = Date.now();
  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: DECONSTRUCT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    maxTokens: 8192,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const parsed = parseDeconstructLlmOutput(resp.content);
  const result: RunDeconstructResult = {
    candidates: parsed,
    input: artifacts,
    model: resp.model,
    finishReason: resp.finishReason,
    durationMs: Date.now() - t0,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};

const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const stripJsonFenceWrapper = (s: string): string => {
  const m = s.match(JSON_FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};

/**
 * 解析并验证 LLM 返回的章节拆解 JSON。
 * Pre-processes null fields for skipped sections into valid defaults before Zod validation.
 */
export const parseDeconstructLlmOutput = (raw: string): DeconstructLlmOutput => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFenceWrapper(raw.trim()));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Deconstruct LLM response is not valid JSON: ${message}`);
  }

  // Pre-process: fill null/default values for skipped sections so Zod validation passes
  if (parsed != null && typeof parsed === "object" && "sections" in parsed && Array.isArray((parsed as Record<string, unknown>).sections)) {
    const arr = (parsed as Record<string, unknown>).sections as Array<Record<string, unknown>>;
    for (const s of arr) {
      if (s.title === null || s.title === undefined) s.title = "未命名";
      if (s.summary === null || s.summary === undefined) s.summary = "";
      if (s.article_section === null || s.article_section === undefined) s.article_section = "";
      if (s.angle === null || s.angle === undefined) s.angle = "discussion";
      if (s.risk === null || s.risk === undefined) s.risk = "low";
      if (s.timecodes === null || s.timecodes === undefined) {
        s.timecodes = { start: "00:00:00,000", end: "00:00:00,000", startSec: 0, endSec: 0, durationSec: 0 };
      }
      if (s.scores === null || s.scores === undefined) {
        s.scores = { counter_intuitiveness: 1, shareability: 1, practical_value: 1, visual_appeal: 1, composite: 1.0 };
      }
      if (s.key_quote === null || s.key_quote === undefined) s.key_quote = "";
      if (s.video_script === null || s.video_script === undefined) s.video_script = "";
    }
  }

  const result = DeconstructLlmOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Deconstruct LLM response does not match expected schema: ${result.error.message}`,
    );
  }

  // Assign unique IDs
  const seen = new Set<string>();
  for (let i = 0; i < result.data.sections.length; i++) {
    const s = result.data.sections[i]!;
    if (seen.has(s.id)) {
      s.id = `section-${i + 1}`;
    }
    seen.add(s.id);
  }

  return result.data;
};

/** Filter out sections with skip_reason or invalid timecodes. Oversized sections are split in a prior step. */
export const filterValidSections = (
  output: DeconstructLlmOutput,
): DeconstructLlmOutput => {
  const MAX_CLIP_DURATION_SEC = 180; // hard limit: no clip may exceed 3 minutes
  const valid = output.sections.filter((s) => {
    // Skip sections the LLM explicitly marked as having no video content
    if (s.skip_reason != null) return false;
    const dur = s.timecodes.durationSec;
    return dur > 0 && dur <= MAX_CLIP_DURATION_SEC && s.timecodes.startSec >= 0 && s.timecodes.endSec > s.timecodes.startSec;
  });
  return { sections: valid };
};

/**
 * Split oversized sections (> maxDurationSec) into sub-sections aligned to SRT sentence boundaries.
 * Returns a new DeconstructLlmOutput with oversized sections replaced by their sub-sections.
 */
export const splitOversizedSections = (
  output: DeconstructLlmOutput,
  srtContent: string,
  maxDurationSec = 180,
): DeconstructLlmOutput => {
  const srt = parseSrt(srtContent);
  if (srt.length === 0) return output;

  const newSections: SectionCandidate[] = [];

  for (const section of output.sections) {
    if (section.skip_reason != null) {
      newSections.push(section);
      continue;
    }

    const dur = section.timecodes.durationSec;
    if (dur <= maxDurationSec) {
      newSections.push(section);
      continue;
    }

    // Need to split this section into N roughly-equal sub-sections
    const parts = Math.ceil(dur / maxDurationSec);
    const targetDur = dur / parts;

    // Find SRT entries within this section's time range
    const sectionSrts = srt.filter(
      (e) => e.startSec >= section.timecodes.startSec && e.endSec <= section.timecodes.endSec,
    );

    if (sectionSrts.length < parts * 2) {
      // Not enough SRT data to split cleanly — just do equal time split
      for (let i = 0; i < parts; i++) {
        const subStart = section.timecodes.startSec + i * targetDur;
        const subEnd = i === parts - 1 ? section.timecodes.endSec : section.timecodes.startSec + (i + 1) * targetDur;
        newSections.push(makeSubSection(section, i, parts, subStart, subEnd));
      }
      continue;
    }

    // Find best split points at SRT sentence boundaries
    const splitPoints: number[] = [section.timecodes.startSec];
    for (let p = 1; p < parts; p++) {
      const idealSplit = section.timecodes.startSec + p * targetDur;
      // Find the SRT entry boundary closest to idealSplit
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let j = 1; j < sectionSrts.length - 1; j++) {
        const entry = sectionSrts[j]!;
        const dist = Math.abs(entry.endSec - idealSplit);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = j;
        }
      }
      splitPoints.push(sectionSrts[bestIdx]!.endSec);
    }
    splitPoints.push(section.timecodes.endSec);

    // Create sub-sections
    for (let i = 0; i < parts; i++) {
      const subStart = splitPoints[i]!;
      const subEnd = splitPoints[i + 1]!;
      newSections.push(makeSubSection(section, i, parts, subStart, subEnd));
    }
  }

  return { sections: newSections };
};

/** Create a sub-section with derived id and timecodes from a parent section */
const makeSubSection = (
  parent: SectionCandidate,
  index: number,
  total: number,
  startSec: number,
  endSec: number,
): SectionCandidate => {
  const partLabel = total > 1 ? ` (${index + 1}/${total})` : "";
  return {
    ...parent,
    id: `${parent.id}-part${index + 1}`,
    title: `${parent.title}${partLabel}`,
    timecodes: {
      start: secondsToSrtTimecode(startSec),
      end: secondsToSrtTimecode(endSec),
      startSec: Math.round(startSec),
      endSec: Math.round(endSec),
      durationSec: Math.round(endSec - startSec),
    },
  };
};

/** 粗略适配时间码 → 文件名用 slug */
export const toSlug = (title: string): string => {
  return title
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
};

/** 给 SectionCandidate 生成视频文件名 */
export const candidateVideoFilename = (c: SectionCandidate): string => {
  const slug = toSlug(c.title);
  const idx = c.id.replace("section-", "candidate-");
  return `${idx}-${slug}.mp4`;
};

/** SRT 时间码（HH:MM:SS,mmm）转为秒数 */
export const timecodeToSeconds = (tc: string): number => {
  const parts = tc.split(/[:,]/);
  if (parts.length === 4) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) + Number(parts[3]) / 1000;
  }
  return 0;
};

/** 秒数转为 ffmpeg 可用的时间码（HH:MM:SS） */
export const secondsToTimecode = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s2 = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}`;
};

/** 句子结束标点 */
const SENTENCE_ENDS = /[。？！.?!\n]$/;

/** SRT 条目结构 */
type SrtEntry = { index: number; startSec: number; endSec: number; text: string };

/**
 * 将 SRT 文本解析为结构化条目。
 */
export const parseSrt = (srtContent: string): SrtEntry[] => {
  const blocks = srtContent.trim().split(/\n\n+/);
  const entries: SrtEntry[] = [];
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;
    const index = parseInt(lines[0]!, 10);
    if (isNaN(index)) continue;
    const tcMatch = lines[1]!.match(
      /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/,
    );
    if (!tcMatch) continue;
    const startSec =
      Number(tcMatch[1]) * 3600 +
      Number(tcMatch[2]) * 60 +
      Number(tcMatch[3]) +
      Number(tcMatch[4]) / 1000;
    const endSec =
      Number(tcMatch[5]) * 3600 +
      Number(tcMatch[6]) * 60 +
      Number(tcMatch[7]) +
      Number(tcMatch[8]) / 1000;
    const text = lines.slice(2).join(" ");
    entries.push({ index, startSec, endSec, text });
  }
  return entries;
};

/**
 * 将完整 SRT 浓缩为轻量时间戳索引。
 *
 * 全量 SRT 可能有数万行（45 分钟 ≈ 4700 条），全部发给 LLM 会浪费大量 token。
 * 浓缩后每约 8-12 秒输出一行带精确时间码的代表性文本，
 * 将 ~40K token 的 SRT 降至 ~4-6K token，节省约 85%。
 *
 * LLM 拿到索引后可以：
 * 1. 定位章节边界（通过时间码附近的关键词）
 * 2. 估算起止秒数
 * 3. 提取代表性原文作为 key_quote 候选
 *
 * 精确的结束时间码校验由 validateClipEndings 用全量 SRT 在 LLM 返回后完成。
 */
export const condenseSrtContent = (srtContent: string, windowSec = 10): string => {
  const entries = parseSrt(srtContent);
  if (entries.length === 0) return srtContent;

  const lines: string[] = [];
  let nextSampleSec = entries[0]!.startSec;
  let lastIndex = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.startSec >= nextSampleSec) {
      // Collect nearby entries for context
      const nearby = entries
        .slice(Math.max(lastIndex, i - 1), Math.min(i + 2, entries.length))
        .map((e) => e.text)
        .join(" ");
      const ts = secondsToSrtTimecode(entry.startSec);
      lines.push(`[${ts}] ${nearby}`);
      nextSampleSec = entry.startSec + windowSec;
      lastIndex = i;
    }
  }

  // Always include the very last entry
  const last = entries[entries.length - 1]!;
  if (last.startSec >= nextSampleSec - windowSec) {
    const ts = secondsToSrtTimecode(last.startSec);
    lines.push(`[${ts}] ${last.text}`);
  }

  return lines.join("\n");
};

/** 秒数 → SRT 时间码 (HH:MM:SS,mmm) */
export const secondsToSrtTimecode = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
};

/**
 * 校验候选片段的结束时间是否对齐 SRT 的自然句子边界。
 * 返回警告列表（非 null 条目表示有问题）。
 */
export const validateClipEndings = (
  sections: SectionCandidate[],
  srtContent: string,
): Array<{ id: string; title: string; endSec: number; warning: string }> => {
  const srt = parseSrt(srtContent);
  if (srt.length === 0) return [];

  const warnings: Array<{ id: string; title: string; endSec: number; warning: string }> = [];

  for (const section of sections) {
    const endSec = section.timecodes.endSec;

    // Find the SRT entry that covers endSec
    const coveringEntry = srt.find(
      (e) => e.startSec <= endSec && e.endSec >= endSec,
    );
    if (!coveringEntry) continue;

    // Check if endSec is near the END of that SRT entry (within 1s tolerance)
    const gap = coveringEntry.endSec - endSec;
    const lastText = coveringEntry.text.trim();

    if (gap > 1.5) {
      // endSec is in the middle of a subtitle entry — likely mid-speech
      warnings.push({
        id: section.id,
        title: section.title,
        endSec,
        warning: `结束时间(${endSec}s)在字幕条目 #${coveringEntry.index} 中间(条目结束于${coveringEntry.endSec}s)。考虑延长到 ${Math.ceil(coveringEntry.endSec)}s。`,
      });
    } else if (!SENTENCE_ENDS.test(lastText.slice(-1))) {
      // End of subtitle entry but sentence doesn't end — likely incomplete thought
      warnings.push({
        id: section.id,
        title: section.title,
        endSec,
        warning: `字幕条目 #${coveringEntry.index} 不以结束标点结尾: "${lastText.slice(-30)}"。可能句子未说完。`,
      });
    }
  }

  return warnings;
};
