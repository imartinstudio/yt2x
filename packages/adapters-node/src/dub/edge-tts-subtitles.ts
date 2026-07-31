import { parseSrtTimestampToMs, type TtsSpeechCue, type TtsSpeechTiming } from "@yt2x/core";

/**
 * 解析 edge-tts `--write-subtitles` 输出。
 *
 * 实测格式是 SRT 风格（序号 + `HH:MM:SS,mmm --> HH:MM:SS,mmm` + 文本），
 * 不是 WebVTT。第一条 cue 的起点就是引擎前置 padding 的确切值。
 */

const CUE_RANGE_RE =
  /^(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*$/u;

export const parseEdgeTtsSubtitles = (content: string): TtsSpeechTiming => {
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  const cues: TtsSpeechCue[] = [];

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!.trim();
    if (raw.length === 0 || /^\d+$/u.test(raw) || raw === "WEBVTT") {
      i += 1;
      continue;
    }
    const match = CUE_RANGE_RE.exec(raw);
    if (match === null) {
      i += 1;
      continue;
    }
    const startMs = parseSrtTimestampToMs(match[1]!);
    const endMs = parseSrtTimestampToMs(match[2]!);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error(
        `edge-tts subtitles contain an invalid cue range: ${raw} (${startMs}->${endMs})`,
      );
    }
    i += 1;
    const textLines: string[] = [];
    while (i < lines.length && lines[i]!.trim().length > 0) {
      textLines.push(lines[i]!.trim());
      i += 1;
    }
    const text = textLines.join("\n");
    cues.push(text.length > 0 ? { startMs, endMs, text } : { startMs, endMs });
  }

  if (cues.length === 0) {
    throw new Error("edge-tts subtitles contain no usable cue");
  }

  const speechStartMs = cues[0]!.startMs;
  const speechEndMs = cues[cues.length - 1]!.endMs;
  if (speechEndMs <= speechStartMs) {
    throw new Error(
      `edge-tts speech timing is inverted: start=${speechStartMs} end=${speechEndMs}`,
    );
  }

  return {
    speechStartMs,
    speechEndMs,
    speechDurationMs: speechEndMs - speechStartMs,
    cues,
  };
};
