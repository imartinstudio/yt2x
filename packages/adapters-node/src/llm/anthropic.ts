import { classifyHttpError, llmBadResponse } from "./errors.js";
import { postJson, safeJson, type Fetcher } from "./http.js";
import type { ChatMessage, ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";

/**
 * Anthropic Messages API 适配器。
 *
 * 与 OpenAI 协议的关键差异：
 *  - 端点：POST /v1/messages
 *  - 鉴权 header：`x-api-key: <key>`（不是 Bearer）
 *  - 必须传 `anthropic-version` header（写死 2023-06-01，已稳定）
 *  - system message 单独传 `system: string`，不进 messages 数组
 *  - assistant turn 起手字符可以预填，jsonMode 利用这点强制以 `{` 开头
 *  - response：content 是 array of blocks（type=text / tool_use 等），需要拼接 text
 *  - finish_reason 字段叫 `stop_reason`
 */

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_CACHE_BETA = "prompt-caching-2024-07-31";
const DEFAULT_MAX_TOKENS = 4096;

/** Minimum tokens required before a cache_control breakpoint (Anthropic requirement) */
const CACHE_MIN_TOKENS = 1024;

export type AnthropicConfig = {
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  timeoutMs?: number;
  fetcher?: Fetcher;
};

type AnthropicContentBlock = {
  type?: string;
  text?: string;
};

type AnthropicMessagesResponse = {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    type?: string;
    message?: string;
  };
};

const splitSystem = (messages: readonly ChatMessage[]): {
  system?: string;
  rest: ChatMessage[];
} => {
  const systems = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages.filter((m) => m.role !== "system");
  if (systems.length === 0) return { rest };
  return { system: systems.join("\n\n"), rest };
};

const mapStopReason = (raw: string | null | undefined): ChatResponse["finishReason"] => {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "other";
    default:
      return "other";
  }
};

export const createAnthropicAdapter = (config: AnthropicConfig): LlmPort => {
  if (config.apiKey.length === 0) {
    throw new Error("createAnthropicAdapter: empty apiKey");
  }
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/messages`;

  return {
    chat: async (req: ChatRequest): Promise<ChatResponse> => {
      const model = req.model.length > 0 ? req.model : (config.defaultModel ?? "");
      if (model.length === 0) {
        throw new Error("anthropic adapter: no model specified");
      }
      const { system, rest } = splitSystem(req.messages);

      // Build messages — add cache_control to last user message when system is cached
      const messages = rest.map((m, i) => {
        const isLastUser = m.role === "user" && i === rest.length - 1;
        if (isLastUser && system !== undefined) {
          return {
            role: "user" as const,
            content: [
              { type: "text" as const, text: m.content, cache_control: { type: "ephemeral" as const } },
            ],
          };
        }
        return { role: m.role, content: m.content };
      });

      const body: Record<string, unknown> = {
        model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages,
      };

      // Cache system prompt when large enough to benefit (>1024 tokens ≈ ~1500 CJK chars)
      if (system !== undefined) {
        if (system.length > CACHE_MIN_TOKENS * 1.5) {
          body.system = [
            { type: "text", text: system, cache_control: { type: "ephemeral" } },
          ];
        } else {
          body.system = system;
        }
      }
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.jsonMode === true) {
        // 没有原生 json mode，用"strict system + assistant 预填"组合
        const jsonNote = "Respond ONLY with a single JSON object. Do not include explanations.";
        const prevSystem = body.system;
        if (prevSystem === undefined) {
          body.system = jsonNote;
        } else if (typeof prevSystem === "string") {
          body.system = `${prevSystem}\n\n${jsonNote}`;
        } else if (Array.isArray(prevSystem)) {
          // 结构化 system（含 cache_control）：追加 text block
          body.system = [
            ...prevSystem,
            { type: "text", text: jsonNote },
          ];
        }
        // 在 messages 末尾追加一条 assistant 起手 `{`，模型会续写。
        // 拼回时手动补上前缀。
        (body.messages as Array<{ role: string; content: unknown }>).push({
          role: "assistant",
          content: "{",
        });
      }

      const opts: Parameters<typeof postJson>[0] = {
        url,
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": ANTHROPIC_CACHE_BETA,
        },
        body,
        provider: "anthropic",
        model,
      };
      if (config.fetcher !== undefined) opts.fetcher = config.fetcher;
      if (req.signal !== undefined) opts.signal = req.signal;
      if (config.timeoutMs !== undefined) opts.timeoutMs = config.timeoutMs;
      const resp = await postJson(opts);
      const json = (await safeJson(resp)) as AnthropicMessagesResponse;

      if (!resp.ok) {
        const providerCode = json.error?.type;
        throw classifyHttpError({
          provider: "anthropic",
          model,
          status: resp.status,
          ...(providerCode !== undefined ? { providerCode } : {}),
          message: json.error?.message ?? `anthropic HTTP ${resp.status}`,
        });
      }

      const blocks = json.content ?? [];
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("");
      if (text.length === 0) {
        throw llmBadResponse({
          provider: "anthropic",
          model,
          reason: "content[].text empty or missing",
        });
      }

      // jsonMode: assistant 预填了 "{"，模型可能续写也可能重新输出一个 "{"
      const content =
        req.jsonMode === true
          ? text.startsWith("{") ? text : `{${text}`
          : text;

      const result: ChatResponse = {
        content,
        model: json.model ?? model,
        finishReason: mapStopReason(json.stop_reason ?? null),
      };
      if (json.usage !== undefined) {
        result.usage = {
          promptTokens: json.usage.input_tokens ?? 0,
          completionTokens: json.usage.output_tokens ?? 0,
        };
      }
      return result;
    },
  };
};
