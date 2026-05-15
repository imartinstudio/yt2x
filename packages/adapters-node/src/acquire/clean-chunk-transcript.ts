export type TranscriptChunk = { index: number; word_count: number; text: string };

const TIMESTAMP_RE =
  /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3}\s*-->\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3}.*$/;
const INLINE_TIMESTAMP_RE = /\b(?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3}\b/g;
const TAG_RE = /<[^>]+>/g;
const BRACKET_NOISE_RE =
  /^\s*(?:\[(?:music|applause|laughter|laughs|intro|outro|silence|inaudible|foreign)\]|\((?:music|applause|laughter|laughs|intro|outro|silence|inaudible|foreign)\))\s*$/i;

const normalizeLine = (line: string): string => {
  let l = line.replace(/\ufeff/g, "").trim();
  l = l
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  l = l.replace(TAG_RE, "");
  l = l.replace(INLINE_TIMESTAMP_RE, "");
  l = l.replace(/\s+/g, " ").trim();
  return l;
};

export const cleanTranscriptLines = (text: string): string[] => {
  const cleaned: string[] = [];
  let previous = "";

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line.toUpperCase() === "WEBVTT" || line.toUpperCase() === "VTT") {
      continue;
    }
    if (/^\d+$/.test(line)) {
      continue;
    }
    if (TIMESTAMP_RE.test(line)) {
      continue;
    }
    if (line.startsWith("NOTE ") || line.startsWith("STYLE") || line.startsWith("REGION")) {
      continue;
    }

    const normalized = normalizeLine(line);
    if (!normalized || BRACKET_NOISE_RE.test(normalized)) {
      continue;
    }
    if (normalized === previous) {
      continue;
    }
    cleaned.push(normalized);
    previous = normalized;
  }

  return cleaned;
};

export const buildParagraphs = (lines: string[], maxWords = 120): string[] => {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let count = 0;

  for (const line of lines) {
    const words = line.split(/\s+/).filter(Boolean);
    const startsNew = /^(#+\s+|\d+[.)]\s+|[-*]\s+)/.test(line);
    if (current.length > 0 && (startsNew || count + words.length > maxWords)) {
      paragraphs.push(current.join(" ").trim());
      current = [];
      count = 0;
    }
    current.push(line);
    count += words.length;
  }

  if (current.length > 0) {
    paragraphs.push(current.join(" ").trim());
  }
  return paragraphs;
};

export const chunkParagraphs = (paragraphs: string[], maxWords: number): TranscriptChunk[] => {
  const chunks: TranscriptChunk[] = [];
  let current: string[] = [];
  let count = 0;

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (current.length > 0 && count + words.length > maxWords) {
      chunks.push({
        index: chunks.length + 1,
        word_count: count,
        text: current.join("\n\n"),
      });
      current = [];
      count = 0;
    }
    current.push(paragraph);
    count += words.length;
  }

  if (current.length > 0) {
    chunks.push({
      index: chunks.length + 1,
      word_count: count,
      text: current.join("\n\n"),
    });
  }
  return chunks;
};

export const chunksToMarkdown = (chunks: TranscriptChunk[]): string => {
  const parts = ["# Cleaned Transcript Chunks", ""];
  for (const chunk of chunks) {
    parts.push(`## Chunk ${chunk.index} (${chunk.word_count} words)`);
    parts.push("");
    parts.push(chunk.text);
    parts.push("");
  }
  return `${parts.join("\n").trim()}\n`;
};

/** 从字幕/转录文本生成 chunks markdown（与 `clean_chunk_transcript.py` 对齐）。 */
export const transcriptToChunksMarkdown = (
  text: string,
  maxWords: number,
  paragraphWords = 120,
): string => {
  if (maxWords < 100) {
    throw new Error("--max-words must be at least 100");
  }
  if (paragraphWords < 20) {
    throw new Error("--paragraph-words must be at least 20");
  }
  const lines = cleanTranscriptLines(text);
  const paragraphs = buildParagraphs(lines, paragraphWords);
  const chunks = chunkParagraphs(paragraphs, maxWords);
  return chunksToMarkdown(chunks);
};
