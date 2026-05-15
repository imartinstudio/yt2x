import { CORE_VERSION } from "@yt2x/core";
import type { Command } from "commander";

export const registerInfoCommand = (program: Command): void => {
  program
    .command("info")
    .description("Show runtime info")
    .action(() => {
      const info = {
        cliVersion: "0.0.0",
        coreVersion: CORE_VERSION,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        note: "Native acquire + orchestrator (notes → article → publish).",
      };
      process.stdout.write(JSON.stringify(info, null, 2) + "\n");
    });
};
