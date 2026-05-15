import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_OUT_DIR,
  findPendingVideoDirs,
  generateNotesContent,
  patchProcessStatus,
  patchStepRunning,
  readVideoArtifacts,
  writeStructuredNotes,
} from "@yt2x/adapters-node";
import { isLlmError } from "@yt2x/core";
import { logger } from "../logger.js";
import type { SingleStageFlags } from "../commands/command-flags.js";
import {
  NATIVE_EXIT,
  exitFromLlmKind,
  patchLlmStepFailed,
  resolveBatchVideoDirs,
  resolveNativeLlm,
} from "./native-stage-common.js";

export type NotesFlags = SingleStageFlags & {
  videoId?: string[];
  all?: boolean;
  force?: boolean;
};

/** 供 `pipeline` 编排器与 `yt2x notes` 调用；返回进程退出码（0 表示成功）。 */
export const executeNativeNotes = async (flags: NotesFlags): Promise<number> => {
  const outDir = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
  await mkdir(outDir, { recursive: true });

  const llm = resolveNativeLlm(flags);
  if (!llm.ok) {
    logger.error({ reason: llm.reason }, "yt2x notes: LLM config invalid");
    return llm.exitCode;
  }

  const batch = await resolveBatchVideoDirs({
    outDir,
    findAllPending: () => findPendingVideoDirs(outDir),
    ...(flags.all === true ? { all: true as const } : {}),
    ...(flags.videoId !== undefined && flags.videoId.length > 0 ? { videoId: flags.videoId } : {}),
  });
  if (!batch.ok) {
    if (batch.reason === "empty_pending") {
      logger.warn({ outDir }, "No pending video directories (no chunks.md without structured-notes.md).");
    } else {
      logger.error(
        "Notes requires --video-id <id...> or --all. Example: yt2x notes --video-id dQw4w9WgXcQ",
      );
    }
    return batch.exitCode;
  }
  const targets = batch.targets;

  logger.info(
    { provider: llm.provider, model: llm.model, targets: targets.length, outDir },
    "yt2x notes (native): starting",
  );

  let promptTokens = 0;
  let completionTokens = 0;
  const errors: Array<{ videoDir: string; message: string }> = [];

  for (const videoDir of targets) {
    try {
      const artifacts = await readVideoArtifacts(videoDir);
      const identity = {
        videoId: artifacts.videoId,
        url:
          typeof artifacts.metadata.webpage_url === "string" && artifacts.metadata.webpage_url.trim() !== ""
            ? artifacts.metadata.webpage_url
            : `https://www.youtube.com/watch?v=${encodeURIComponent(artifacts.videoId)}`,
      };
      await patchStepRunning(videoDir, identity, "notes").catch(() => {});
      logger.info(
        { videoId: artifacts.videoId, model: llm.model },
        "yt2x notes: calling LLM (may take several minutes for long videos)…",
      );
      const t0 = Date.now();
      const result = await generateNotesContent({
        llm: llm.adapter,
        model: llm.model,
        artifacts,
      });
      const written = await writeStructuredNotes(videoDir, result.content, {
        force: flags.force === true,
      });
      const durationMs = Date.now() - t0;
      const finishedAt = new Date().toISOString();
      await patchProcessStatus(videoDir, identity, {
        step: "notes",
        stepInfo: {
          status: "done",
          finishedAt,
          durationMs,
          artifacts: ["structured-notes.md"],
          resultFile: path.basename(written),
        },
      });
      if (result.usage !== undefined) {
        promptTokens += result.usage.promptTokens;
        completionTokens += result.usage.completionTokens;
      }
      logger.info(
        {
          videoId: result.videoId,
          file: written,
          model: result.model,
          finishReason: result.finishReason,
          durationMs,
          usage: result.usage,
        },
        "notes generated",
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ videoDir, message });
      logger.error({ videoDir, err: message }, "notes failed");
      try {
        await patchLlmStepFailed(videoDir, "notes", err);
      } catch {
        // 状态写入失败不掩盖原始错误
      }
      if (isLlmError(err)) {
        if (flags.errorStrategy !== "skip") return exitFromLlmKind(err.kind);
      } else if (flags.errorStrategy !== "skip") {
        return 1;
      }
    }
  }

  logger.info(
    {
      ok: targets.length - errors.length,
      failed: errors.length,
      totalPromptTokens: promptTokens,
      totalCompletionTokens: completionTokens,
    },
    "yt2x notes (native): done",
  );
  if (errors.length > 0) return NATIVE_EXIT.PARTIAL_FAILURE;
  return 0;
};
