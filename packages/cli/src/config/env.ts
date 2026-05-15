import { LLM_PROVIDER_DEFAULTS, LlmProviderSchema, type LlmConfig, type LlmProvider } from "../args/llm.js";

const DEFAULT_PROVIDER_ENV_KEYS = ["YT2X_LLM_PROVIDER", "YT2X_DEFAULT_LLM_PROVIDER"] as const;

/** 便于 `.env` 里写 `gpt` / `claude` 等别名 */
const PROVIDER_NAME_ALIASES: Record<string, LlmProvider> = {
  gpt: "openai",
  openai: "openai",
  chatgpt: "openai",
  claude: "anthropic",
  anthropic: "anthropic",
  deepseek: "deepseek",
  moonshot: "moonshot",
  kimi: "moonshot",
};

/**
 * 从环境变量读取默认 LLM provider（供 `--llm-provider` 省略时使用）。
 *
 * 支持：`YT2X_LLM_PROVIDER` 或 `YT2X_DEFAULT_LLM_PROVIDER`，取值可为
 * `openai` | `anthropic` | `deepseek` | `moonshot`，或别名 `gpt` | `claude` | `kimi`。
 */
export const readDefaultLlmProviderFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): LlmProvider | undefined => {
  for (const key of DEFAULT_PROVIDER_ENV_KEYS) {
    const raw = env[key];
    if (typeof raw !== "string") continue;
    const norm = raw.trim().toLowerCase();
    if (!norm) continue;
    const aliased = PROVIDER_NAME_ALIASES[norm];
    if (aliased) return aliased;
    const parsed = LlmProviderSchema.safeParse(raw.trim());
    if (parsed.success) return parsed.data;
  }
  return undefined;
};

/** CLI 在未传 `--llm-provider` 时的默认 provider */
export const defaultCliLlmProvider = (env: NodeJS.ProcessEnv = process.env): LlmProvider =>
  readDefaultLlmProviderFromEnv(env) ?? "openai";

/**
 * 从环境变量解析 LLM API key。
 *
 * 优先级（高到低）：
 *  1. 显式 provider 对应的环境变量（如 OPENAI_API_KEY）
 *  2. 该 provider 的备用别名（如 OPENAI_KEY、GPT_API_KEY）
 *
 * 不再做跨 provider fallback —— 用户指定 deepseek 就只读 DEEPSEEK_API_KEY，
 * 避免把 OPENAI_API_KEY 误用为 DeepSeek 凭证。
 */
export const readLlmApiKeyFromEnv = (
  provider: LlmProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const envKeys = LLM_PROVIDER_DEFAULTS[provider].envKeys;
  for (const key of envKeys) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
};

/**
 * 合并 CLI / env / defaults，返回最终的 LlmConfig。
 *
 * 关键不变量：CLI 永远不接收 apiKey，所以这里只能从 env / 凭证文件来。
 */
export const resolveLlmConfig = (
  cli: LlmConfig,
  env: NodeJS.ProcessEnv = process.env,
): LlmConfig => {
  const provider = cli.provider;
  const defaults = LLM_PROVIDER_DEFAULTS[provider];
  return {
    provider,
    model: cli.model ?? defaults.model,
    baseUrl: cli.baseUrl ?? defaults.baseUrl,
    apiKey: cli.apiKey ?? readLlmApiKeyFromEnv(provider, env),
  };
};

/**
 * 校验最终配置是否可用（含 apiKey）。失败时返回错误信息而不是抛错，
 * 方便 CLI 在 review 模式下给出更友好的提示。
 */
export const validateLlmConfigReady = (
  config: LlmConfig,
): { ok: true } | { ok: false; reason: string } => {
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    const envKeys = LLM_PROVIDER_DEFAULTS[config.provider].envKeys;
    return {
      ok: false,
      reason: `Missing API key for provider "${config.provider}". Set one of: ${envKeys.join(", ")}`,
    };
  }
  if (config.model === undefined || config.model.length === 0) {
    return { ok: false, reason: `Missing model for provider "${config.provider}"` };
  }
  return { ok: true };
};
