/**
 * 配音（dub）阶段的领域类型。
 *
 * 与 notes / article 一致：纯数据结构，不引用 fs / 子进程 / 任何 Node-only API。
 * 时间一律用毫秒整数表达，SRT 的 "00:01:02,500" 字符串只在进出边界转换一次，
 * 中间所有计算都是数值——时长协商要做加减和比值，字符串时间戳在这里只会招错。
 */

/** 从 full.zh.srt 解析出来的单条中文字幕。 */
export type DubCue = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

/**
 * 若干条字幕合并出的"自然句"，是 TTS 的合成单位。
 *
 * 合并的动机：full.zh.srt 是按屏宽切的，每条 15-20 字。按条合成会让 TTS 在
 * 每条之间硬断气，听起来像念条目。合并回自然句后语气连贯，而且对齐区间更长、
 * 相对误差更小，混合策略更容易在自然语速内压进去。
 */
export type DubSegment = {
  index: number;
  startMs: number;
  endMs: number;
  /** 构成这一句的原字幕条 index，PR2 反向生成 SRT 时要用。 */
  cueIndices: readonly number[];
  text: string;
};

/** 朗读化改写后的配音稿行，送进 TTS 的就是 `text`。 */
export type DubScriptLine = {
  index: number;
  startMs: number;
  endMs: number;
  /** 原字幕区间时长，即这一句配音的目标时长。 */
  targetDurationMs: number;
  /** 朗读化改写后的文本。 */
  text: string;
  /** 改写前的合并原文，供 audit 对照信息有没有丢。 */
  sourceText: string;
  cueIndices: readonly number[];
};

export type DubScript = {
  version: 1;
  videoId: string;
  /** 生成配音稿所依据的字幕文件相对路径，如 "video/full.zh.srt"。 */
  sourceSubtitle: string;
  /** 改写用的 LLM 模型 ID，供复现。 */
  rewriteModel: string;
  lines: readonly DubScriptLine[];
};

/**
 * 单行的实测时长数据。
 *
 * `synthesizedMs` 一律是**倍率 1.0** 下的实测值——PR3 要用这批数据定阈值，
 * 掺了调速的样本会让分布失真。
 */
export type DubLineTiming = {
  index: number;
  targetDurationMs: number;
  synthesizedMs: number;
  /** synthesizedMs / targetDurationMs。>1 表示这一句在自然语速下装不下。 */
  ratio: number;
  charCount: number;
  /** 音频文件相对 dub 目录的路径。 */
  audioFile: string;
};

export type DubTimingReport = {
  version: 1;
  videoId: string;
  engine: string;
  voice: string;
  lineCount: number;
  /** 各行 ratio 的中位数，衡量整体是否需要普遍加速。 */
  medianRatio: number;
  /** ratio > 1 的行数，即自然语速下装不下的句子。 */
  overflowCount: number;
  /** 所有行 synthesizedMs 之和减 targetDurationMs 之和，正值表示总体会顺延。 */
  totalDriftMs: number;
  lines: readonly DubLineTiming[];
};
