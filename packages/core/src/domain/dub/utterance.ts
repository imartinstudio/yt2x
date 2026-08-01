import type { TimedWord, Utterance } from "./types.js";

/**
 * 句末标点。允许后面跟收尾的引号或括号——`he said "go."` 的句号在引号里面，
 * 只认行尾标点会整句漏判。
 */
const SENTENCE_FINAL = /[.?!。！？…]["'”’」』)）\]]*$/u;

export type SegmentUtterancesOptions = {
  /**
   * 单个话语单元的时长上限，双重角色：
   *
   * 1. **保险丝**——ASR 偶尔整段不给句末标点（识别不确定时会省略），没有这道防线
   *    会把一大片并成一个合成单位，让某一句的时长误差无处分摊；
   * 2. **主动控制槽位落进中文填充甜区**（PR4 第二批新增角色）。真实全片实测按
   *    原句槽位分组的中文填充率：0–4s 96%、4–8s 91%、8–12s 81%、12s+ 67%——
   *    时长越长，念完之后剩的死寂越多，因为固定时长的槽位是从源语音时间戳锁死的，
   *    译文按预算凝练后念完就没词了，剩下的只能是沉默或靠 `stretch` 拉长语速填。
   *    调小这个阈值会让更多长句在最宽的词间停顿（换气点）处被提前切开，每段各自
   *    拿到自己的时长预算，槽位更容易落进短槽位那种接近满填的甜区。
   *
   *    真实全片（807.7s、111 句）三组阈值实测对比（`minDurationMs` 恒为 3000）：
   *
   *    | maxDurationMs | 话语单元数 | 总静默 | 静默占比 | 译文总字数 |
   *    | ------------- | ---------- | ------ | -------- | ---------- |
   *    | 12000（旧默认） | 111        | 116.5s | 14.4%    | 2685       |
   *    | 8000（当前默认）| 121        | 86.6s  | 10.7%    | 2863       |
   *    | 6000           | 131        | 112.2s | 13.9%    | 2587       |
   *
   *    6000 比 8000 切得更碎，但总静默反而更高：每次切分都让新单元重新支付一次中文
   *    TTS 的固定合成开销（约 1873ms），单元数从 121 涨到 131 后，这份固定开销被
   *    多付的次数超过了单句静默缩短带来的收益，抵消了拆分的收益。8000 是两头都不
   *    亏的折中点：比 12000 少 26% 总静默，字数不降反升（凝练空间更松），比 6000
   *    每句能拿到的翻译预算更宽松。取 8000 而非两者之间再细调，是因为三点已经
   *    勾出一个明显的单峰分布，边际收益不足以再多跑一轮全片实测去调优。
   */
  maxDurationMs?: number;
  /** 词数上限，同上，用于停顿也均匀时的兜底。 */
  maxWords?: number;
  /**
   * 话语单元的最短时长；短于它的单元并入相邻单元。不设则不合并。
   *
   * 存在的理由是中文 TTS 有固定开销：实测「时长 ≈ 固定开销 + 每字成本 × 字数」，
   * 所以可用时长低于固定开销的单元，译文再短也塞不进去。与其把这些必然溢出的
   * 单元交给时长协商，不如在切分阶段就并掉。
   *
   * 固定开销随音色标定，见 `translate-prompts.ts` 的 `TTS_FIXED_OVERHEAD_MS`。
   * 当前值（`zh-CN-YunjianNeural`，1132ms）下，真实全片（181 句、`maxDurationMs`
   * 8000ms、未合并前）8.8% 的单元落在这条线以下；旧音色标定（`zh-CN-YunxiNeural`，
   * 1873ms）同一批数据下这个比例是 19.3%——固定开销降低后这一类"结构性塞不进"
   * 的单元反而变少了，但不为零，仍需要这层合并兜底。
   */
  minDurationMs?: number;
};

const DEFAULTS = {
  /** 见上面 `SegmentUtterancesOptions.maxDurationMs` 的实测对比表；8000 是三组阈值里总静默最低的。 */
  maxDurationMs: 8_000,
  maxWords: 60,
} as const;

/**
 * 合并短单元时允许的时长上限，与 `maxDurationMs`（切分阈值）刻意分开。
 *
 * `maxDurationMs` 调低后（见上面的说明）会主动切开更多长句，切出的收尾碎片往往
 * 不到 `minDurationMs`——如果合并时仍然用同一个（已经调低的）`maxDurationMs`
 * 当上限，碎片常常连去哪边都并不进去，被晾在原地，译文预算被 clamp 到一两个字，
 * 正是要根治的问题。真实全片实测：`maxDurationMs=6000` 时用同一个阈值当合并上限，
 * 175 个话语单元里有 40 个（23%）合并失败、仍短于 3000ms 的下限；分开两个阈值、
 * 合并上限固定在 12000ms 后，全部并入相邻单元，0 个漏网。
 *
 * 取 12000 是因为它是这条流水线一直以来验证过的「单个合成单位可接受的时长上限」
 * （旧的 `maxDurationMs` 默认值）——合并出的单元即使达到这个量级，下游时长协商也
 * 有能力吸收，不是没见过的新情况。
 */
const MERGE_DURATION_CEILING_MS = 12_000;

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

/**
 * 把短于下限的单元并进相邻单元。
 *
 * 选边的依据是**间隔更小的那一侧**——间隔小说明说话人没有换气，本来就是连着说的，
 * 并过去最贴近原本的语流。合并后超出 `mergeCapMs` 则不并：让一个单元过长，比让它
 * 必然溢出更糟，那种情况留给时长协商处理。
 *
 * `mergeCapMs` 刻意不是调用方传入的切分阈值本身，见调用处 `MERGE_DURATION_CEILING_MS`
 * 的注释——两者共用一个值会在切分阈值调低时把合并卡死。
 */
const mergeShortUtterances = (
  groups: TimedWord[][],
  minDurationMs: number,
  mergeCapMs: number,
): TimedWord[][] => {
  if (minDurationMs <= 0) return groups;

  const out = groups.map((g) => [...g]);
  const durationOf = (g: readonly TimedWord[]): number =>
    g[g.length - 1]!.endMs - g[0]!.startMs;
  const spanOf = (a: readonly TimedWord[], b: readonly TimedWord[]): number =>
    b[b.length - 1]!.endMs - a[0]!.startMs;

  for (let i = 0; i < out.length; i++) {
    if (out.length === 1) break;
    if (durationOf(out[i]!) >= minDurationMs) continue;

    const prev = i > 0 ? out[i - 1] : undefined;
    const next = i + 1 < out.length ? out[i + 1] : undefined;
    const gapPrev =
      prev !== undefined ? out[i]![0]!.startMs - prev[prev.length - 1]!.endMs : Infinity;
    const gapNext =
      next !== undefined ? next[0]!.startMs - out[i]![out[i]!.length - 1]!.endMs : Infinity;

    const canPrev = prev !== undefined && spanOf(prev, out[i]!) <= mergeCapMs;
    const canNext = next !== undefined && spanOf(out[i]!, next) <= mergeCapMs;

    if (canPrev && (!canNext || gapPrev <= gapNext)) {
      prev!.push(...out[i]!);
      out.splice(i, 1);
      i -= 1;
    } else if (canNext) {
      next!.unshift(...out[i]!);
      out.splice(i, 1);
      i -= 1;
    }
  }
  return out;
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

  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    groups.push(current);
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

  const merged =
    options.minDurationMs !== undefined
      ? mergeShortUtterances(
          groups,
          options.minDurationMs,
          Math.max(maxDurationMs, MERGE_DURATION_CEILING_MS),
        )
      : groups;

  return merged.map((g, i) => buildUtterance(g, i + 1));
};

export type UtteranceTimeRange = {
  /** Inclusive lower bound in source timeline ms. */
  startMs?: number;
  /** Exclusive upper bound in source timeline ms. */
  endMs?: number;
};

/**
 * 按源片时间窗筛选话语单元，并把时间轴平移到窗口起点（0）、重新编号。
 *
 * 用于短样本冒烟：不裁文件进 downloads，只限定处理范围（`yt2x dub --start-ms/--end-ms`）。
 * 只在边界处截断起止时间，不改动 text / wordCount——话语单元不可再切分，跨边界的
 * 单元原样保留、按边界裁剪时间戳，取舍与旧的（已删除的）filterDubCuesByTimeRange 一致。
 */
export const filterUtterancesByTimeRange = (
  utterances: readonly Utterance[],
  range: UtteranceTimeRange,
): Utterance[] => {
  const windowStart = range.startMs ?? 0;
  const windowEnd = range.endMs;
  if ((range.startMs === undefined || range.startMs <= 0) && range.endMs === undefined) {
    return [...utterances];
  }
  if (windowEnd !== undefined && windowEnd <= windowStart) {
    throw new Error(
      `Invalid dub time range: endMs (${windowEnd}) must be greater than startMs (${windowStart}).`,
    );
  }

  const filtered = utterances.filter((u) => {
    if (u.endMs <= windowStart) return false;
    if (windowEnd !== undefined && u.startMs >= windowEnd) return false;
    return true;
  });

  return filtered.map((u, index) => {
    const startMs = Math.max(u.startMs, windowStart) - windowStart;
    const endMs = (windowEnd !== undefined ? Math.min(u.endMs, windowEnd) : u.endMs) - windowStart;
    return {
      ...u,
      index: index + 1,
      startMs,
      endMs: Math.max(endMs, startMs + 1),
    };
  });
};
