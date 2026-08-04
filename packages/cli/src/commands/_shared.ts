import type { Command } from "commander";
import { defaultCliLlmProvider } from "../config/env.js";

export const addCommonSourceOptions = (cmd: Command): Command =>
  cmd
    .option("--urls <url...>", "One or more YouTube URLs")
    .option("--url-file <path>", "Text file with one URL per line")
    .option("--search <query>", 'YouTube search, optionally "query:N"')
    .option(
      "--search-sort <mode>",
      'With --search: order before taking N (only "views" = by view count desc)',
    )
    .option("--out-dir <path>", "Output root directory")
    .option("--verbose", "Detailed logging");

export const addLlmOptions = (cmd: Command): Command =>
  cmd
    .option(
      "--llm-provider <id>",
      "LLM provider: openai|anthropic|deepseek|moonshot (default: $YT2X_LLM_PROVIDER or openai)",
      defaultCliLlmProvider(),
    )
    .option("--llm-model <name>", "Override LLM model")
    .option("--llm-base-url <url>", "Override LLM base URL");
