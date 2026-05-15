import { createLlmAdapter, type LlmProviderId } from "@yt2x/adapters-node";
import { isLlmError } from "@yt2x/core";
import type { Command } from "commander";
import { LlmProviderSchema } from "../args/llm.js";
import { defaultCliLlmProvider, resolveLlmConfig, validateLlmConfigReady } from "../config/env.js";
import { logger } from "../logger.js";

type PingFlags = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  timeout?: string;
};

const EXIT_CONFIG_MISSING = 2;
const EXIT_AUTH = 3;
const EXIT_NETWORK = 4;
const EXIT_QUOTA = 5;

const exitCodeForLlmKind = (kind: string): number => {
  switch (kind) {
    case "AUTH":
      return EXIT_AUTH;
    case "QUOTA":
      return EXIT_QUOTA;
    case "NETWORK":
      return EXIT_NETWORK;
    case "RATE_LIMIT":
    case "SERVER":
    case "CONTEXT_LIMIT":
    case "BAD_REQUEST":
    case "BAD_RESPONSE":
    default:
      return 1;
  }
};

export const registerLlmCommand = (program: Command): void => {
  const llm = program.command("llm").description("LLM provider diagnostics");

  llm
    .command("ping")
    .description("Send a tiny chat request to verify provider/key/model are wired correctly")
    .option(
      "--provider <id>",
      "Provider: openai | anthropic | deepseek | moonshot",
      defaultCliLlmProvider(),
    )
    .option("--model <name>", "Override model id")
    .option("--base-url <url>", "Override base URL")
    .option("--timeout <ms>", "Request timeout in ms", "15000")
    .action(async (flags: PingFlags) => {
      const provider = LlmProviderSchema.parse(flags.provider ?? defaultCliLlmProvider());
      const cliConfig: { provider: LlmProviderId; model?: string; baseUrl?: string } = {
        provider,
      };
      if (flags.model !== undefined) cliConfig.model = flags.model;
      if (flags.baseUrl !== undefined) cliConfig.baseUrl = flags.baseUrl;

      const resolved = resolveLlmConfig(cliConfig);
      const validity = validateLlmConfigReady(resolved);
      if (!validity.ok) {
        logger.error({ provider }, validity.reason);
        process.exit(EXIT_CONFIG_MISSING);
      }

      logger.info(
        {
          provider: resolved.provider,
          model: resolved.model,
          baseUrl: resolved.baseUrl,
          hasApiKey: true,
        },
        "llm ping: starting",
      );

      const timeoutRaw = flags.timeout ?? "15000";
      const timeoutMs = Number(timeoutRaw);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
        logger.error({ timeout: flags.timeout }, "Invalid --timeout value. Must be a positive integer in milliseconds.");
        process.exitCode = 2;
        return;
      }

      const adapter = createLlmAdapter({
        provider: resolved.provider,
        apiKey: resolved.apiKey!,
        baseUrl: resolved.baseUrl!,
        defaultModel: resolved.model!,
        timeoutMs,
      });

      try {
        const t0 = Date.now();
        const resp = await adapter.chat({
          model: resolved.model!,
          messages: [
            {
              role: "user",
              content: 'Respond with the exact word: "ok"',
            },
          ],
          maxTokens: 16,
          temperature: 0,
        });
        const durationMs = Date.now() - t0;
        logger.info(
          {
            durationMs,
            model: resp.model,
            finishReason: resp.finishReason,
            usage: resp.usage,
            sample: resp.content.slice(0, 64),
          },
          "llm ping: ok",
        );
      } catch (err: unknown) {
        if (isLlmError(err)) {
          logger.error(
            {
              kind: err.kind,
              provider: err.context.provider,
              model: err.context.model,
              httpStatus: err.context.httpStatus,
              providerCode: err.context.providerCode,
              retriable: err.context.retriable,
            },
            err.message,
          );
          process.exit(exitCodeForLlmKind(err.kind));
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message }, "llm ping: failed");
        process.exit(1);
      }
    });
};
