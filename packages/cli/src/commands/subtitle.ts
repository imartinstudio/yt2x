import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  auditSubtitleArtifacts,
  DEFAULT_OUT_DIR,
  DEFAULT_WATERMARK_SUBTITLER,
  defaultProcessRunner,
  isSubtitleAuditReadyForDelivery,
  measureBilingualSubtitleLayout,
  repairSubtitleArtifacts,
  sanitizeVideoId,
  transcribeLocal,
  type SubtitleAuditIssue,
  type SubtitleAuditMeasurement,
} from "@yt2x/adapters-node";
import type { Command } from "commander";
import { addCommonSourceOptions, addLlmOptions } from "./_shared.js";
import { executeNativeSubtitle, type SubtitleFlags } from "../orchestrator/native-subtitle.js";
import { logger } from "../logger.js";
import { resolveNativeLlm, type NativeLlmCliFlags } from "../orchestrator/native-stage-common.js";

export { executeNativeSubtitle, type SubtitleFlags };

const runSubtitle = async (flags: SubtitleFlags): Promise<void> => {
  process.exitCode = await executeNativeSubtitle(flags);
};

export type SubtitleAuditFlags = {
  outDir?: string;
  articleOutDir?: string;
  strict?: boolean;
  sourceChannel?: string;
  measureLayout?: (input: {
    bilingualSrt: string;
    videoWidth: number;
    videoHeight: number;
  }) => Promise<readonly SubtitleAuditMeasurement[]>;
};

const firstExistingPath = async (paths: readonly string[]): Promise<string> => {
  for (const candidate of paths) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return paths[0]!;
};

/**
 * audit/repair read the on-disk source SRT to check content fidelity, but
 * don't otherwise know which of the two coexisting source channels
 * generated the artifact under inspection — that choice lives only in the
 * original `subtitle` invocation's --subtitle-source flag. Auditing the
 * wrong channel's file produces bogus source-sha/coverage-loss findings, so
 * callers must pass --source-channel matching what they generated with.
 * (Deliberately a different flag name than the parent `subtitle` command's
 * own --subtitle-source: Commander silently drops a subcommand option that
 * shares its parent's long flag name, defaulting to the parent's value.)
 */
const sourceSrtCandidates = (downloadDir: string, source: string | undefined): string[] =>
  source === "local"
    ? [
        path.join(downloadDir, "full.local.en.srt"),
        path.join(downloadDir, "video", "full.local.en.srt"),
      ]
    : [
        path.join(downloadDir, "full.en.srt"),
        path.join(downloadDir, "video", "full.en.srt"),
      ];

const atomicWriteFile = async (filePath: string, content: string): Promise<void> => {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
};

const summarizeIssues = (issues: readonly SubtitleAuditIssue[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  return counts;
};

export const executeSubtitleAudit = async (
  rawVideoId: string,
  flags: SubtitleAuditFlags,
): Promise<number> => {
  const videoId = sanitizeVideoId(rawVideoId);
  const outRoot = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
  const articleRoot = path.resolve(flags.articleOutDir ?? "files/articles");
  const downloadDir = path.join(outRoot, videoId);
  const articleVideoDir = path.join(articleRoot, videoId, "video");
  const sourcePath = await firstExistingPath(sourceSrtCandidates(downloadDir, flags.sourceChannel));
  const [sourceSrt, enSrt, zhSrt, bilingualSrt, manifestRaw] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(path.join(articleVideoDir, "full.en.srt"), "utf8"),
    readFile(path.join(articleVideoDir, "full.zh.srt"), "utf8"),
    readFile(path.join(articleVideoDir, "full.bilingual.srt"), "utf8"),
    readFile(path.join(articleVideoDir, "full.bilingual.semantic.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw) as {
    sourceSha256?: string;
    videoWidth?: number;
    videoHeight?: number;
  };
  const videoWidth = manifest.videoWidth ?? 1280;
  const videoHeight = manifest.videoHeight ?? 720;
  const measurements = await (
    flags.measureLayout ??
    (async ({ bilingualSrt: content, videoWidth: width, videoHeight: height }) =>
      measureBilingualSubtitleLayout({
        srtContent: content,
        videoWidth: width,
        videoHeight: height,
        runner: defaultProcessRunner,
      }))
  )({ bilingualSrt, videoWidth, videoHeight });
  const result = auditSubtitleArtifacts({
    sourceSrt,
    enSrt,
    zhSrt,
    bilingualSrt,
    manifest,
    measurements,
  });
  await mkdir(articleVideoDir, { recursive: true });
  const reportPath = path.join(articleVideoDir, "full.bilingual.audit.json");
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  // Without this the command was completely silent — it only wrote the JSON,
  // so the CLI gave no hint about which cue was flagged or why a `subtitle`
  // run had been refusing to deliver. `repair` already reports this shape.
  logger.info(
    {
      videoId,
      verdict: result.verdict,
      issueCount: result.issues.length,
      byCode: summarizeIssues(result.issues),
      blocksBurn: !isSubtitleAuditReadyForDelivery(result, "burned"),
      issues: result.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        timestamp: issue.timestamp,
        message: issue.message,
      })),
      reportPath,
    },
    "yt2x subtitle audit: done",
  );
  return flags.strict === true && result.verdict === "fail" ? 2 : 0;
};

export type SubtitleRepairFlags = NativeLlmCliFlags & {
  outDir?: string;
  articleOutDir?: string;
  strict?: boolean;
  sourceChannel?: string;
  measureLayout?: SubtitleAuditFlags["measureLayout"];
};

/**
 * Targeted repair over an already-generated bilingual subtitle: audits the
 * current artifact, applies ONE bounded repair pass (protected-term
 * restoration, over-width re-split, then cps compaction — see
 * repairSubtitleArtifacts), re-audits
 * once, and reports exactly which findings that resolved vs which are still
 * there. Never re-translates and never loops — a finding neither pass can
 * fix is left for a human, same as BaoCut's "one repair, one re-audit, then
 * ask" policy.
 */
export const executeSubtitleRepair = async (
  rawVideoId: string,
  flags: SubtitleRepairFlags,
): Promise<number> => {
  const videoId = sanitizeVideoId(rawVideoId);
  const outRoot = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
  const articleRoot = path.resolve(flags.articleOutDir ?? "files/articles");
  const downloadDir = path.join(outRoot, videoId);
  const articleVideoDir = path.join(articleRoot, videoId, "video");
  const sourcePath = await firstExistingPath(sourceSrtCandidates(downloadDir, flags.sourceChannel));
  const zhSrtPath = path.join(articleVideoDir, "full.zh.srt");
  const bilingualSrtPath = path.join(articleVideoDir, "full.bilingual.srt");
  const [sourceSrt, enSrt, zhSrtBefore, bilingualSrtBefore, manifestRaw] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(path.join(articleVideoDir, "full.en.srt"), "utf8"),
    readFile(zhSrtPath, "utf8"),
    readFile(bilingualSrtPath, "utf8"),
    readFile(path.join(articleVideoDir, "full.bilingual.semantic.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw) as {
    sourceSha256?: string;
    videoWidth?: number;
    videoHeight?: number;
    status?: string;
    stages?: Record<string, string>;
    quality?: { readyForBurn: boolean; issues: unknown };
    files?: Record<string, { sha256: string }>;
    [key: string]: unknown;
  };
  const videoWidth = manifest.videoWidth ?? 1280;
  const videoHeight = manifest.videoHeight ?? 720;
  const measureLayout =
    flags.measureLayout ??
    (async ({ bilingualSrt: content, videoWidth: width, videoHeight: height }) =>
      measureBilingualSubtitleLayout({
        srtContent: content,
        videoWidth: width,
        videoHeight: height,
        runner: defaultProcessRunner,
      }));

  const before = auditSubtitleArtifacts({
    sourceSrt,
    enSrt,
    zhSrt: zhSrtBefore,
    bilingualSrt: bilingualSrtBefore,
    manifest,
    measurements: await measureLayout({ bilingualSrt: bilingualSrtBefore, videoWidth, videoHeight }),
  });

  const llmResult = resolveNativeLlm(flags);
  if (!llmResult.ok) {
    logger.error({ reason: llmResult.reason }, "LLM config missing for subtitle repair");
    return llmResult.exitCode;
  }

  const repaired = await repairSubtitleArtifacts({
    enSrt,
    zhSrt: zhSrtBefore,
    bilingualSrt: bilingualSrtBefore,
    llm: llmResult.adapter,
    model: llmResult.model,
  });

  if (repaired.changed) {
    // fixFlashCues (inside repairSubtitleArtifacts) can move a cue's
    // start/end, which full.en.srt shares identically per index with the
    // zh/bilingual files — it must be written back too, or its timing goes
    // out of sync with the two files that just changed.
    await atomicWriteFile(path.join(articleVideoDir, "full.en.srt"), repaired.enSrt);
    await atomicWriteFile(zhSrtPath, repaired.zhSrt);
    await atomicWriteFile(bilingualSrtPath, repaired.bilingualSrt);
  }

  const after = auditSubtitleArtifacts({
    sourceSrt,
    enSrt: repaired.enSrt,
    zhSrt: repaired.zhSrt,
    bilingualSrt: repaired.bilingualSrt,
    manifest,
    measurements: await measureLayout({ bilingualSrt: repaired.bilingualSrt, videoWidth, videoHeight }),
  });

  if (repaired.changed) {
    // readValidArticleCache (the `subtitle` pipeline's own cache check)
    // trusts full.bilingual.semantic.json, not full.bilingual.audit.json —
    // and it checks each file's recorded sha256 against the bytes on disk.
    // Repair changes the actual files, so without refreshing those hashes a
    // later `subtitle` run (even without --force) judged the cache invalid
    // and silently re-translated the whole video from scratch — throwing
    // away exactly the fix repair just made, and risking a brand new random
    // failure from the always-non-deterministic retranslation.
    const readyForBurn = isSubtitleAuditReadyForDelivery(after, "burned");
    const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
    const updatedManifest = {
      ...manifest,
      status: readyForBurn ? "ready" : "failed",
      stages: { ...manifest.stages, layout: readyForBurn ? "done" : "failed" },
      quality: { readyForBurn, issues: after.issues },
      files: {
        en: { sha256: sha256(repaired.enSrt) },
        zh: { sha256: sha256(repaired.zhSrt) },
        bilingual: { sha256: sha256(repaired.bilingualSrt) },
      },
    };
    await atomicWriteFile(
      path.join(articleVideoDir, "full.bilingual.semantic.json"),
      `${JSON.stringify(updatedManifest, null, 2)}\n`,
    );
  }

  await mkdir(articleVideoDir, { recursive: true });
  await writeFile(
    path.join(articleVideoDir, "full.bilingual.audit.json"),
    `${JSON.stringify(after, null, 2)}\n`,
    "utf8",
  );

  logger.info(
    {
      videoId,
      changed: repaired.changed,
      beforeIssues: before.issues.length,
      afterIssues: after.issues.length,
      beforeByCode: summarizeIssues(before.issues),
      afterByCode: summarizeIssues(after.issues),
      stillFailing: after.issues.map((issue) => ({
        code: issue.code,
        timestamp: issue.timestamp,
        message: issue.message,
      })),
    },
    repaired.changed ? "yt2x subtitle repair: applied targeted fixes" : "yt2x subtitle repair: nothing to fix",
  );

  return flags.strict === true && after.verdict === "fail" ? 2 : 0;
};

export type SubtitleTranscribeLocalFlags = {
  outDir?: string;
  sourceLang?: string;
  model?: string;
};

/**
 * Local transcription channel: runs faster-whisper on the already-downloaded
 * video and writes "full.local.<lang>.srt" + "full.local.<lang>.words.json"
 * next to the existing YouTube-caption "full.<lang>.srt" — a coexisting,
 * independent source, never overwriting it. Select it for burn/translate
 * with `--subtitle-source local`.
 */
export const executeSubtitleTranscribeLocal = async (
  rawVideoId: string,
  flags: SubtitleTranscribeLocalFlags,
): Promise<number> => {
  const videoId = sanitizeVideoId(rawVideoId);
  const outRoot = path.resolve(flags.outDir ?? DEFAULT_OUT_DIR);
  const videoDir = path.join(outRoot, videoId);
  const language = flags.sourceLang ?? "en";

  const result = await transcribeLocal({
    videoDir,
    language,
    runner: defaultProcessRunner,
    ...(flags.model !== undefined ? { model: flags.model } : {}),
  });

  if (result === undefined) {
    logger.error(
      { videoId },
      "yt2x subtitle transcribe-local: unavailable (faster-whisper not installed, or no downloaded video found)",
    );
    return 1;
  }

  logger.info(
    { videoId, srtPath: result.srtPath, wordsPath: result.wordsPath, cueCount: result.cueCount },
    "yt2x subtitle transcribe-local: done",
  );
  return 0;
};

export const registerSubtitleCommand = (program: Command): void => {
  const cmd = program
    .command("subtitle")
    .description(
      "Run subtitle pipeline for an acquired video (source → translate → burn). Burn step detects existing Chinese hard subs and skips by default.",
    );

  addLlmOptions(
    addCommonSourceOptions(cmd)
      .option("--video-id <id>", "Video ID under --out-dir (e.g., files/downloads/<id>)")
      .option("--subtitle-zh <mode>", "Subtitle mode: off|srt|burned|both", "srt")
      .option("--subtitle-source-lang <lang>", "Subtitle source language", "en")
      .option("--subtitle-target-lang <lang>", "Subtitle target language", "zh-CN")
      .option("--subtitle-source <mode>", "Subtitle source: auto|youtube|transcribe|local|file", "auto")
      .option("--subtitle-file <path>", "Existing SRT/VTT subtitle file when --subtitle-source file")
      .option("--subtitle-bilingual <mode>", "Bilingual subtitle mode: off|srt|ass|burned|all", "off")
      .option("--subtitle-burn-style <style>", "Subtitle burn style: zh-default|bilingual-explainer", "zh-default")
      .option("--article-out-dir <path>", "Output dir for burned video (default: files/articles)")
      .option(
        "--no-skip-burn-if-chinese-burned",
        "Burn zh subtitles even when the original video already has Chinese hard subs",
        false,
      )
      .option("--force", "Force re-burn, overwriting any existing burned video")
      .option(
        "--align-audio",
        "Use forced word-level audio alignment (torchaudio) for cue splitting instead of guessing from text length. " +
          "Off by default: needs torchaudio installed and adds real per-video alignment time; silently skipped if unavailable.",
        false,
      )
      .option(
        "--watermark-subtitler <handle>",
        `Override the 「字幕：」 attribution (default ${DEFAULT_WATERMARK_SUBTITLER}); empty string drops that line`,
      ),
  ).action(async (flags: SubtitleFlags) => {
    await runSubtitle(flags);
  });

  cmd
    .command("audit <videoId>")
    .description("Audit generated bilingual subtitle artifacts")
    .option("--out-dir <path>", "Downloaded source root", DEFAULT_OUT_DIR)
    .option("--article-out-dir <path>", "Article artifact root", "files/articles")
    .option("--strict", "Exit 2 when the audit verdict is fail", false)
    .option(
      "--source-channel <mode>",
      "Which source channel generated this artifact (must match the original `subtitle --subtitle-source` run): auto|local",
      "auto",
    )
    .action(async (videoId: string, flags: SubtitleAuditFlags) => {
      process.exitCode = await executeSubtitleAudit(videoId, flags);
    });

  addLlmOptions(
    cmd
      .command("repair <videoId>")
      .description(
        "Targeted repair of already-generated bilingual subtitle artifacts: audits, applies one bounded " +
          "fix pass (protected-term restoration, over-width re-split, cps compaction), re-audits, and " +
          "reports what's still failing. Does not re-translate or loop.",
      )
      .option("--out-dir <path>", "Downloaded source root", DEFAULT_OUT_DIR)
      .option("--article-out-dir <path>", "Article artifact root", "files/articles")
      .option("--strict", "Exit 2 when the post-repair audit verdict is fail", false)
      .option(
        "--source-channel <mode>",
        "Which source channel generated this artifact (must match the original `subtitle --subtitle-source` run): auto|local",
        "auto",
      ),
  ).action(async (videoId: string, flags: SubtitleRepairFlags) => {
    process.exitCode = await executeSubtitleRepair(videoId, flags);
  });

  cmd
    .command("transcribe-local <videoId>")
    .description(
      "Local transcription channel (faster-whisper): writes full.local.<lang>.srt + " +
        ".words.json next to the existing YouTube-caption source, without touching it. " +
        "Select it for translate/burn with --subtitle-source local.",
    )
    .option("--out-dir <path>", "Downloaded source root", DEFAULT_OUT_DIR)
    .option("--source-lang <lang>", "Source language", "en")
    .option("--model <size>", "faster-whisper model size (default: small)")
    .action(async (videoId: string, flags: SubtitleTranscribeLocalFlags) => {
      process.exitCode = await executeSubtitleTranscribeLocal(videoId, flags);
    });
};
