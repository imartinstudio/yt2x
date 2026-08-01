import { findProtectedSpans } from "./glossary.js";

/**
 * 显示单元细分（core，纯函数，无 I/O）：在一个话语单元内部按屏宽把配音稿再切成若干条
 * 字幕，并在该话语单元的实测 [startMs, endMs] 区间内按字符占比给每条分配时间。
 *
 * 只按中文文本决定切几刀——中文驱动 TTS 语音时长，因此也驱动屏幕停留时间；英文只是
 * 同一话语单元原文的展示，按与中文相同的累计字符占比切成对应片段，不单独跑一遍屏宽
 * 折行（配音链路里英文不出声，不需要照顾它自己的可读宽度，见 docs/DUB-TASK.md）。
 *
 * 时间轴不漂移的关键约束：显示单元始终从属于某个话语单元，话语单元的 [startMs, endMs]
 * 是配音落点的实测值；这里只在这段已知区间内部切时间点，累计取整误差被强制封口在
 * endMs，不会随视频推进跨话语单元累积——这是「两级切分」一节的核心论证，见
 * `splitUtteranceIntoCues` 的实现。
 */

const CJK_PATTERN = /[一-鿿㐀-䶿\u{f900}-\u{faff}]/u;
const LATIN_ALNUM_PATTERN = /[A-Za-z0-9]/u;

/**
 * BaoCut 式视觉宽度：CJK 记 1 格，半角拉丁/数字记 0.5 格，标点不计。与 adapters-node
 * 的双语字幕渲染器（`semantic-bilingual-subtitles.ts` 的 `visualWidth`）同一套单位，
 * 但这里是独立实现——那边的宽度规则服务于"从切碎字幕里还原句子边界"，而话语单元本身
 * 已经是完整自然句，不需要那套还原逻辑，只借宽度单位本身（core 也不能依赖
 * adapters-node，没法直接 import）。
 */
export const visualWidth = (text: string): number => {
  let width = 0;
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) width += 1;
    else if (LATIN_ALNUM_PATTERN.test(ch)) width += 0.5;
  }
  return width;
};

/** 单条显示单元允许的最大视觉宽度；超过必须再切一刀。与双语字幕渲染器的 HARD_CJK 取值一致。 */
export const CUE_HARD_WIDTH = 20;

/** 找一刀时优先瞄准的目标宽度——略小于硬上限，给标点让路，切完的两半更均衡。 */
const CUE_TARGET_WIDTH = 14;

const STRONG_PUNCT = /[。！？.!?]/u;
const WEAK_PUNCT = /[，；：、,;:]/u;

/**
 * 把 `splitAt`（切点左侧字符数）挪出所有 `spans` 标出的保护区（术语、多字词、拉丁数字
 * 连续段），绝不允许切点落在保护区内部。找不到安全落点时返回 null。
 */
const nudgeOutOfSpans = (
  splitAt: number,
  spans: readonly [number, number][],
  length: number,
): number | null => {
  let result = Math.max(1, Math.min(splitAt, length - 1));
  for (let pass = 0; pass < 4; pass++) {
    const hit = spans.find(([start, end]) => result > start && result < end);
    if (hit === undefined) return result;
    const [start, end] = hit;
    const canLeft = start >= 1;
    const canRight = end <= length - 1;
    if (canLeft && canRight) {
      result = result - start <= end - result ? start : end;
    } else if (canLeft) {
      result = start;
    } else if (canRight) {
      result = end;
    } else {
      return null;
    }
  }
  return result;
};

/** 在 `text` 里找一个安全切点：优先句末标点，其次逗号顿号，都找不到就在目标宽度附近硬切。 */
const findSplitPoint = (text: string, spans: readonly [number, number][]): number | null => {
  const length = text.length;
  if (length < 2) return null;

  const ratio = CUE_TARGET_WIDTH / Math.max(visualWidth(text), 0.01);
  const target = Math.max(1, Math.min(Math.round(length * Math.min(Math.max(ratio, 0), 1)), length - 1));
  const searchRadius = Math.max(12, Math.ceil(length / 2));

  for (const pattern of [STRONG_PUNCT, WEAK_PUNCT]) {
    for (let offset = 0; offset <= searchRadius; offset++) {
      const fwd = target + offset;
      if (fwd < length && pattern.test(text[fwd]!)) {
        const candidate = nudgeOutOfSpans(fwd + 1, spans, length);
        if (candidate !== null) return candidate;
      }
      const back = target - offset;
      if (back > 0 && back < length && pattern.test(text[back]!)) {
        const candidate = nudgeOutOfSpans(back + 1, spans, length);
        if (candidate !== null) return candidate;
      }
      if (fwd >= length && back <= 0) break;
    }
  }
  return nudgeOutOfSpans(target, spans, length);
};

/**
 * 把 `zh` 递归切成每片视觉宽度都 <= `maxWidth` 的若干段，切点绝不落在
 * {@link findProtectedSpans} 标出的术语/单词内部。找不到安全切点时该片段维持原样
 * （宁可超宽也不破坏词/术语完整性）。空文本返回空数组。
 */
export const splitZhByWidth = (zh: string, maxWidth: number = CUE_HARD_WIDTH): string[] => {
  const trimmed = zh.trim();
  if (trimmed.length === 0) return [];
  if (visualWidth(trimmed) <= maxWidth) return [trimmed];

  const spans = findProtectedSpans(trimmed);
  const splitAt = findSplitPoint(trimmed, spans);
  if (splitAt === null) return [trimmed];

  const left = trimmed.slice(0, splitAt).trim();
  const right = trimmed.slice(splitAt).trim();
  if (left.length === 0 || right.length === 0) return [trimmed];

  return [...splitZhByWidth(left, maxWidth), ...splitZhByWidth(right, maxWidth)];
};

/**
 * 按 `parts`（通常是 `splitZhByWidth` 的输出）各自的字符数占比，把 [startMs, endMs]
 * 切成 `parts.length + 1` 个边界点。用累计占比而非逐段独立取整，末尾强制封口在
 * `endMs`——这样取整误差只会在话语单元内部的相邻边界间挪动，总时长精确等于
 * `endMs - startMs`，不会产生跨话语单元的漂移。
 */
export const allocateBoundariesByChars = (
  parts: readonly string[],
  startMs: number,
  endMs: number,
): number[] => {
  const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
  const boundaries: number[] = [startMs];
  let cumChars = 0;
  for (let i = 0; i < parts.length; i++) {
    cumChars += parts[i]!.length;
    const isLast = i === parts.length - 1;
    const raw =
      isLast || totalChars === 0
        ? endMs
        : startMs + Math.round((endMs - startMs) * (cumChars / totalChars));
    const prev = boundaries[boundaries.length - 1]!;
    boundaries.push(Math.min(Math.max(raw, prev + 1), endMs));
  }
  boundaries[boundaries.length - 1] = Math.max(endMs, boundaries[boundaries.length - 1]!);
  return boundaries;
};

/**
 * 按与 `zhParts` 相同的累计字符占比，把英文原文按词边界切成对应片段——绝不切碎单词。
 * 各片段依次拼接（用空格）必须与原文一致，既不丢词也不重复；这是"英文取同话语单元
 * 原文"这一约束在切分层面的落地。
 */
export const splitEnglishByShares = (
  enText: string,
  zhParts: readonly string[],
): string[] => {
  const words = enText.trim().split(/\s+/u).filter((w) => w.length > 0);
  if (zhParts.length === 0) return [];
  if (words.length === 0) return zhParts.map(() => "");
  if (zhParts.length === 1) return [words.join(" ")];

  const totalChars = zhParts.reduce((sum, p) => sum + p.length, 0);
  const boundaries: number[] = [0];
  let cumChars = 0;
  for (let i = 0; i < zhParts.length; i++) {
    cumChars += zhParts[i]!.length;
    const isLast = i === zhParts.length - 1;
    const raw =
      isLast || totalChars === 0
        ? words.length
        : Math.round(words.length * (cumChars / totalChars));
    const prev = boundaries[boundaries.length - 1]!;
    boundaries.push(Math.min(Math.max(raw, prev), words.length));
  }
  boundaries[boundaries.length - 1] = words.length;

  const pieces: string[] = [];
  for (let i = 0; i < zhParts.length; i++) {
    pieces.push(words.slice(boundaries[i]!, boundaries[i + 1]!).join(" "));
  }
  return pieces;
};

export type DubDisplayCue = {
  /** 1-based，同一话语单元内部从 1 开始编号（跨话语单元的全局编号由调用方决定）。 */
  index: number;
  zhText: string;
  enText: string;
  startMs: number;
  endMs: number;
};

export type DubDisplayCueInput = {
  /** 配音稿文本（中文，来自 DubPlacedLine.text）。 */
  zhText: string;
  /** 同一话语单元的英文原文（来自 DubScriptLine.sourceText）。 */
  enText: string;
  /** 话语单元的实测落点起点（T′）。 */
  startMs: number;
  /** 话语单元的实测落点终点（T′）。 */
  endMs: number;
};

/**
 * 把一个话语单元切成若干显示单元：中文按屏宽切，时间和英文都按中文各片段的字符占比
 * 分配。`zhText` 为空或纯空白时返回空数组（没有可显示的内容）。
 */
export const splitUtteranceIntoCues = (line: DubDisplayCueInput): DubDisplayCue[] => {
  const zhParts = splitZhByWidth(line.zhText);
  if (zhParts.length === 0) return [];

  const enParts = splitEnglishByShares(line.enText, zhParts);
  const boundaries = allocateBoundariesByChars(zhParts, line.startMs, line.endMs);

  return zhParts.map((zhText, i) => ({
    index: i + 1,
    zhText,
    enText: (enParts[i] ?? "").trim(),
    startMs: boundaries[i]!,
    endMs: boundaries[i + 1]!,
  }));
};
