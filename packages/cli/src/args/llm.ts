import { z } from "zod";

export const LlmProviderSchema = z.enum(["openai", "anthropic", "deepseek", "moonshot"]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

/**
 * LLM 配置 schema。
 *
 * 注意：`apiKey` 字段允许出现，但 **CLI 永远不暴露 --llm-api-key**。
 * 该字段仅供 config loader 从 env / 凭证文件填充使用。详见 ADR-0002 §6。
 */
export const LlmConfigSchema = z.object({
  provider: LlmProviderSchema.default("deepseek"),
  model: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/** LLM 任务类型 —— 用于按任务选择不同模型 */
export type LlmTask = "translate" | "notes" | "article" | "thread" | "short" | "deconstruct" | "deconstruct-post";

/**
 * 各 provider 的默认 model + baseUrl + 按任务可选模型覆盖。
 * 用户未显式传 --llm-model 时使用。
 *
 * taskModels 允许为不同任务指定不同模型（例如翻译用便宜模型，创作用强模型）。
 * 未配置的任务回退到 `model` 字段。
 */
export const LLM_PROVIDER_DEFAULTS: Record<
  LlmProvider,
  { model: string; baseUrl: string; envKeys: readonly string[]; taskModels?: Partial<Record<LlmTask, string>> }
> = {
  openai: {
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    envKeys: ["OPENAI_API_KEY", "OPENAI_KEY", "GPT_API_KEY"] as const,
    taskModels: {
      article: "gpt-4o",        // 创作需要更强模型一次通过，减少 repair 重试浪费
      thread: "gpt-4o",
      short: "gpt-4o",
    },
  },
  anthropic: {
    model: "claude-sonnet-4-20250514",
    baseUrl: "https://api.anthropic.com/v1",
    envKeys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CLAUDE_KEY"] as const,
  },
  deepseek: {
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    envKeys: ["DEEPSEEK_API_KEY"] as const,
  },
  moonshot: {
    model: "moonshot-v1-8k",
    baseUrl: "https://api.moonshot.cn/v1",
    envKeys: ["MOONSHOT_API_KEY"] as const,
  },
};

/** 为指定 provider 和任务解析最合适的模型 */
export const resolveTaskModel = (
  provider: LlmProvider,
  task: LlmTask,
  override?: string,
): string => {
  if (override !== undefined && override.length > 0) return override;
  const defaults = LLM_PROVIDER_DEFAULTS[provider];
  return defaults.taskModels?.[task] ?? defaults.model;
};
