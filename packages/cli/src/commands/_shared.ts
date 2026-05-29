import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { DEFAULT_OUT_DIR, executeNativeAcquire } from "@yt2x/adapters-node";
import { defaultCliLlmProvider } from "../config/env.js";
import { defaultMonorepoRoot } from "../config/monorepo-root.js";
import { logger } from "../logger.js";
import type { PipelineArgs } from "../args/pipeline.js";
import { createAcquireReviewPrompt } from "../orchestrator/acquire-review-prompt.js";
import { nativeAcquireOptionsFromPipelineArgs } from "../orchestrator/native-acquire-from-pipeline-args.js";
import { resolveNativeLlm } from "../orchestrator/native-stage-common.js";
import {
  acquireSubStepProgressFromHandle,
  createAcquireOnlyProgress,
  estimatePipelineVideoCount,
} from "../progress/pipeline-progress.js";
import type { SingleStageFlags } from "./command-flags.js";
import { projectSingleStage } from "./single-stage-projection.js";

export type { SingleStageFlags, SingleStageTarget } from "./command-flags.js";

export const addCommonSourceOptions = (cmd: Command): Command =>
  cmd
    .option("--urls <url...>", "One or more YouTube URLs")
    .option("--url-file <path>", "Text file with one URL per line")
    .option("--search <query>", 'YouTube search, optionally "query:N"')
    .option(
      "--search-sort <mode>",
      'With --search: order before taking N (only "views" = by view count desc)',
    )
    .option("--out-dir <path>", "Output root directory")
    .option("--verbose", "Detailed logging");

export const addLlmOptions = (cmd: Command): Command =>
  cmd
    .option(
      "--llm-provider <id>",
      "LLM provider: openai|anthropic|deepseek|moonshot (default: $YT2X_LLM_PROVIDER or openai)",
      defaultCliLlmProvider(),
    )
    .option("--llm-model <name>", "Override LLM model")
    .option("--llm-base-url <url>", "Override LLM base URL");

export const runAcquireStage = async (flags: SingleStageFlags): Promise<void> => {
  const args: PipelineArgs = projectSingleStage("acquire", flags);
  const monorepoRoot = defaultMonorepoRoot();
  const outRoot =
    args.control.outDir !== undefined
      ? path.resolve(args.control.outDir)
      : path.resolve(monorepoRoot, DEFAULT_OUT_DIR);
  await mkdir(outRoot, { recursive: true });
  logger.info({ stages: args.stages }, "yt2x acquire → native");
  const base = nativeAcquireOptionsFromPipelineArgs(args, { monorepoRoot, outDir: outRoot });
  const progress = createAcquireOnlyProgress(
    estimatePipelineVideoCount(args),
    args.acquire.keyframes,
  );

  const needsTranslation =
    args.acquire.subtitleZh === "srt" ||
    args.acquire.subtitleZh === "burned" ||
    args.acquire.subtitleZh === "both";
  let llmResult: ReturnType<typeof resolveNativeLlm> | undefined;
  if (needsTranslation) {
    llmResult = resolveNativeLlm(flags);
    if (!llmResult.ok) {
      logger.error({ reason: llmResult.reason }, "LLM config missing for subtitle translation");
      process.exitCode = llmResult.exitCode;
      return;
    }
  }

  let exitCode = 1;
  try {
    const code = await executeNativeAcquire({
      ...base,
      progress: acquireSubStepProgressFromHandle(progress, "acquire"),
      ...(args.stages.acquire === "review" ? { reviewPrompt: createAcquireReviewPrompt() } : {}),
      ...(llmResult?.ok === true
        ? { llm: llmResult.adapter, llmModel: llmResult.model }
        : {}),
    });
    exitCode = code;
    process.exitCode = code;
  } finally {
    if (exitCode === 0) {
      progress.printSummary();
    } else {
      progress.clear();
    }
  }
};
