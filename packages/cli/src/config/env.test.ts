import { describe, expect, it } from "vitest";
import {
  defaultCliLlmProvider,
  readDefaultLlmProviderFromEnv,
  readLlmApiKeyFromEnv,
  resolveLlmConfig,
  validateLlmConfigReady,
} from "./env.js";

describe("readDefaultLlmProviderFromEnv", () => {
  it("reads YT2X_LLM_PROVIDER with alias gpt", () => {
    expect(readDefaultLlmProviderFromEnv({ YT2X_LLM_PROVIDER: "gpt" })).toBe("openai");
  });

  it("prefers YT2X_LLM_PROVIDER over YT2X_DEFAULT_LLM_PROVIDER", () => {
    expect(
      readDefaultLlmProviderFromEnv({
        YT2X_LLM_PROVIDER: "deepseek",
        YT2X_DEFAULT_LLM_PROVIDER: "openai",
      }),
    ).toBe("deepseek");
  });

  it("falls back to YT2X_DEFAULT_LLM_PROVIDER", () => {
    expect(readDefaultLlmProviderFromEnv({ YT2X_DEFAULT_LLM_PROVIDER: "claude" })).toBe("anthropic");
  });
});

describe("defaultCliLlmProvider", () => {
  it("defaults to openai when unset", () => {
    expect(defaultCliLlmProvider({})).toBe("openai");
  });
});

describe("readLlmApiKeyFromEnv", () => {
  it("reads provider-specific env first", () => {
    expect(readLlmApiKeyFromEnv("openai", { OPENAI_API_KEY: "primary" })).toBe("primary");
  });

  it("falls back to provider alias env", () => {
    expect(readLlmApiKeyFromEnv("openai", { OPENAI_KEY: "fallback" })).toBe("fallback");
  });

  it("reads GPT_API_KEY for openai", () => {
    expect(readLlmApiKeyFromEnv("openai", { GPT_API_KEY: "gpt-only" })).toBe("gpt-only");
  });

  it("reads CLAUDE_API_KEY for anthropic", () => {
    expect(readLlmApiKeyFromEnv("anthropic", { CLAUDE_API_KEY: "claude-only" })).toBe("claude-only");
  });

  it("does NOT cross providers (deepseek must not read OPENAI_API_KEY)", () => {
    expect(readLlmApiKeyFromEnv("deepseek", { OPENAI_API_KEY: "should-not-leak" })).toBeUndefined();
  });

  it("returns undefined when no relevant env present", () => {
    expect(readLlmApiKeyFromEnv("moonshot", {})).toBeUndefined();
  });
});

describe("resolveLlmConfig", () => {
  it("fills provider defaults when CLI omits model/baseUrl", () => {
    const cfg = resolveLlmConfig(
      { provider: "openai" },
      { OPENAI_API_KEY: "sk-test" },
    );
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.apiKey).toBe("sk-test");
  });

  it("honors explicit CLI overrides", () => {
    const cfg = resolveLlmConfig(
      { provider: "deepseek", model: "deepseek-coder", baseUrl: "https://x.example/v1" },
      { DEEPSEEK_API_KEY: "ds-test" },
    );
    expect(cfg.model).toBe("deepseek-coder");
    expect(cfg.baseUrl).toBe("https://x.example/v1");
  });
});

describe("validateLlmConfigReady", () => {
  it("succeeds with fully populated config", () => {
    const cfg = resolveLlmConfig(
      { provider: "anthropic" },
      { ANTHROPIC_API_KEY: "ant-test" },
    );
    expect(validateLlmConfigReady(cfg)).toEqual({ ok: true });
  });

  it("reports missing apiKey with hint envs", () => {
    const cfg = resolveLlmConfig({ provider: "moonshot" }, {});
    const result = validateLlmConfigReady(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/MOONSHOT_API_KEY/);
    }
  });
});
