import type { Command } from "commander";
import { addCommonSourceOptions, runAcquireStage, type SingleStageFlags } from "./_shared.js";

export const registerAcquireCommand = (program: Command): void => {
  const cmd = program
    .command("acquire")
    .description("Download metadata / subtitles / keyframes only");
  addCommonSourceOptions(cmd)
    .option("--mode <mode>", "Stage mode: auto|review|skip", "auto")
    .option("--keyframes <n>", "Scene-detection keyframes (0 to skip; default 0)", "0")
    .option("--jobs <n>", "Parallel download jobs", "3")
    .option("--sub-langs <lang>", "Subtitle language override")
    .option("--scene-threshold <n>", "Scene detection threshold", "0.35")
    .option("--scene-min-gap <n>", "Scene minimum gap (seconds)", "12")
    .option("--max-words <n>", "Max words per transcript chunk", "900")
    .option("--cookies-from-browser <name>", "yt-dlp browser cookies")
    .option("--proxy <url>", "yt-dlp proxy")
    .option("--error-strategy <mode>", "On failure: stop|skip", "stop")
    .action((flags: SingleStageFlags) => runAcquireStage(flags));
};
