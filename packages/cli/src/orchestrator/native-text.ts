import { logger } from "../logger.js";
import { executeNativeArticle } from "./native-article.js";
import { executeNativeNotes } from "./native-notes.js";
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

/**
 * `yt2x text`：单条文本交付编排（Plan 2 Task 4）——notes → article，围绕已获取的
 * `--video-id` 跑完整条链路，与既有的 `pipeline`/`notes`/`article` 命令并存，互不影响
 * （纯新增命令，不改动任何既有命令的行为）。没有 publish 阶段、没有 deconstruct 阶段——
 * 这是本 plan 的既定范围决策（ADR-0005「两条命令由 shell 串接」）。
 */
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

  if (notesMode !== "skip") {
    for (const id of videoIds) {
      const code = await executeNativeNotes(notesForId(id));
      if (code !== 0 && errorStrategy === "stop") return code;
    }
  }

  if (articleMode !== "skip") {
    for (const id of videoIds) {
      const code = await executeNativeArticle(articleForId(id));
      if (code !== 0 && errorStrategy === "stop") return code;
    }
  }

  return 0;
};
