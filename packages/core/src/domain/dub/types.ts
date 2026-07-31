/**
 * 配音（dub）阶段的领域类型。
 *
 * 与 notes / article 一致：纯数据结构，不引用 fs / 子进程 / 任何 Node-only API。
 * 时间一律用毫秒整数表达，SRT 的 "00:01:02,500" 字符串只在进出边界转换一次，
 * 中间所有计算都是数值——时长协商要做加减和比值，字符串时间戳在这里只会招错。
 */

/**
 * ASR 输出的单个词及其时间。
 *
 * 注意 `word` 会带着 ASR 识别出的标点（"Agents." / "However,"）——话语切分正是
 * 依赖这一点，而不是依赖词间停顿：实测 faster-whisper 的词级时间戳是连续的，
 * 90% 的词间间隔为 0，最大也只有 720ms，其中并不携带换气信息。
 */
export type TimedWord = {
  word: string;
  startMs: number;
  endMs: number;
};

/**
 * 话语单元：TTS 的合成单位，一个完整的自然句。
 *
 * 与字幕行（显示单元）是两级关系——显示单元是话语单元的细分。这样「字幕要短」
 * 与「分句要自然」不再互相牺牲，见 docs/DUB-TASK.md。
 */
export type Utterance = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  wordCount: number;
};

/** 长度受限翻译后的配音稿行，送进 TTS 的就是 `text`。 */
export type DubScriptLine = {
  index: number;
  startMs: number;
  endMs: number;
  /** 话语单元的实测时长，即这一句配音的目标时长。 */
  targetDurationMs: number;
  /** 长度受限翻译后的中文文本。 */
  text: string;
  /** 对应话语单元的英文原文，供 audit 对照信息有没有丢。 */
  sourceText: string;
  /**
   * 构成这一句的原话语单元 index。当前恒为单元素数组（一句配音稿对应一个话语单元）；
   * 字段保留是为了 PR4 在话语单元内部细分显示单元时复用同一套形状。
   */
  cueIndices: readonly number[];
};

export type DubScript = {
  version: 1;
  videoId: string;
  /** 生成配音稿所依据的词级时间戳文件相对路径，如 "video/full.local.en.words.json"。 */
  sourceWords: string;
  /** 翻译用的 LLM 模型 ID，供复现。 */
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

/**
 * 时长协商对单行采取的动作。
 *
 * 顺序固定：keep → speed → delay。前一步能压进目标区间就停，不会为了"更紧凑"
 * 去无谓加速。事后改短（原第三档 shorten）已被长度受限翻译取代——冗余在翻译阶段
 * 就被挤掉，不再需要合成完再回头砍。
 */
export type DubNegotiateAction = "keep" | "speed" | "delay";

/** 规划阶段对单行的决策（尚未真正重新合成）。 */
export type DubNegotiateLinePlan = {
  index: number;
  action: DubNegotiateAction;
  /** 请求的语速倍率。keep/delay 为 1；speed 为协商值。 */
  rate: number;
  /** 原字幕区间起点。 */
  originalStartMs: number;
  originalEndMs: number;
  targetDurationMs: number;
  /** 倍率 1.0 下的实测时长（来自 PR1 报告）。 */
  naturalMs: number;
  /** 规划时预计的放置起点（已计入此前累积漂移）。 */
  plannedStartMs: number;
  /** 规划时预计的放置终点。 */
  plannedEndMs: number;
  /** 送进 TTS 的文本。 */
  text: string;
};

export type DubNegotiatePlan = {
  /**
   * 2：删除时长协商的第三档（事后 LLM 改短），其专属计数字段和动作枚举成员
   * 随之一并移除。旧版 1 的落盘文件不再能被读取——它是中间产物，重跑即可重新生成。
   */
  version: 2;
  videoId: string;
  lines: readonly DubNegotiateLinePlan[];
  /** 片尾仍未吸收完的累积漂移，混音时用冻结末帧延长视频。 */
  extendMs: number;
  /** 规划阶段预计的总漂移，与 extendMs 相同。 */
  plannedDriftMs: number;
  speedCount: number;
  delayCount: number;
  keepCount: number;
};

/**
 * 协商执行后的最终落点。反向 SRT 和混音都只读这份，不再回看原字幕时间戳。
 */
export type DubPlacedLine = {
  index: number;
  action: DubNegotiateAction;
  rate: number;
  text: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** 相对 dub 目录的音频路径。 */
  audioFile: string;
};

export type DubPlacementReport = {
  version: 1;
  videoId: string;
  engine: string;
  voice: string;
  lines: readonly DubPlacedLine[];
  /** 实际需要冻结末帧延长的毫秒数。 */
  extendMs: number;
  /** 最终音频轨总时长（最后一句 endMs）。 */
  audioEndMs: number;
  speedCount: number;
  delayCount: number;
  keepCount: number;
};
