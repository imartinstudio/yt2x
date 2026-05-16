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
    .description("Publish article to X as one long post (default) or a reply thread.");

  addCommonSourceOptions(cmd)
    .option("--video-id <id>", "Video id under --article-out-dir")
    .option(
      "--article-out-dir <path>",
      "Root of article dirs (default: files/articles)",
      DEFAULT_ARTICLE_OUT_DIR,
    )
    .option("--article-dir <path>", "Explicit article dir (skips auto-discovery)")
    .option("--profile <name>", "Credentials profile", "default")
    .option("--publish-max-chars <n>", "Long-post char limit (default 25000) or per-tweet with --thread")
    .option("--max-chars <n>", "Alias of --publish-max-chars")
    .option("--target <target>", "Publish target: x-longform|x-thread|x-short")
    .option("--thread-source <source>", "Thread source: generated|article|auto", "article")
    .option("--thread", "Split into reply thread (280 chars/tweet) instead of one long post", false)
    .option("--max-tweets <n>", "Max tweets when using --thread", "25")
    .option("--numbering", "Prefix tweets with ①②③ (thread mode only)", false)
    .option("--continue-on-failure", "Keep posting remaining tweets if one fails (thread mode)", false)
    .option("--dry-run", "Preview without calling X API", false)
    .action(async (flags: PublishFlags) => {
      await runNativePublish(flags);
    });
};
