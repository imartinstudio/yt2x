import { formatMsToSrtTimestamp } from "./srt-time.js";
import type { DubPlacedLine } from "./types.js";

/**
 * 从最终落点反向生成 zh SRT。
 *
 * 字幕时间戳必须跟配音音频一致，而不是原片字幕——顺延和调速都会让两者分叉。
 * 一条配音句对应一条 cue；显示宽度交给烧录渲染器折行，这里不再按屏宽重切，
 * 否则会把已经对齐好的起止时间拆碎。
 */

export type ReverseSrtCue = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

/** 过滤空文本、校正 end<=start，并保证时间轴单调不重叠。 */
export const buildReverseSrtCues = (lines: readonly DubPlacedLine[]): ReverseSrtCue[] => {
  const cues: ReverseSrtCue[] = [];
  let cursor = 0;

  for (const line of lines) {
    const text = line.text.trim();
    if (text.length === 0) continue;

    let startMs = Math.max(0, Math.round(line.startMs));
    let endMs = Math.max(0, Math.round(line.endMs));
    if (endMs <= startMs) {
      // 零时长 cue 会被烧录完整性检查杀掉；至少给 1ms
      endMs = startMs + Math.max(1, Math.round(line.durationMs) || 1);
    }
    // 与前一条重叠时，把起点推到前一条终点——听感上字幕会略晚，但不会让烧录失败
    if (startMs < cursor) startMs = cursor;
    if (endMs <= startMs) endMs = startMs + 1;

    cues.push({
      index: cues.length + 1,
      startMs,
      endMs,
      text,
    });
    cursor = endMs;
  }

  return cues;
};

export const formatReverseSrt = (lines: readonly DubPlacedLine[]): string => {
  const cues = buildReverseSrtCues(lines);
  if (cues.length === 0) return "";

  const blocks: string[] = [];
  for (const cue of cues) {
    blocks.push(
      String(cue.index),
      `${formatMsToSrtTimestamp(cue.startMs)} --> ${formatMsToSrtTimestamp(cue.endMs)}`,
      cue.text,
      "",
    );
  }
  return blocks.join("\n");
};
