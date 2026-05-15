import {
  llmBadResponse,
  classifyHttpError,
} from "./errors.js";
import { postJson, safeJson, type Fetcher } from "./http.js";
import type { ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";

/**
 * 兼容 OpenAI Chat Completions 协议的适配器。
 *
 * 验证过的实现：
 *  - OpenAI (api.openai.com/v1)
 *  - DeepSeek (api.deepseek.com/v1)
 *  - Moonshot (api.moonshot.cn/v1)
 *
 * 任何 OpenAI-compatible 第三方网关（OpenRouter / Groq 等）理论上都能跑，
 * 但只把已验证的三家写进 LlmProvider 枚举，避免 silent breakage。
 */

export type OpenAICompatibleProviderId = "openai" | "deepseek" | "moonshot";

export type OpenAICompatibleConfig = {
  provider: OpenAICompatibleProviderId;
  apiKey: string;
  baseUrl: string;
  /** 默认 model，可被 ChatRequest.model 覆盖 */
  defaultModel?: string;
  /** ms；默认 60s */
  timeoutMs?: number;
  fetcher?: Fetcher;
};

type ChatChoice = {
  index?: number;
  message?: { role?: string; content?: unknown };
  finish_reason?: string | null;
};

type ChatCompletionResponse = {
  id?: string;
  model?: string;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
};

const ensureJsonHint = (req: ChatRequest): ChatRequest => {
  if (req.jsonMode !== true) return req;
  const mentionsJson = req.messages.some((m) =>
    typeof m.content === "string" && /json/i.test(m.content),
  );
  if (mentionsJson) return req;
  // OpenAI 硬性要求：messages 中必须出现 "json" 字样，否则 400。
  const messages = [...req.messages];
  const last = messages[messages.length - 1];
  if (last !== undefined) {
    messages[messages.length - 1] = {
      ...last,
      content: `${last.content}\n\nRespond in valid JSON.`,
    };
  }
  return { ...req, messages };
};

const mapFinishReason = (raw: string | null | undefined): ChatResponse["finishReason"] => {
  switch (raw) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "other";
    default:
      return "other";
  }
};

export const createOpenAICompatibleAdapter = (config: OpenAICompatibleConfig): LlmPort => {
  if (config.apiKey.length === 0) {
    throw new Error(`createOpenAICompatibleAdapter (${config.provider}): empty apiKey`);
  }
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;

  return {
    chat: async (rawReq: ChatRequest): Promise<ChatResponse> => {
      const req = ensureJsonHint(rawReq);
      const model = req.model.length > 0 ? req.model : (config.defaultModel ?? "");
      if (model.length === 0) {
        throw new Error(`${config.provider} adapter: no model specified (set ChatRequest.model or config.defaultModel)`);
      }
      const body: Record<string, unknown> = {
        model,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
      if (req.jsonMode === true) body.response_format = { type: "json_object" };

      const opts: Parameters<typeof postJson>[0] = {
        url,
        headers: { authorization: `Bearer ${config.apiKey}` },
        body,
        provider: config.provider,
        model,
      };
      if (config.fetcher !== undefined) opts.fetcher = config.fetcher;
      if (req.signal !== undefined) opts.signal = req.signal;
      if (config.timeoutMs !== undefined) opts.timeoutMs = config.timeoutMs;
      const resp = await postJson(opts);
      const json = (await safeJson(resp)) as ChatCompletionResponse;

      if (!resp.ok) {
        const providerCode = json.error?.code ?? json.error?.type;
        throw classifyHttpError({
          provider: config.provider,
          model,
          status: resp.status,
          ...(providerCode !== undefined ? { providerCode } : {}),
          message:
            json.error?.message ??
            `${config.provider} HTTP ${resp.status} (no error body)`,
        });
      }

      const choice = json.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw llmBadResponse({
          provider: config.provider,
          model,
          reason: "choices[0].message.content missing or not a string",
        });
      }

      const result: ChatResponse = {
        content,
        model: json.model ?? model,
        finishReason: mapFinishReason(choice?.finish_reason ?? null),
      };
      if (json.usage !== undefined) {
        const usage: ChatResponse["usage"] = {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
        };
        if (json.usage.total_tokens !== undefined) usage.totalTokens = json.usage.total_tokens;
        result.usage = usage;
      }
      return result;
    },
  };
};
