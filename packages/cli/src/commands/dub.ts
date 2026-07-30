import type { Command } from "commander";
import { addLlmOptions } from "./_shared.js";
import { executeNativeDub, type DubFlags } from "../orchestrator/native-dub.js";

export { executeNativeDub, type DubFlags };

export const registerDubCommand = (program: Command): void => {
  const cmd = program
    .command("dub")
    .description(
      "Generate a Chinese dubbing script from full.zh.srt and synthesize it line by line (edge-tts). " +
        "Writes dub-script.json, dub-timing.json and lines/*.mp3; does not touch the video.",
    );

  addLlmOptions(
    cmd
      .option("--video-id <id>", "Video ID under --out-dir / --article-out-dir")
      .option("--out-dir <path>", "Downloaded source root")
      .option("--article-out-dir <path>", "Article artifact root (default: files/articles)")
      .option("--voice <id>", "TTS voice id (default: zh-CN-YunxiNeural)")
      .option("--tts-command <path>", "Path to the edge-tts executable (default: edge-tts on PATH)")
      .option("--ffprobe-path <path>", "Path to ffprobe (default: ffprobe on PATH)")
      .option("--max-gap-ms <ms>", "Split merged sentences on pauses longer than this")
      .option("--max-chars <n>", "Max characters per merged sentence")
      .option("--max-duration-ms <ms>", "Max duration per merged sentence")
      .option("--script-only", "Write dub-script.json and stop before synthesis")
      .option("--force", "Re-run even when dub artifacts already exist"),
  ).action(async (flags: DubFlags) => {
    process.exitCode = await executeNativeDub(flags);
  });
};
