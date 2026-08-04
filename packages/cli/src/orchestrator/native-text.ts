import { logger } from "../logger.js";
import { executeNativeArticle } from "./native-article.js";
import { executeNativeNotes } from "./native-notes.js";
import { mergePipelineExitCode } from "./native-pipeline.js";
import { NATIVE_EXIT } from "./native-stage-common.js";

export type TextFlags = {
  videoId?: string[];
  outDir?: string;
  articleOutDir?: string;
  notes?: string;
  article?: string;
  platform?: string;
  maxChars?: string;
  rewriteMode?: string;
  targets?: string;
  platformTargets?: string;
  errorStrategy?: string;
  force?: boolean;
  llmProvider?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  verbose?: boolean;
};

/** 没有 publish 阶段、没有 deconstruct 阶段——本 plan 的既定范围决策（ADR-0005「两条命令由 shell 串接」）。 */
export const executeNativeText = async (flags: TextFlags): Promise<number> => {
  const videoIds = flags.videoId ?? [];
  if (videoIds.length === 0) {
    logger.error({}, "--video-id is required. Usage: yt2x text --video-id <id...>");
    return NATIVE_EXIT.CONFIG_MISSING;
  }

  const notesMode = flags.notes ?? "auto";
  const articleMode = flags.article ?? "auto";
  const errorStrategy = (flags.errorStrategy as "stop" | "skip" | undefined) ?? "stop";

  const notesForId = (id: string) =>
    ({
      outDir: flags.outDir,
      llmProvider: flags.llmProvider,
      ...(flags.llmModel !== undefined ? { llmModel: flags.llmModel } : {}),
      ...(flags.llmBaseUrl !== undefined ? { llmBaseUrl: flags.llmBaseUrl } : {}),
      errorStrategy,
      verbose: flags.verbose ?? false,
      force: flags.force ?? false,
      showProgress: false,
      videoId: [id],
    }) as Parameters<typeof executeNativeNotes>[0];

  const articleForId = (id: string) =>
    ({
      ...notesForId(id),
      articleOutDir: flags.articleOutDir,
      platform: flags.platform ?? "x",
      maxChars: flags.maxChars ?? "280",
      rewriteMode: flags.rewriteMode ?? "rules",
      targets: flags.targets,
      platformTargets: flags.platformTargets,
    }) as Parameters<typeof executeNativeArticle>[0];

  let textExitCode = 0;

  if (notesMode !== "skip") {
    for (const id of videoIds) {
      const code = await executeNativeNotes(notesForId(id));
      if (code !== 0) {
        if (errorStrategy === "stop") return code;
        textExitCode = mergePipelineExitCode(textExitCode, code);
      }
    }
  }

  if (articleMode !== "skip") {
    for (const id of videoIds) {
      const code = await executeNativeArticle(articleForId(id));
      if (code !== 0) {
        if (errorStrategy === "stop") return code;
        textExitCode = mergePipelineExitCode(textExitCode, code);
      }
    }
  }

  return textExitCode;
};
