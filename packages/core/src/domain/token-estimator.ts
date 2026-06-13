/**
 * 轻量 token 估算工具 — 在发送 LLM 请求前估算 prompt token 数。
 *
 * 估算策略：中文字符约 1.5 chars/token，英文约 4 chars/token。
 * 混合文本按字符类别加权平均。
 * 误差通常在 ±15% 以内，足够用于阈值判断。
 */

/** 已知模型的大致 context window（token 数） */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-4o-mini": 128_000,
  "gpt-4o": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-3.5-turbo": 16_384,
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-20250514": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "deepseek-chat": 128_000,
  "deepseek-v4-flash": 128_000,
  "deepseek-reasoner": 64_000,
  "moonshot-v1-8k": 8_192,
  "moonshot-v1-32k": 32_768,
  "moonshot-v1-128k": 128_000,
};

/** 默认安全阈值 —— prompt 估算值超过 context window 的此比例时发出警告 */
export const DEFAULT_SAFETY_RATIO = 0.8;

/**
 * 粗略估算文本的 token 数。
 * 中文字符/标点 ≈ 0.67 token，英文单词/数字 ≈ 0.25 token。
 */
export const estimateTokenCount = (text: string): number => {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x20000 && code <= 0x2a6df) || // CJK Extension B
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols/Punctuation
      (code >= 0xff00 && code <= 0xffef) || // Halfwidth/Fullwidth
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) // Katakana
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  // CJK chars ≈ 1.5 chars/token, non-CJK ≈ 4 chars/token
  return Math.ceil(cjk / 1.5 + other / 4);
};

/**
 * 估算消息数组的总 prompt token 数。
 */
export const estimateMessagesTokenCount = (
  messages: Array<{ role: string; content: string }>,
): number => {
  let total = 0;
  for (const msg of messages) {
    // 每条消息有 ~4 token 的角色/格式开销
    total += 4 + estimateTokenCount(msg.content);
  }
  return total;
};

export type TokenBudgetWarning = {
  estimatedTokens: number;
  contextLimit: number;
  ratio: number;
  message: string;
};

/**
 * 检查 prompt 估算 token 数是否超过模型 context window 的安全阈值。
 * 返回警告信息或 null（安全）。
 */
export const checkTokenBudget = (
  estimatedTokens: number,
  model: string,
  safetyRatio: number = DEFAULT_SAFETY_RATIO,
): TokenBudgetWarning | null => {
  const contextLimit = MODEL_CONTEXT_LIMITS[model];
  if (contextLimit === undefined) {
    // 未知模型 —— 无法判断，不阻止
    return null;
  }
  const ratio = estimatedTokens / contextLimit;
  if (ratio > safetyRatio) {
    return {
      estimatedTokens,
      contextLimit,
      ratio,
      message: `Estimated prompt tokens (${estimatedTokens}) exceeds ${Math.round(safetyRatio * 100)}% of ${model} context window (${contextLimit}). Consider reducing input size.`,
    };
  }
  return null;
};
