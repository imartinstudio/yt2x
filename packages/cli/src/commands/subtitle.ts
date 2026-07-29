import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  auditSubtitleArtifacts,
  DEFAULT_OUT_DIR,
  defaultProcessRunner,
  measureBilingualSubtitleLayout,
  repairSubtitleArtifacts,
  sanitizeVideoId,
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
  const sourcePath = await firstExistingPath([
    path.join(downloadDir, "full.en.srt"),
    path.join(downloadDir, "video", "full.en.srt"),
  ]);
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
  await writeFile(
    path.join(articleVideoDir, "full.bilingual.audit.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return flags.strict === true && result.verdict === "fail" ? 2 : 0;
};

export type SubtitleRepairFlags = NativeLlmCliFlags & {
  outDir?: string;
  articleOutDir?: string;
  strict?: boolean;
  measureLayout?: SubtitleAuditFlags["measureLayout"];
};

/**
 * Targeted repair over an already-generated bilingual subtitle: audits the
 * current artifact, applies ONE bounded repair pass (protected-term
 * restoration, then cps compaction — see repairSubtitleArtifacts), re-audits
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
  const sourcePath = await firstExistingPath([
    path.join(downloadDir, "full.en.srt"),
    path.join(downloadDir, "video", "full.en.srt"),
  ]);
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
    await atomicWriteFile(zhSrtPath, repaired.zhSrt);
    await atomicWriteFile(bilingualSrtPath, repaired.bilingualSrt);
  }

  const after = auditSubtitleArtifacts({
    sourceSrt,
    enSrt,
    zhSrt: repaired.zhSrt,
    bilingualSrt: repaired.bilingualSrt,
    manifest,
    measurements: await measureLayout({ bilingualSrt: repaired.bilingualSrt, videoWidth, videoHeight }),
  });

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
      .option("--subtitle-source <mode>", "Subtitle source: auto|youtube|transcribe|file", "auto")
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
    .action(async (videoId: string, flags: SubtitleAuditFlags) => {
      process.exitCode = await executeSubtitleAudit(videoId, flags);
    });

  addLlmOptions(
    cmd
      .command("repair <videoId>")
      .description(
        "Targeted repair of already-generated bilingual subtitle artifacts: audits, applies one bounded " +
          "fix pass (protected-term restoration + cps compaction), re-audits, and reports what's still failing. " +
          "Does not re-translate or loop.",
      )
      .option("--out-dir <path>", "Downloaded source root", DEFAULT_OUT_DIR)
      .option("--article-out-dir <path>", "Article artifact root", "files/articles")
      .option("--strict", "Exit 2 when the post-repair audit verdict is fail", false),
  ).action(async (videoId: string, flags: SubtitleRepairFlags) => {
    process.exitCode = await executeSubtitleRepair(videoId, flags);
  });
};
