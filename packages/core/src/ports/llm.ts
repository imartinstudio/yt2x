export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatRequest = {
  /** Provider 模型 ID（如 "gpt-4o-mini", "claude-sonnet-4-...", "deepseek-chat"） */
  model: string;
  messages: ChatMessage[];
  /** 0.0 - 2.0；不传走 provider 默认 */
  temperature?: number;
  /** 输出 token 上限；不传走 provider 默认 */
  maxTokens?: number;
  /**
   * 启用 JSON mode（response 必须是合法 JSON）。
   * - OpenAI 兼容：发送 `response_format: { type: "json_object" }`
   * - Anthropic：在 system prompt 后追加 "Respond ONLY with JSON" 引导 + assistant 起手 `{`
   *
   * 注意：开启 jsonMode 时 messages 中**必须**包含 `json` 字样（OpenAI 硬性要求），
   * adapter 会在内部自动追加 system 提示，调用方无须额外操作。
   */
  jsonMode?: boolean;
  /** 调用方控制的取消信号 */
  signal?: AbortSignal;
};

export type ChatUsage = {
  promptTokens: number;
  completionTokens: number;
  /** 若 provider 提供 */
  totalTokens?: number;
};

export type ChatResponse = {
  content: string;
  /** 模型实际使用的 ID（provider 可能改写，如 deepseek 别名映射） */
  model: string;
  /**
   * 终止原因（yt2x 不暴露 tool calling；provider 若返回 tool_calls / tool_use 则映射为 `other`）。
   */
  finishReason: "stop" | "length" | "content_filter" | "other";
  usage?: ChatUsage;
};

export interface LlmPort {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/**
 * 跨 provider 的统一错误分类。
 *
 *  - AUTH：401/403。换 key。
 *  - RATE_LIMIT：429。退避重试。
 *  - QUOTA：配额耗尽 / 余额不足。换账户。
 *  - CONTEXT_LIMIT：输入或输出长度超模型上限。需要分块。
 *  - BAD_REQUEST：请求语法错（jsonMode 不被支持等）。code bug。
 *  - BAD_RESPONSE：响应不符合预期（如缺 choices）。可能是 provider 升级。
 *  - NETWORK：DNS / 连接 / 超时。重试。
 *  - SERVER：5xx。重试。
 *  - UNKNOWN：兜底。
 */
export type LlmErrorKind =
  | "AUTH"
  | "RATE_LIMIT"
  | "QUOTA"
  | "CONTEXT_LIMIT"
  | "BAD_REQUEST"
  | "BAD_RESPONSE"
  | "NETWORK"
  | "SERVER"
  | "UNKNOWN";

export type LlmErrorContext = {
  provider: string;
  model: string;
  httpStatus?: number;
  /** Provider 返回的原始错误码（"insufficient_quota", "rate_limit_exceeded" 等） */
  providerCode?: string;
  /** 是否值得自动重试 */
  retriable: boolean;
};

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly context: LlmErrorContext;

  constructor(kind: LlmErrorKind, message: string, context: LlmErrorContext, opts?: { cause?: unknown }) {
    super(message, opts !== undefined ? { cause: opts.cause } : undefined);
    this.name = "LlmError";
    this.kind = kind;
    this.context = context;
  }
}

export const isLlmError = (err: unknown): err is LlmError => err instanceof LlmError;
