/**
 * 文本转语音端口。
 *
 * 配音链路里唯一与具体厂商耦合的地方。调试期走本地 edge-tts（免费、不计费），
 * 成片期走 ElevenLabs——两者对"语速"的表达方式完全不同（edge-tts 用
 * `--rate=+10%` 字符串，ElevenLabs 用 speed 浮点数且区间更窄），所以端口统一
 * 用**倍率**表达，由各适配器负责映射，并通过 `rateRange` 声明自己真实支持的
 * 区间。混合对齐策略必须先读 `rateRange` 再决定能压多少，不能假设所有引擎都
 * 能加速到同一个上限。
 */

export type TtsAudioFormat = "mp3" | "wav";

export type TtsRequest = {
  /** 要合成的文本。调用方保证已经做过朗读化处理（无括注、无 Markdown）。 */
  text: string;
  /** 引擎音色 ID，如 "zh-CN-YunxiNeural"。 */
  voice: string;
  /**
   * 语速倍率，1.0 为引擎默认速度。适配器会把它裁剪进自己的 `rateRange`，
   * 并在 `TtsResult.rate` 里回报实际使用的值——调用方据此判断请求有没有被削。
   */
  rate?: number;
  format?: TtsAudioFormat;
  signal?: AbortSignal;
};

/**
 * 引擎给出的语音起止（相对本段音频文件起点）。
 *
 * 用于扣掉引擎前置 padding、得到自然语速时长。缺省时调用方必须显式降级
 * （报错或可见警告），禁止静默退回波形/整文件时长猜测。
 */
export type TtsSpeechCue = {
  startMs: number;
  endMs: number;
  text?: string;
};

export type TtsSpeechTiming = {
  /** 第一条 cue 起点 ≈ 引擎前置 padding。 */
  speechStartMs: number;
  /** 最后一条 cue 终点。 */
  speechEndMs: number;
  /** speechEndMs - speechStartMs，不含前置 padding。 */
  speechDurationMs: number;
  cues?: readonly TtsSpeechCue[];
};

export type TtsResult = {
  audio: Uint8Array;
  format: TtsAudioFormat;
  /**
   * 引擎自报的时长（毫秒）。多数引擎不返回，此时为 undefined。
   * 自然语速时长优先取 `speechTiming.speechDurationMs`；整文件 ffprobe
   * 只做交叉校验（语音终点不得超过文件时长）。
   */
  durationMs?: number;
  /** 词/短语级时间戳；edge-tts 等引擎有则必填，缺则调用方显式失败。 */
  speechTiming?: TtsSpeechTiming;
  voice: string;
  /** 适配器实际使用的倍率（可能因 rateRange 裁剪而不等于请求值）。 */
  rate: number;
};

export type TtsRateRange = {
  min: number;
  max: number;
};

export interface TtsPort {
  /** 适配器标识，写进 dub-script.json 供复现。 */
  readonly id: string;
  /** 该引擎真实支持的语速倍率区间。 */
  readonly rateRange: TtsRateRange;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

/**
 *  - AUTH：鉴权失败。换 key。
 *  - RATE_LIMIT：被限流。退避重试。
 *  - QUOTA：额度耗尽。换账户或充值。
 *  - BAD_REQUEST：请求本身不合法（空文本、未知音色）。code bug。
 *  - BAD_RESPONSE：拿到了响应但不可用（空音频、截断）。
 *  - NETWORK：连接 / 超时。重试。
 *  - UNAVAILABLE：引擎不可用（本地未安装 edge-tts 等）。
 *  - UNKNOWN：兜底。
 */
export type TtsErrorKind =
  | "AUTH"
  | "RATE_LIMIT"
  | "QUOTA"
  | "BAD_REQUEST"
  | "BAD_RESPONSE"
  | "NETWORK"
  | "UNAVAILABLE"
  | "UNKNOWN";

export type TtsErrorContext = {
  engine: string;
  voice?: string;
  httpStatus?: number;
  retriable: boolean;
};

export class TtsError extends Error {
  readonly kind: TtsErrorKind;
  readonly context: TtsErrorContext;

  constructor(
    kind: TtsErrorKind,
    message: string,
    context: TtsErrorContext,
    opts?: { cause?: unknown },
  ) {
    super(message, opts !== undefined ? { cause: opts.cause } : undefined);
    this.name = "TtsError";
    this.kind = kind;
    this.context = context;
  }
}

export const isTtsError = (err: unknown): err is TtsError => err instanceof TtsError;

/** 把请求倍率裁剪进引擎支持区间。适配器统一用它，保证行为一致。 */
export const clampRate = (rate: number | undefined, range: TtsRateRange): number => {
  if (rate === undefined || !Number.isFinite(rate)) return 1;
  return Math.min(range.max, Math.max(range.min, rate));
};
