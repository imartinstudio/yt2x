import type { Command } from "commander";
import { DEFAULT_ARTICLE_OUT_DIR } from "@yt2x/adapters-node";
import { addCommonSourceOptions } from "./_shared.js";
import { executeNativePublish, type PublishFlags } from "../orchestrator/native-publish.js";

export { executeNativePublish, type PublishFlags };

const runNativePublish = async (flags: PublishFlags): Promise<void> => {
  process.exitCode = await executeNativePublish(flags);
};

export const registerPublishCommand = (program: Command): void => {
  const cmd = program
    .command("publish")
    .description("Preview article or publish generated X short/thread content.");

  addCommonSourceOptions(cmd)
    .option("--video-id <id>", "Video id under --article-out-dir")
    .option(
      "--article-out-dir <path>",
      "Root of article dirs (default: files/articles)",
      DEFAULT_ARTICLE_OUT_DIR,
    )
    .option("--article-dir <path>", "Explicit article dir (skips auto-discovery)")
    .option("--profile <name>", "Credentials profile", "default")
    .option("--publish-max-chars <n>", "Per-tweet character limit for x-thread (default 500)")
    .option("--max-chars <n>", "Alias of --publish-max-chars")
    .option("--target <target>", "Publish target: article|x-thread|x-short|x-thread-short")
    .option("--thread-source <source>", "Thread source: generated|article|auto", "generated")
    .option("--thread", "Compatibility alias for --target x-thread", false)
    .option("--max-tweets <n>", "Max tweets when publishing x-thread (default 8; x-thread-short default 10)")
    .option(" --thread-delay <seconds|range>", "Delay between thread tweets in seconds (default 20-30; 0 disables)")
    .option("--premium", "Premium account: allow longer single post for article (default 4000 chars)", false)
    .option("--numbering", "Prefix tweets with ①②③ (thread mode only)", false)
    .option("--continue-on-failure", "Keep posting remaining tweets if one fails (thread mode)", false)
    .option("--dry-run", "Preview without calling X API", false)
    .action(async (flags: PublishFlags) => {
      await runNativePublish(flags);
    });
};
