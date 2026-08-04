import type { Command } from "commander";
import { defaultCliLlmProvider } from "../config/env.js";
import { executeNativeVideo, type VideoFlags } from "../orchestrator/native-video.js";

export const registerVideoCommand = (program: Command): void => {
  program
    .command("video")
    .description(
      "Deliver one video artifact: download → transcribe → subtitle → dub. " +
        "Choose exactly one --deliver tier.",
    )
    .option("--urls <url...>", "One or more YouTube URLs")
    .option("--url-file <path>", "Text file with one URL per line")
    .option("--search <query>", 'YouTube search, optionally "query:N"')
    .option("--search-sort <mode>", 'With --search: order before taking N (only "views")')
    .option("--video-id <id...>", "Skip download, operate on already-acquired video(s)")
    .option("--out-dir <path>", "Output root directory")
    .option("--article-out-dir <path>", "Article/burned-video output root directory")
    .requiredOption(
      "--deliver <tier>",
      "What to produce: none|zh-srt|zh-burned|bilingual-srt|bilingual-burned|dubbed",
    )
    .option(
      "--from <channel>",
      "Subtitle source channel override: youtube|transcribe|local|local-words|file " +
        "(default: auto-detect; dubbed defaults to local-words)",
    )
    .option("--subtitle-file <path>", "Existing SRT/VTT subtitle file when --from file")
    .option("--keyframes <n>", "Scene-detection keyframes (0 to skip)", "0")
    .option("--jobs <n>", "Parallel download jobs", "3")
    .option("--sub-langs <lang>", "Subtitle language override")
    .option("--scene-threshold <n>", "Scene detection threshold", "0.35")
    .option("--scene-min-gap <n>", "Scene minimum gap (seconds)", "12")
    .option("--max-words <n>", "Max words per transcript chunk", "900")
    .option("--cookies-from-browser <name>", "yt-dlp browser cookies")
    .option("--proxy <url>", "yt-dlp proxy")
    .option("--no-download-video", "Skip default video download")
    .option("--video-only", "Only download the video clip, skip subtitle/transcript work")
    .option("--video-start <time>", "Video clip start time (seconds, MM:SS, or HH:MM:SS)")
    .option("--video-end <time>", "Video clip end time")
    .option("--video-duration <seconds>", "Manual clip duration when --video-start omits --video-end", "30")
    .option("--dub-engine <id>", "With --deliver dubbed: TTS engine edge-tts (default) | elevenlabs")
    .option("--python-path <path>", "With --deliver dubbed: Python with demucs installed (auto-detected)")
    .option("--error-strategy <mode>", "On failure with multiple videos: stop|skip", "stop")
    .option("--force", "Overwrite existing output")
    .option("--llm-provider <id>", "LLM provider: openai|anthropic|deepseek|moonshot", defaultCliLlmProvider())
    .option("--llm-model <name>", "Override LLM model")
    .option("--llm-base-url <url>", "Override LLM base URL")
    .option("--verbose", "Detailed logging")
    .action(async (flags: VideoFlags) => {
      process.exitCode = await executeNativeVideo(flags);
    });
};
