import type { Command } from "commander";
import { logger } from "../logger.js";

/**
 * `subtitle` is retired (ADR-0005) — subtitle generation lives in `yt2x video`'s `--deliver`/`--from`
 * flags now; `audit`/`repair`/`transcribe-local` moved to `subtitle-tools`. Hidden from `--help`,
 * kept only so anyone still typing `yt2x subtitle` gets pointed at the replacement instead of
 * Commander's raw "unknown command" error.
 */
export const registerSubtitleCommand = (program: Command): void => {
  program
    .command("subtitle", { hidden: true })
    .description("Retired — see `yt2x video --help` and `yt2x subtitle-tools --help`.")
    .allowUnknownOption()
    // Old flags like `--video-id <id>` take a value as a separate token
    // (e.g. `--video-id abc123`). Since this stub declares none of them,
    // allowUnknownOption() alone still leaves the *value* token ("abc123")
    // looking like an excess positional argument to Commander, which would
    // raise its own "too many arguments" parse error before the action
    // handler below ever runs. allowExcessArguments() suppresses that too.
    .allowExcessArguments()
    .action(() => {
      logger.error(
        {},
        "`yt2x subtitle` has been replaced. Use `yt2x video --deliver <tier> --video-id <id>` " +
          "for subtitle generation/burning, or `yt2x subtitle-tools audit|repair|transcribe-local` " +
          "for the diagnostic subcommands.",
      );
      process.exitCode = 1;
    });
};
