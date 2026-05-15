import {
  type CommanderPipelineFlags,
  parseCommanderPipelineFlags,
} from "../args/commander-pipeline-flags.js";
import { defaultMonorepoRoot } from "../config/monorepo-root.js";
import { resolveLlmConfig } from "../config/env.js";
import { logger } from "../logger.js";
import { runNativePipeline } from "../orchestrator/native-pipeline.js";

export type PipelineRunDeps = {
  runNativePipeline: typeof runNativePipeline;
  defaultMonorepoRoot: typeof defaultMonorepoRoot;
};

const defaultDeps = (): PipelineRunDeps => ({
  runNativePipeline,
  defaultMonorepoRoot,
});

/**
 * `yt2x pipeline` 核心逻辑（可注入依赖，供单测 mock native 路径）。
 */
export const runPipelineCommand = async (
  flags: CommanderPipelineFlags,
  deps: PipelineRunDeps = defaultDeps(),
): Promise<number> => {
  const args = parseCommanderPipelineFlags(flags);
  const llm = resolveLlmConfig(args.llm);
  const monorepoRoot = deps.defaultMonorepoRoot();

  logger.info(
    {
      provider: llm.provider,
      model: llm.model,
      hasApiKey: llm.apiKey !== undefined,
      stages: args.stages,
    },
    "yt2x pipeline → native orchestrator",
  );
  return deps.runNativePipeline({
    args: { ...args, llm },
    monorepoRoot,
  });
};
