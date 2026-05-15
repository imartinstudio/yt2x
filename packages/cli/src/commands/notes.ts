import type { Command } from "commander";
import { addCommonSourceOptions, addLlmOptions } from "./_shared.js";
import { executeNativeNotes, type NotesFlags } from "../orchestrator/native-notes.js";

export { executeNativeNotes, type NotesFlags };

const runNativeNotes = async (flags: NotesFlags): Promise<void> => {
  process.exitCode = await executeNativeNotes(flags);
};

export const registerNotesCommand = (program: Command): void => {
  const cmd = program
    .command("notes")
    .description("Generate structured AI notes (native LLM via @yt2x/adapters-node).");

  addLlmOptions(
    addCommonSourceOptions(cmd)
      .option("--error-strategy <mode>", "On failure: stop|skip", "stop")
      .option(
        "--video-id <id...>",
        "One or more video IDs (or absolute paths). Required without --all.",
      )
      .option("--all", "Process every video dir with chunks.md but no structured-notes.md")
      .option("--force", "Overwrite existing structured-notes.md"),
  ).action(async (flags: NotesFlags) => {
    await runNativeNotes(flags);
  });
};
