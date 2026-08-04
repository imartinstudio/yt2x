import { access } from "node:fs/promises";
import path from "node:path";
import {
  defaultProcessRunner,
  dubbedVideoPathFor,
  probeDemucs,
  resolveDubWordsPath,
  transcribeLocal,
  type ProcessRunner,
} from "@yt2x/adapters-node";
import { logger } from "../logger.js";
import { resolveDubEngine, resolveDubTts, type DubFlags } from "./native-dub.js";
import { NATIVE_EXIT } from "./native-stage-common.js";

const hasDubbedVideo = async (articleOutRoot: string, id: string): Promise<boolean> =>
  access(dubbedVideoPathFor(articleOutRoot, id))
    .then(() => true)
    .catch(() => false);

/** 每个目标视频都已有 full.zh-dubbed.mp4 时，preflight（凭据/Demucs 探测）没有必要再跑。 */
export const allVideosAlreadyDubbed = async (
  articleOutRoot: string,
  ids: readonly string[],
): Promise<boolean> => {
  if (ids.length === 0) return false;
  for (const id of ids) {
    if (!(await hasDubbedVideo(articleOutRoot, id))) return false;
  }
  return true;
};

export type EnsureDubPreflightInput = {
  videoIds: readonly string[];
  outRoot: string;
  articleOutRoot: string;
  dubEngineFlag: string | undefined;
  force?: boolean;
  pythonPath?: string;
  runner?: ProcessRunner;
};

export type EnsureDubPreflightResult = { ok: true } | { ok: false; exitCode: number };

/**
 * 配音只存在于本地转录通道（docs/dub-context-glossary）：--dub 时确保每个视频都有本地
 * 词级时间戳，缺失就地转写；同时前置 Demucs 探测与 TTS 凭据校验。三者都放在
 * notes/article 之前 fail fast——不然要等 dub 阶段才报错时，notes + article 的整片
 * LLM 翻译费用已经花完了（demucs 缺失、ElevenLabs 凭据缺失，此前都只在 dub 阶段内部
 * 才被发现）。抽出来是为了让 `yt2x video --deliver dubbed` 复用同一套检查，不必复制一遍。
 */
export const ensureDubPreflight = async (
  input: EnsureDubPreflightInput,
): Promise<EnsureDubPreflightResult> => {
  // 每个目标视频都已有 full.zh-dubbed.mp4 且未 --force 时，preflight 探测的都是这次
  // 重跑根本用不到的东西——例如只想重跑 article 的机器可能压根没装 demucs。这类
  // 空跑必须仍然退出码 0，不能被 preflight 拖成 CONFIG_MISSING。
  const skipDubPreflight =
    input.force !== true && (await allVideosAlreadyDubbed(input.articleOutRoot, input.videoIds));

  if (skipDubPreflight) {
    logger.info(
      { videos: input.videoIds.length },
      "yt2x pipeline --dub: all target videos already have a dubbed output — " +
        "skipping demucs/TTS preflight (use --force to redo)",
    );
    return { ok: true };
  }

  let dubEngine;
  try {
    dubEngine = resolveDubEngine(input.dubEngineFlag);
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "yt2x pipeline --dub: invalid --dub-engine",
    );
    return { ok: false, exitCode: NATIVE_EXIT.CONFIG_MISSING };
  }

  const resolvedTts = resolveDubTts({ dubEngine: input.dubEngineFlag } as DubFlags, dubEngine);
  if (!resolvedTts.ok) {
    logger.error(
      { reason: resolvedTts.reason },
      "yt2x pipeline --dub: TTS credentials unavailable — checked before notes/article " +
        "so a missing ElevenLabs key doesn't waste an already-paid-for translation pass",
    );
    return { ok: false, exitCode: resolvedTts.exitCode };
  }

  try {
    const resolvedPythonPath = await probeDemucs({
      ...(input.pythonPath !== undefined ? { pythonPath: input.pythonPath } : {}),
    });
    // 记录实际用的 Python 解释器——未显式传 --python-path 时它来自 probeDemucs 内部的
    // 自动探测（含 .venv-demucs/bin/python3），CONTRIBUTING.md 要求默认值的选用要留痕。
    logger.info(
      { pythonPath: resolvedPythonPath },
      "yt2x pipeline --dub: resolved python interpreter for demucs",
    );
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "yt2x pipeline --dub: demucs unavailable — install demucs, or pass --python-path " +
        "to a Python that has it (e.g. `--python-path .venv-demucs/bin/python3`); checked " +
        "before notes/article to avoid wasted LLM cost",
    );
    return { ok: false, exitCode: NATIVE_EXIT.CONFIG_MISSING };
  }

  for (const id of input.videoIds) {
    const alreadyTranscribed = await resolveDubWordsPath({ outRoot: input.outRoot, videoId: id })
      .then(() => true)
      .catch(() => false);
    if (alreadyTranscribed) continue;

    logger.info(
      { videoId: id },
      "yt2x pipeline --dub: no local transcript found, transcribing now…",
    );
    const result = await transcribeLocal({
      videoDir: path.join(input.outRoot, id),
      language: "en",
      runner: input.runner ?? defaultProcessRunner,
    });
    if (result === undefined) {
      logger.error(
        { videoId: id },
        "yt2x pipeline --dub: local transcription unavailable (faster-whisper not installed, " +
          "or no downloaded source video found). Install faster-whisper, or run " +
          "`yt2x subtitle transcribe-local <videoId>` manually, then retry.",
      );
      return { ok: false, exitCode: NATIVE_EXIT.CONFIG_MISSING };
    }
    logger.info(
      { videoId: id, wordsPath: result.wordsPath, cueCount: result.cueCount },
      "yt2x pipeline --dub: local transcript ready",
    );
  }

  return { ok: true };
};
