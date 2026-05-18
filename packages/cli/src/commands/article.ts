import type { Command } from "commander";
import { DEFAULT_ARTICLE_OUT_DIR } from "@yt2x/adapters-node";
import { addCommonSourceOptions, addLlmOptions } from "./_shared.js";
import { executeNativeArticle, type ArticleFlags } from "../orchestrator/native-article.js";

export { executeNativeArticle, type ArticleFlags };

const runNativeArticle = async (flags: ArticleFlags): Promise<void> => {
  process.exitCode = await executeNativeArticle(flags);
};

export const registerArticleCommand = (program: Command): void => {
  const cmd = program
    .command("article")
    .description("Generate X long-form article from notes (native LLM + flat output under files/articles).");
  addLlmOptions(
    addCommonSourceOptions(cmd)
      .option("--platform <name>", "Target platform (x only for now)", "x")
      .option(
        "--targets <targets>",
        "Comma-separated output targets: article,x-thread,x-short,all",
      )
      .option("--error-strategy <mode>", "On failure: stop|skip", "stop")
      .option(
        "--article-out-dir <path>",
        "Output root; each video becomes <dir>/<videoId>/article.md",
        DEFAULT_ARTICLE_OUT_DIR,
      )
      .option(
        "--video-id <id...>",
        "One or more video IDs under --out-dir (notes root), or absolute paths to video dirs",
      )
      .option(
        "--all",
        "Every notes dir with structured-notes.md and no article.md under --article-out-dir yet",
      )
      .option("--force", "Overwrite existing article.md / run.json"),
  ).action(async (flags: ArticleFlags) => {
    await runNativeArticle(flags);
  });
};
