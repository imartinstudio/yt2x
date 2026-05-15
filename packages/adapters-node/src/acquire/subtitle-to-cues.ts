export type SubtitleCue = { start: string; end: string; text: string };

const TIMING_RE =
  /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})/;
const TAG_RE = /<[^>]+>/g;
const INLINE_TS_RE = /\b(?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3}\b/g;

export const normalizeTimestamp = (value: string): string => {
  const v = value.replace(",", ".");
  const parts = v.split(":");
  if (parts.length === 2) {
    return `00:${parts[0]!.padStart(2, "0")}:${parts[1]!}`;
  }
  if (parts.length === 3) {
    return `${parts[0]!.padStart(2, "0")}:${parts[1]!.padStart(2, "0")}:${parts[2]!}`;
  }
  return v;
};

export const cleanCueText = (text: string): string => {
  let t = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  t = t.replace(TAG_RE, "");
  t = t.replace(INLINE_TS_RE, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
};

/** 解析 VTT/SRT 为 cue 列表（与 `subtitle_to_cues.py` 对齐）。 */
export const parseSubtitleCues = (text: string): SubtitleCue[] => {
  const cues: SubtitleCue[] = [];
  let currentStart = "";
  let currentEnd = "";
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentStart && currentLines.length > 0) {
      const cleaned = cleanCueText(currentLines.join(" "));
      if (cleaned && (cues.length === 0 || cues[cues.length - 1]!.text !== cleaned)) {
        cues.push({ start: currentStart, end: currentEnd, text: cleaned });
      }
    }
    currentStart = "";
    currentEnd = "";
    currentLines = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.toUpperCase() === "WEBVTT" || line.toUpperCase() === "VTT") {
      continue;
    }
    if (/^\d+$/.test(line)) {
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
    if (timing) {
      flush();
      currentStart = normalizeTimestamp(timing[1]!);
      currentEnd = normalizeTimestamp(timing[2]!);
      continue;
    }
    if (currentStart) {
      currentLines.push(line);
    }
  }

  flush();
  return cues;
};

export const cuesToMarkdown = (cues: SubtitleCue[]): string => {
  const parts = ["# Timestamped Subtitle Cues", ""];
  for (const cue of cues) {
    parts.push(`- \`${cue.start}\` - \`${cue.end}\`: ${cue.text}`);
  }
  return `${parts.join("\n")}\n`;
};
