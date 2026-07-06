import { mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_OUT_DIR,
  findPendingVideoDirs,
  generateNotesContent,
  isStepDone,
  patchProcessStatus,
  patchStepRunning,
  readVideoArtifacts,
  type ReadArtifactsError,
  writeStructuredNotes,
} from "@yt2x/adapters-node";
import { isLlmError } from "@yt2x/core";
import { logger } from "../logger.js";
import type { SingleStageFlags } from "../commands/command-flags.js";
import { printCliErrorBlock } from "../diagnostics/error-format.js";
import { createCommandProgress } from "../progress/pipeline-progress.js";
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
  showProgress?: boolean;
};

const isReadArtifactsError = (err: unknown): err is Error & ReadArtifactsError =>
  err instanceof Error &&
  Array.isArray((err as Partial<ReadArtifactsError>).missing) &&
  typeof (err as Partial<ReadArtifactsError>).videoDir === "string";

/** 供 `pipeline` 编排器与 `yt2x notes` 调用；返回进程退出码（0 表示成功）。 */
export const executeNativeNotes = async (flags: NotesFlags): Promise<number> => {
  const outDir = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
  await mkdir(outDir, { recursive: true });

  const llm = resolveNativeLlm(flags);
  if (!llm.ok) {
    printCliErrorBlock({
      command: "notes",
      reason: llm.reason,
      hints: ["Configure an LLM provider and API key before generating notes."],
      retryCommand: "pnpm yt2x llm ping",
    });
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
      printCliErrorBlock({
        command: "notes",
        reason: "No pending video directories found.",
        details: outDir,
        hints: ["Pending notes require chunks.md and no existing structured-notes.md."],
        retryCommand: "pnpm yt2x notes --video-id <videoId>",
      });
    } else {
      printCliErrorBlock({
        command: "notes",
        reason: "Missing target. Notes requires --video-id <id...> or --all.",
        hints: ["Run acquire first, then pass the generated video directory name."],
        retryCommand: "pnpm yt2x notes --video-id <videoId>",
      });
    }
    return batch.exitCode;
  }
  const targets = batch.targets;
  const progress = flags.showProgress === false ? undefined : createCommandProgress("notes", targets.length);
  let exitCode = 1;

  logger.info(
    { provider: llm.provider, model: llm.model, targets: targets.length, outDir },
    "yt2x notes (native): starting",
  );

  let promptTokens = 0;
  let completionTokens = 0;
  const errors: Array<{ videoDir: string; message: string }> = [];

  for (const videoDir of targets) {
    const stageT0 = performance.now();
    let progressKey = `notes.${path.basename(videoDir)}`;
    try {
      const artifacts = await readVideoArtifacts(videoDir);
      progressKey = `notes.${artifacts.videoId}`;
      progress?.setActive(`notes · ${artifacts.videoId}`);
      const identity = {
        videoId: artifacts.videoId,
        url:
          typeof artifacts.metadata.webpage_url === "string" && artifacts.metadata.webpage_url.trim() !== ""
            ? artifacts.metadata.webpage_url
            : `https://www.youtube.com/watch?v=${encodeURIComponent(artifacts.videoId)}`,
      };

      // Pre-check: if structured-notes.md already exists and !force, skip before LLM call.
      if (flags.force !== true && (await isStepDone(videoDir, "notes"))) {
        logger.info({ videoId: artifacts.videoId }, "structured-notes.md already exists, skipping");
        continue;
      }

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
      if (written === null) {
        logger.info({ videoDir }, "structured-notes.md already exists, skipping");
        continue;
      }
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
      progress?.record(progressKey, Math.round(performance.now() - stageT0));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ videoDir, message });
      printCliErrorBlock({
        command: "notes",
        subject: path.basename(videoDir),
        reason: message,
        ...(isReadArtifactsError(err) ? {} : { details: path.join(videoDir, "process-status.json") }),
        hints: ["Ensure acquire completed successfully before generating notes."],
        retryCommand: `pnpm yt2x notes --video-id ${path.basename(videoDir)}`,
      });
      if (!isReadArtifactsError(err)) {
        try {
          await patchLlmStepFailed(videoDir, "notes", err);
        } catch {
          // 状态写入失败不掩盖原始错误
        }
      }
      if (isLlmError(err)) {
        if (flags.errorStrategy !== "skip") {
          progress?.clear();
          return exitFromLlmKind(err.kind);
        }
      } else if (flags.errorStrategy !== "skip") {
        progress?.clear();
        return 1;
      }
      progress?.record(progressKey, Math.round(performance.now() - stageT0));
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
  exitCode = errors.length > 0 ? NATIVE_EXIT.PARTIAL_FAILURE : 0;
  if (exitCode === 0) {
    progress?.printSummary();
  } else {
    progress?.clear();
  }
  return exitCode;
};
