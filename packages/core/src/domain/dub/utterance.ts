import type { TimedWord, Utterance } from "./types.js";

/**
 * 句末标点。允许后面跟收尾的引号或括号——`he said "go."` 的句号在引号里面，
 * 只认行尾标点会整句漏判。
 */
const SENTENCE_FINAL = /[.?!。！？…]["'”’」』)）\]]*$/u;

export type SegmentUtterancesOptions = {
  /**
   * 单个话语单元的时长上限。ASR 偶尔整段不给句末标点（识别不确定时会省略），
   * 没有这道保险丝就会把一大片并成一个合成单位，让某一句的时长误差无处分摊。
   */
  maxDurationMs?: number;
  /** 词数上限，同上，用于停顿也均匀时的兜底。 */
  maxWords?: number;
};

const DEFAULTS = {
  maxDurationMs: 12_000,
  maxWords: 60,
} as const;

/** 在候选词区间里找最宽的词间间隔，作为无标点时的次优断点。 */
const widestPauseIndex = (words: readonly TimedWord[]): number | undefined => {
  let best: { index: number; gap: number } | undefined;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i]!.startMs - words[i - 1]!.endMs;
    if (best === undefined || gap > best.gap) best = { index: i, gap };
  }
  // 间隔全为 0 时没有可用的语音线索，交给调用方走词数兜底
  return best !== undefined && best.gap > 0 ? best.index : undefined;
};

const buildUtterance = (words: readonly TimedWord[], index: number): Utterance => ({
  index,
  startMs: words[0]!.startMs,
  endMs: words[words.length - 1]!.endMs,
  text: words.map((w) => w.word.trim()).join(" "),
  wordCount: words.length,
});

/**
 * 把 ASR 词流切成话语单元（TTS 的合成单位）。
 *
 * 断句依据的优先级：
 *
 * 1. **句末标点** —— 主信号。ASR 会在词上带出标点，实测 2839 词里 143 个以句末
 *    标点结尾，切出约 20 词、6 秒左右一句，正是理想的合成粒度。
 * 2. **最宽词间停顿** —— 超出时长/词数上限时的次优断点。
 * 3. **词数硬切** —— 停顿也均匀时的最后兜底。
 *
 * 刻意**不**以停顿为主信号：实测 faster-whisper 的词级时间戳是连续的，90% 的词间
 * 间隔为 0、最大 720ms，按停顿聚类要么切不开（阈值 800ms 时全片并成一句），要么
 * 切得毫无语义依据（阈值 300ms 时平均 50 词一句）。
 */
export const segmentUtterances = (
  words: readonly TimedWord[],
  options: SegmentUtterancesOptions = {},
): Utterance[] => {
  const maxDurationMs = options.maxDurationMs ?? DEFAULTS.maxDurationMs;
  const maxWords = options.maxWords ?? DEFAULTS.maxWords;

  const usable = words.filter((w) => w.word.trim().length > 0);
  if (usable.length === 0) return [];

  const out: Utterance[] = [];
  let current: TimedWord[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    out.push(buildUtterance(current, out.length + 1));
    current = [];
  };

  for (const word of usable) {
    current.push(word);

    if (SENTENCE_FINAL.test(word.word.trim())) {
      flush();
      continue;
    }

    const tooLong = word.endMs - current[0]!.startMs > maxDurationMs;
    const tooMany = current.length >= maxWords;
    if (!tooLong && !tooMany) continue;

    // 超限：优先切在最宽的换气点，其次整段收掉
    const at = widestPauseIndex(current);
    if (at !== undefined) {
      const head = current.slice(0, at);
      const tail = current.slice(at);
      current = head;
      flush();
      current = tail;
    } else {
      flush();
    }
  }
  flush();

  return out;
};
