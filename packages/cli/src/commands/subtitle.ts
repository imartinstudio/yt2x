import type { Command } from "commander";
import { addCommonSourceOptions, addLlmOptions } from "./_shared.js";
import { executeNativeSubtitle, type SubtitleFlags } from "../orchestrator/native-subtitle.js";

export { executeNativeSubtitle, type SubtitleFlags };

const runSubtitle = async (flags: SubtitleFlags): Promise<void> => {
  process.exitCode = await executeNativeSubtitle(flags);
};

export const registerSubtitleCommand = (program: Command): void => {
  const cmd = program
    .command("subtitle")
    .description("Run subtitle pipeline for an already acquired video (source → translate → burn)");

  addLlmOptions(
    addCommonSourceOptions(cmd)
      .option("--video-id <id>", "Video ID under --out-dir (e.g., files/downloads/<id>)")
      .option("--subtitle-zh <mode>", "Subtitle mode: off|srt|burned|both", "srt")
      .option("--subtitle-source-lang <lang>", "Subtitle source language", "en")
      .option("--subtitle-target-lang <lang>", "Subtitle target language", "zh-CN")
      .option("--subtitle-source <mode>", "Subtitle source: auto|youtube|transcribe|file", "auto")
      .option("--subtitle-file <path>", "Existing SRT/VTT subtitle file when --subtitle-source file")
      .option("--article-out-dir <path>", "Output dir for burned video (default: files/articles)"),
  ).action(async (flags: SubtitleFlags) => {
    await runSubtitle(flags);
  });
};
