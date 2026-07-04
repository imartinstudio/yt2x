import type { Command } from "commander";
import path from "node:path";
import {
  checkWechatFormatter,
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_WECHAT_FORMAT_THEME,
  formatWechatArticle,
} from "@yt2x/adapters-node";
import { logger } from "../logger.js";

export type WechatFormatCheckFlags = {
  formatterDir?: string;
  python?: string;
};

export type WechatFormatFlags = WechatFormatCheckFlags & {
  videoId?: string;
  articleDir?: string;
  articleOutDir?: string;
  theme?: string;
  outputDir?: string;
};

const VIDEO_ID_RE = /^[A-Za-z0-9_-]+$/;

const readCommandOptions = <T extends Record<string, unknown>>(
  value: T | Command,
  command?: Command,
): T => {
  const cmd = command ?? (typeof (value as Command).opts === "function" ? value as Command : undefined);
  if (cmd === undefined) return value as T;
  return {
    ...(cmd.parent?.opts() as Record<string, unknown> | undefined),
    ...(cmd.opts() as Record<string, unknown>),
  } as T;
};

const resolveArticleDir = (flags: WechatFormatFlags): string => {
  if (flags.articleDir !== undefined && flags.articleDir.trim().length > 0) {
    return path.resolve(flags.articleDir);
  }
  const videoId = flags.videoId?.trim();
  if (videoId === undefined || videoId.length === 0) {
    throw new Error("Missing target. Pass --video-id <videoId> or --article-dir <path>.");
  }
  if (!VIDEO_ID_RE.test(videoId)) {
    throw new Error("Invalid --video-id. Expected alphanumeric, hyphens, and underscores only.");
  }
  return path.join(path.resolve(flags.articleOutDir ?? DEFAULT_ARTICLE_OUT_DIR), videoId);
};

export const runWechatFormatCheckCommand = async (
  _flags: WechatFormatCheckFlags,
): Promise<number> => {
  const result = await checkWechatFormatter();
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
};

export const runWechatFormatCommand = async (flags: WechatFormatFlags): Promise<number> => {
  try {
    const articleDir = resolveArticleDir(flags);
    logger.info({ articleDir, theme: flags.theme ?? DEFAULT_WECHAT_FORMAT_THEME }, "yt2x wechat-format: starting");
    const result = await formatWechatArticle({
      articleDir,
      ...(flags.theme !== undefined ? { theme: flags.theme } : {}),
      ...(flags.outputDir !== undefined ? { outputDir: flags.outputDir } : {}),
    });

    console.log("\n✅ 公众号排版完成");
    console.log(`   Theme: ${result.theme}`);
    console.log(`   HTML: ${result.articleHtmlPath}`);
    console.log(`   Preview: ${result.previewHtmlPath}`);
    console.log(`   Output: ${result.formattedDir}`);
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "yt2x wechat-format failed");
    console.error(msg);
    return 1;
  }
};

export const registerWechatFormatCommand = (program: Command): void => {
  const cmd = program
    .command("wechat-format")
    .description("Format article.md with the built-in WeChat formatter")
    .option("--video-id <id>", "Video id under --article-out-dir")
    .option("--article-dir <path>", "Direct article directory containing article.md")
    .option("--article-out-dir <path>", "Root of article dirs (default: files/articles)", DEFAULT_ARTICLE_OUT_DIR)
    .option("--theme <name>", "WeChat theme (github, newspaper, minimal)", DEFAULT_WECHAT_FORMAT_THEME)
    .option("--output-dir <path>", "Formatter output base dir (default: <articleDir>/wechat-format)")
    .action(async (flags: WechatFormatFlags | Command, command?: Command) => {
      process.exitCode = await runWechatFormatCommand(readCommandOptions<WechatFormatFlags>(flags, command));
    });

  cmd
    .command("check")
    .description("Check that WeChat formatter is ready (always succeeds — formatter is built-in)")
    .option("--formatter-dir <path>", "(deprecated — formatter is built-in)")
    .option("--python <bin>", "(deprecated — formatter is built-in)")
    .action(async (flags: WechatFormatCheckFlags | Command, command?: Command) => {
      process.exitCode = await runWechatFormatCheckCommand(readCommandOptions<WechatFormatCheckFlags>(flags, command));
    });
};
