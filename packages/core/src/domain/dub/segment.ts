import type { DubCue, DubSegment } from "./types.js";

/**
 * SRT 时间戳 <-> 毫秒。
 *
 * 接受 "HH:MM:SS,mmm" 和 "MM:SS,mmm" 两种写法，小数点分隔符 `,` / `.` 都认——
 * parseSubtitleBlocks 已经会把外部字幕规整成前者，但本地转写和第三方字幕文件
 * 两种都出现过，在这里兜住比在四个调用点各写一遍强。
 */
export const parseSrtTimestampToMs = (ts: string): number => {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*$/u.exec(ts);
  if (m === null) return Number.NaN;
  const hours = m[1] !== undefined ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  // "500" 是 500ms，"5" 是 500ms —— 右侧补零到三位，不能直接 Number()
  const millis = Number(m[4]!.padEnd(3, "0"));
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
};

export const formatMsToSrtTimestamp = (ms: number): string => {
  const clamped = Math.max(0, Math.round(ms));
  const millis = clamped % 1000;
  const totalSeconds = (clamped - millis) / 1000;
  const seconds = totalSeconds % 60;
  const totalMinutes = (totalSeconds - seconds) / 60;
  const minutes = totalMinutes % 60;
  const hours = (totalMinutes - minutes) / 60;
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
};

/**
 * 句末标点。命中即断句，这是最可靠的信号。
 *
 * 收尾的引号/括号要连弯引号一起认：中文 LLM 译文里 `他说“好。”` 这种写法极常见，
 * 只认直引号会让这句漏判、继续往后合并。漏判不会出错（有 maxGapMs 和字数上限兜底），
 * 但会白白劣化断句质量。
 */
const SENTENCE_FINAL = /[。！？!?…]["'”’』」）)]*$/u;

/**
 * 拼接两段文本时，只在"拉丁字母/数字 紧挨 拉丁字母/数字"的边界补空格。
 *
 * 中文之间补空格会让 TTS 读出停顿；但字幕经常把一个英文词组切在两条里
 * （"使用 Claude" + "Code 来做"），不补空格会粘成 "ClaudeCode"，TTS 会当成
 * 一个生造词念错。只有边界两侧都是 ASCII 词字符时才需要空格。
 */
const joinText = (left: string, right: string): string => {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const needsSpace = /[A-Za-z0-9]$/u.test(left) && /^[A-Za-z0-9]/u.test(right);
  return needsSpace ? `${left} ${right}` : left + right;
};

export type MergeCuesOptions = {
  /**
   * 单句最长时长。超过就断，避免一个长段落被合成一整块——那会让某一句的
   * 时长误差无处分摊，也让 LLM 改写时更容易漏信息。
   */
  maxDurationMs?: number;
  /** 单句最多字符数，同上。 */
  maxChars?: number;
  /**
   * 相邻字幕间隔超过这个值就断句。
   *
   * 这是没有标点时的主力信号：YouTube 自动字幕常常整片零标点，而
   * srt-translator 保持 1:1 映射、不会凭空补标点，所以不能只靠 SENTENCE_FINAL。
   * 说话人换气的停顿正好是天然的断句点。
   */
  maxGapMs?: number;
};

const DEFAULTS = {
  maxDurationMs: 12_000,
  maxChars: 60,
  maxGapMs: 700,
} as const;

/**
 * 把按屏宽切分的字幕条合并成自然句。
 *
 * 断句优先级：句末标点 > 间隔超阈值 > 时长/字数超上限。前两个是"语义边界"，
 * 第三个是纯粹的保险丝。
 */
export const mergeCuesIntoSegments = (
  cues: readonly DubCue[],
  options: MergeCuesOptions = {},
): DubSegment[] => {
  const maxDurationMs = options.maxDurationMs ?? DEFAULTS.maxDurationMs;
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  const maxGapMs = options.maxGapMs ?? DEFAULTS.maxGapMs;

  const usable = cues.filter((c) => c.text.trim().length > 0);
  if (usable.length === 0) return [];

  const segments: DubSegment[] = [];
  let current: { startMs: number; endMs: number; cueIndices: number[]; text: string } | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    segments.push({
      index: segments.length + 1,
      startMs: current.startMs,
      endMs: current.endMs,
      cueIndices: current.cueIndices,
      text: current.text,
    });
    current = undefined;
  };

  for (const cue of usable) {
    const text = cue.text.trim();
    if (current === undefined) {
      current = { startMs: cue.startMs, endMs: cue.endMs, cueIndices: [cue.index], text };
    } else {
      const gap = cue.startMs - current.endMs;
      const merged = joinText(current.text, text);
      const wouldOverflow =
        cue.endMs - current.startMs > maxDurationMs || merged.length > maxChars;
      if (gap > maxGapMs || wouldOverflow) {
        flush();
        current = { startMs: cue.startMs, endMs: cue.endMs, cueIndices: [cue.index], text };
      } else {
        current.endMs = cue.endMs;
        current.cueIndices.push(cue.index);
        current.text = merged;
      }
    }
    // 句末标点是最强信号，命中就立即收句，不受字数/时长上限影响
    if (SENTENCE_FINAL.test(text)) flush();
  }
  flush();

  return segments;
};
