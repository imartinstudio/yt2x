import type { Command } from "commander";
import { addLlmOptions } from "./_shared.js";
import { executeNativeDub, type DubFlags } from "../orchestrator/native-dub.js";

export { executeNativeDub, type DubFlags };

export const registerDubCommand = (program: Command): void => {
  const cmd = program
    .command("dub")
    .description(
      "Generate a Chinese dubbed video: segment the local word-level transcript into utterances, translate " +
        "them against a duration budget, synthesize (edge-tts or ElevenLabs), separate BGM via Demucs, " +
        "negotiate timing, gate quality, then remix into full.zh-dubbed.mp4.",
    );

  addLlmOptions(
    cmd
      .option("--video-id <id>", "Video ID under --out-dir / --article-out-dir")
      .option("--out-dir <path>", "Downloaded source root")
      .option("--article-out-dir <path>", "Article artifact root (default: files/articles)")
      .option("--dub-engine <id>", "TTS engine: edge-tts (default) | elevenlabs")
      .option(
        "--voice <id>",
        "TTS voice id (edge-tts default zh-CN-YunxiNeural; ElevenLabs requires --voice or ELEVENLABS_VOICE_ID)",
      )
      .option("--tts-command <path>", "Path to the edge-tts executable (default: edge-tts on PATH)")
      .option("--elevenlabs-base-url <url>", "ElevenLabs API base URL override")
      .option("--elevenlabs-model <id>", "ElevenLabs model id (default: eleven_multilingual_v2)")
      .option("--ffprobe-path <path>", "Path to ffprobe (default: ffprobe on PATH)")
      .option("--ffmpeg-path <path>", "Path to ffmpeg (default: ffmpeg on PATH)")
      .option("--python-path <path>", "Python with demucs installed (default: python3)")
      .option("--demucs-model <name>", "Demucs model name (default: htdemucs)")
      .option("--max-duration-ms <ms>", "Max duration per utterance before a hard split (default 12000)")
      .option("--script-only", "Write dub-script.json and stop before synthesis")
      .option("--timing-only", "Stop after natural-rate synthesis and dub-timing.json")
      .option("--skip-burn", "Replace audio only; do not burn the reverse SRT")
      .option("--skip-gate", "Write dub-report.json but do not block on hard gate failures")
      .option(
        "--start-ms <ms>",
        "Only dub utterances overlapping [start, end); extracts a temp window (never writes into downloads)",
      )
      .option("--end-ms <ms>", "Exclusive end of the dub time window in source timeline ms")
      .option("--force", "Re-run even when dubbed video / intermediate artifacts already exist"),
  ).action(async (flags: DubFlags) => {
    process.exitCode = await executeNativeDub(flags);
  });
};
