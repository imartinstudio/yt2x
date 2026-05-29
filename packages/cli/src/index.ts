#!/usr/bin/env node
import "./config/bootstrap-env.js";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { registerAcquireCommand } from "./commands/acquire.js";
import { registerArticleCommand } from "./commands/article.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerInfoCommand } from "./commands/info.js";
import { registerLlmCommand } from "./commands/llm.js";
import { registerNotesCommand } from "./commands/notes.js";
import { registerPipelineCommand } from "./commands/pipeline.js";
import { registerPublishCommand } from "./commands/publish.js";
import { registerSubtitleCommand } from "./commands/subtitle.js";
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
registerPipelineCommand(program);
registerAcquireCommand(program);
registerNotesCommand(program);
registerArticleCommand(program);
registerPublishCommand(program);
registerSubtitleCommand(program);
registerAuthCommand(program);
registerLlmCommand(program);

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "yt2x failed");
  process.exitCode = 1;
});
