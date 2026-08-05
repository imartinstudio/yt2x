#!/usr/bin/env node
import "./config/bootstrap-env.js";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { registerArticleCommand } from "./commands/article.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerClipsCommand } from "./commands/clips.js";
import { registerDashboardCommand } from "./commands/dashboard.js";
import { registerDeconstructCommand } from "./commands/deconstruct.js";
import { registerDubCommand } from "./commands/dub.js";
import { registerDubReplayCommand } from "./commands/dub-replay.js";
import { registerInfoCommand } from "./commands/info.js";
import { registerLlmCommand } from "./commands/llm.js";
import { registerNotesCommand } from "./commands/notes.js";
import { registerPublishCommand } from "./commands/publish.js";
import { registerSubtitleCommand } from "./commands/subtitle.js";
import { registerSubtitleToolsCommand } from "./commands/subtitle-tools.js";
import { registerTextCommand } from "./commands/text.js";
import { registerVideoCommand } from "./commands/video.js";
import { registerWatermarkCommand } from "./commands/watermark.js";
import { registerWechatFormatCommand } from "./commands/wechat-format.js";
import { logger } from "./logger.js";

const program = new Command();
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: string };
const version = packageJson.version ?? "0.0.0";

program
  .name("yt2x")
  .description("YouTube → AI structured notes → platform-adapted long-form article → publish")
  .version(version, "-v, --version", "show version")
  .helpOption("-h, --help", "show help");

registerInfoCommand(program);
registerVideoCommand(program);
registerTextCommand(program);

// `pipeline`/`acquire` are retired (ADR-0005) — replaced by `yt2x video`/`yt2x text`. Hidden from
// `--help`, kept only so anyone still typing the old commands gets pointed at the replacement instead
// of Commander's raw "unknown command" error.
program
  .command("pipeline", { hidden: true })
  .description("Retired — see `yt2x video --help` and `yt2x text --help`.")
  .allowUnknownOption()
  .allowExcessArguments()
  .action(() => {
    logger.error(
      {},
      "`yt2x pipeline` has been replaced by two commands: `yt2x video --deliver <tier> --urls <url>` " +
        "for the video side, then `yt2x text --video-id <id>` for notes/article. Run `yt2x video --help` " +
        "or `yt2x text --help`.",
    );
    process.exitCode = 1;
  });

program
  .command("acquire", { hidden: true })
  .description("Retired — see `yt2x video --help`.")
  .allowUnknownOption()
  .allowExcessArguments()
  .action(() => {
    logger.error(
      {},
      "`yt2x acquire` has been replaced by `yt2x video --deliver <tier> --urls <url>` " +
        "(or --video-id to reuse already-downloaded material). Run `yt2x video --help`.",
    );
    process.exitCode = 1;
  });

registerNotesCommand(program);
registerArticleCommand(program);
registerPublishCommand(program);
registerSubtitleCommand(program);
registerSubtitleToolsCommand(program);
registerAuthCommand(program);
registerClipsCommand(program);
registerDashboardCommand(program);
registerDeconstructCommand(program);
registerDubCommand(program);
  registerDubReplayCommand(program);
registerLlmCommand(program);
registerWatermarkCommand(program);
registerWechatFormatCommand(program);

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "yt2x failed");
  process.exitCode = 1;
});
