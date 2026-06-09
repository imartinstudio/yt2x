import type { Command } from "commander";
import type { CommanderPipelineFlags } from "../args/commander-pipeline-flags.js";
import { defaultCliLlmProvider } from "../config/env.js";
import { runPipelineCommand } from "./pipeline-run.js";

export const registerPipelineCommand = (program: Command): void => {
  program
    .command("pipeline")
    .description(
      "Run the full YouTube → notes → article → publish pipeline (native acquire + orchestrator).",
    )
    .option("--urls <url...>", "One or more YouTube URLs (space-separated)")
    .option("--url-file <path>", "Text file with one URL per line")
    .option("--search <query>", 'YouTube search, optionally "query:N" for N results')
    .option(
      "--search-sort <mode>",
      'With --search: order before taking N (only "views" = by view count desc)',
    )
    .option("--acquire <mode>", "Stage mode: auto|review|skip", "auto")
    .option("--notes <mode>", "Stage mode: auto|review|skip", "review")
    .option("--article <mode>", "Stage mode: auto|review|skip", "review")
    .option("--publish <mode>", "Stage mode: auto|review|skip", "review")
    .option("--out-dir <path>", "Output root directory")
    .option("--keyframes <n>", "Scene-detection keyframes (0 to skip; default 0)", "0")
    .option("--platform <name>", "Target platform (x|wechat|newsletter|...)", "x")
    .option("--targets <targets>", "Article output targets: article,x-thread,x-short,all")
    .option("--max-chars <n>", "Article stage: hint max chars (legacy)", "280")
    .option("--publish-max-chars <n>", "Publish: per-tweet character limit for x-thread (default 500)")
    .option("--max-tweets <n>", "Publish: max tweets when using --thread (default 8, max 10)", "8")
    .option("--thread-delay <seconds|range>", "Publish: delay between thread tweets in seconds (default 20-30)")
    .option("--thread", "Publish as reply thread instead of article preview", false)
    .option("--rewrite-mode <mode>", "Article rewrite strategy: rules|llm", "rules")
    .option("--jobs <n>", "Parallel download jobs", "3")
    .option("--sub-langs <lang>", "Subtitle language override")
    .option("--scene-threshold <n>", "Scene detection threshold", "0.35")
    .option("--scene-min-gap <n>", "Scene minimum gap (seconds)", "12")
    .option("--max-words <n>", "Max words per transcript chunk", "900")
    .option("--cookies-from-browser <name>", "yt-dlp browser cookies")
    .option("--proxy <url>", "yt-dlp proxy")
    .option("--download-video", "Download a full MP4 video during acquire (default)")
    .option("--no-download-video", "Skip default video download during acquire")
    .option("--video-start <time>", "Video clip start time (seconds, MM:SS, or HH:MM:SS)")
    .option("--video-end <time>", "Video clip end time (seconds, MM:SS, or HH:MM:SS)")
    .option("--video-duration <seconds>", "Manual clip duration in seconds when --video-start omits --video-end", "30")
    .option("--subtitle-zh <mode>", "Prepare Chinese subtitle assets: off|srt|burned|both", "off")
    .option("--subtitle-source-lang <lang>", "Subtitle source language", "en")
    .option("--subtitle-target-lang <lang>", "Subtitle target language", "zh-CN")
    .option("--subtitle-source <mode>", "Subtitle source: auto|youtube|transcribe|file", "auto")
    .option("--subtitle-file <path>", "Existing SRT/VTT subtitle file when --subtitle-source file is used")
    .option("--continue-from", "Resume from last failed step")
    .option("--error-strategy <mode>", "On stage failure: stop|skip", "stop")
    .option("--force", "Overwrite existing structured-notes.md in native notes stage")
    .option("--publish-dry-run", "Preview publish output without posting to X")
    .option("--deconstruct <n>", "After article generation, auto-deconstruct into top N clips with posts (e.g. 5)")
    .option("--llm-provider <id>", "LLM provider: openai|anthropic|deepseek|moonshot", defaultCliLlmProvider())
    .option("--llm-model <name>", "Override LLM model")
    .option("--llm-base-url <url>", "Override LLM base URL")
    .option("--verbose", "Detailed logging")
    .action(async (flags: CommanderPipelineFlags) => {
      process.exitCode = await runPipelineCommand(flags);
    });
};
