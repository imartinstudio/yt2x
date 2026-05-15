import { LlmError, type LlmErrorContext, type LlmErrorKind } from "@yt2x/core";

/**
 * 把 provider 的 HTTP 响应（含错误码片段）归类到统一 LlmErrorKind。
 *
 * 设计点：
 *  - 优先识别 provider-specific code（OpenAI 的 `insufficient_quota`、Anthropic 的 `overloaded_error` 等），
 *    比 status code 更精确。
 *  - 只对 RATE_LIMIT / SERVER / NETWORK 标 retriable=true。AUTH / QUOTA / BAD_REQUEST 一定不重试。
 *  - CONTEXT_LIMIT 不可重试（同样输入不会变短）。
 */

const PROVIDER_CODE_MAP: Record<string, LlmErrorKind> = {
  // OpenAI 系（OpenAI / DeepSeek / Moonshot 大量复用）
  invalid_api_key: "AUTH",
  invalid_request_error: "BAD_REQUEST",
  insufficient_quota: "QUOTA",
  rate_limit_exceeded: "RATE_LIMIT",
  context_length_exceeded: "CONTEXT_LIMIT",
  // Anthropic
  authentication_error: "AUTH",
  permission_error: "AUTH",
  not_found_error: "BAD_REQUEST",
  request_too_large: "CONTEXT_LIMIT",
  rate_limit_error: "RATE_LIMIT",
  api_error: "SERVER",
  overloaded_error: "SERVER",
};

export const classifyHttpError = (input: {
  provider: string;
  model: string;
  status: number;
  providerCode?: string;
  message: string;
}): LlmError => {
  let kind: LlmErrorKind;
  let retriable = false;

  if (input.providerCode !== undefined && PROVIDER_CODE_MAP[input.providerCode] !== undefined) {
    kind = PROVIDER_CODE_MAP[input.providerCode]!;
  } else if (input.status === 401 || input.status === 403) {
    kind = "AUTH";
  } else if (input.status === 429) {
    kind = "RATE_LIMIT";
  } else if (input.status >= 500) {
    kind = "SERVER";
  } else if (input.status === 413) {
    kind = "CONTEXT_LIMIT";
  } else if (input.status >= 400) {
    kind = "BAD_REQUEST";
  } else {
    kind = "UNKNOWN";
  }

  if (kind === "RATE_LIMIT" || kind === "SERVER") retriable = true;

  const context: LlmErrorContext = {
    provider: input.provider,
    model: input.model,
    httpStatus: input.status,
    retriable,
  };
  if (input.providerCode !== undefined) context.providerCode = input.providerCode;

  return new LlmError(kind, input.message, context);
};

export const classifyNetworkError = (input: {
  provider: string;
  model: string;
  cause: unknown;
}): LlmError => {
  const causeMessage = input.cause instanceof Error ? input.cause.message : String(input.cause);
  return new LlmError("NETWORK", `Network failure calling ${input.provider}: ${causeMessage}`, {
    provider: input.provider,
    model: input.model,
    retriable: true,
  });
};

export const llmBadResponse = (input: {
  provider: string;
  model: string;
  reason: string;
}): LlmError =>
  new LlmError("BAD_RESPONSE", `${input.provider} returned a malformed response: ${input.reason}`, {
    provider: input.provider,
    model: input.model,
    retriable: false,
  });
