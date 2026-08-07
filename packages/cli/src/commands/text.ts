import type { Command } from "commander";
import { defaultCliLlmProvider } from "../config/env.js";
import { executeNativeText, type TextFlags } from "../orchestrator/native-text.js";

export const registerTextCommand = (program: Command): void => {
  program
    .command("text")
    .description("Deliver one text artifact from an already-acquired video: notes → article.")
    .requiredOption("--video-id <id...>", "Already-acquired video id(s) — run `yt2x video` first")
    .option("--out-dir <path>", "Downloaded source root")
    .option("--article-out-dir <path>", "Article output root directory")
    .option("--notes <mode>", "Stage mode: auto|review|skip", "auto")
    .option("--article <mode>", "Stage mode: auto|review|skip", "auto")
    .option("--platform <name>", "Target platform (x|wechat|newsletter|...)", "x")
    .option("--max-chars <n>", "Article stage: hint max chars (legacy)", "280")
    .option("--targets <targets>", "Article output targets: article,x-thread,x-short,all")
    .option("--platform-targets <targets>", "Platform adaptations: xiaohongshu,wechat,bilibili,all-platforms")
    .option("--rewrite-mode <mode>", "Article rewrite strategy: rules|llm", "rules")
    .option("--error-strategy <mode>", "On failure with multiple videos: stop|skip", "stop")
    .option("--force", "Overwrite existing structured-notes.md")
    .option("--llm-provider <id>", "LLM provider: openai|anthropic|deepseek|moonshot", defaultCliLlmProvider())
    .option("--llm-model <name>", "Override LLM model")
    .option("--llm-base-url <url>", "Override LLM base URL")
    .option("--verbose", "Detailed logging")
    .action(async (flags: TextFlags) => {
      process.exitCode = await executeNativeText(flags);
    });
};
