import type { LlmPort } from "@yt2x/core";
import {
  createOpenAICompatibleAdapter,
  type OpenAICompatibleProviderId,
} from "./openai-compatible.js";
import { createAnthropicAdapter } from "./anthropic.js";
import { createImageGenerator, type ImageGeneratorConfig, type ImageGeneratorPort } from "./image-generator.js";
import type { Fetcher } from "./http.js";

export type LlmProviderId = OpenAICompatibleProviderId | "anthropic";

export type LlmFactoryConfig = {
  provider: LlmProviderId;
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  timeoutMs?: number;
  fetcher?: Fetcher;
};

export type { ImageGeneratorConfig, ImageGeneratorPort };

/**
 * 单一入口构造 LLM 适配器。CLI / 业务层只跟 `LlmPort` 打交道，
 * 不应该再直接 import 具体的 OpenAI / Anthropic 实现。
 */
export const createLlmAdapter = (config: LlmFactoryConfig): LlmPort => {
  if (config.apiKey.length === 0) {
    throw new Error(`createLlmAdapter (${config.provider}): empty apiKey`);
  }
  if (config.baseUrl.length === 0) {
    throw new Error(`createLlmAdapter (${config.provider}): empty baseUrl`);
  }

  if (config.provider === "anthropic") {
    const opts: Parameters<typeof createAnthropicAdapter>[0] = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    if (config.defaultModel !== undefined) opts.defaultModel = config.defaultModel;
    if (config.timeoutMs !== undefined) opts.timeoutMs = config.timeoutMs;
    if (config.fetcher !== undefined) opts.fetcher = config.fetcher;
    return createAnthropicAdapter(opts);
  }

  const opts: Parameters<typeof createOpenAICompatibleAdapter>[0] = {
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  };
  if (config.defaultModel !== undefined) opts.defaultModel = config.defaultModel;
  if (config.timeoutMs !== undefined) opts.timeoutMs = config.timeoutMs;
  if (config.fetcher !== undefined) opts.fetcher = config.fetcher;
  return createOpenAICompatibleAdapter(opts);
};

export const createImageGeneratorAdapter = (config: ImageGeneratorConfig): ImageGeneratorPort =>
  createImageGenerator(config);
