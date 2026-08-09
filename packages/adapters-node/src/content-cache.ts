import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createTechnicalTermGuard,
  fingerprintTechnicalTermValue,
  type TechnicalTermDiscoveryAudit,
} from "@yt2x/core";

export const CONTENT_METADATA_SCHEMA_VERSION = 1 as const;

/**
 * 每个内容目标独立维护 prompt 版本。版本变化会让旧产物安全失效，避免
 * 只因为目标文件还存在就复用一份已经不符合当前契约的内容。
 */
export const CONTENT_PROMPT_VERSIONS = Object.freeze({
  notes: "native-notes-v2",
  article: "native-article-v2",
  platformArticle: "native-platform-article-v2",
  xThread: "native-x-thread-v2",
  xShort: "native-x-short-v2",
  xVideoShort: "native-x-video-short-v2",
  clipPost: "native-clip-post-v2",
});

export type ContentTargetMetadata = {
  v: typeof CONTENT_METADATA_SCHEMA_VERSION;
  target: string;
  sourceFingerprint: string;
  model: string;
  promptVersion: string;
  technicalTermProfileFingerprint: string;
  technicalTermDiscovery: TechnicalTermDiscoveryAudit;
  seedFingerprint?: string;
  generatedAt: string;
};

export type ContentTargetMetadataInput = Omit<ContentTargetMetadata, "v" | "generatedAt"> & {
  generatedAt?: string;
};

export type ContentTargetCacheExpectation = {
  target: string;
  sourceFingerprint: string;
  model: string;
  promptVersion: string;
  sourceText: string;
  sourceTitle?: string;
  seedFingerprint?: string;
  requiredFiles: readonly string[];
};

export const contentSourceFingerprintFor = (source: unknown): string =>
  fingerprintTechnicalTermValue(source);

export const structuredNotesContentSourceFor = (input: {
  metadata: unknown;
  structuredNotesMd: string;
  availableVisuals?: unknown;
}): Record<string, unknown> => ({
  metadata: input.metadata,
  structuredNotesMd: input.structuredNotesMd,
  availableVisuals: input.availableVisuals ?? null,
});

export const platformArticleContentSourceFor = (input: {
  metadata: unknown;
  structuredNotesMd: string;
  articleMd: string;
  timestampedCuesMd: string;
  target: string;
}): Record<string, unknown> => ({
  metadata: input.metadata,
  structuredNotesMd: input.structuredNotesMd,
  articleMd: input.articleMd,
  timestampedCuesMd: input.timestampedCuesMd,
  target: input.target,
});

export const contentTargetMetadataPathFor = (targetDir: string, target: string): string =>
  path.join(path.resolve(targetDir), ".content-metadata", `${target}.json`);

export const createContentTargetMetadata = (
  input: ContentTargetMetadataInput,
): ContentTargetMetadata => ({
  v: CONTENT_METADATA_SCHEMA_VERSION,
  target: input.target,
  sourceFingerprint: input.sourceFingerprint,
  model: input.model,
  promptVersion: input.promptVersion,
  technicalTermProfileFingerprint: input.technicalTermProfileFingerprint,
  technicalTermDiscovery: input.technicalTermDiscovery,
  ...(input.seedFingerprint === undefined ? {} : { seedFingerprint: input.seedFingerprint }),
  generatedAt: input.generatedAt ?? new Date().toISOString(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasDiscoveryAudit = (value: unknown): value is TechnicalTermDiscoveryAudit => {
  if (!isRecord(value)
    || typeof value.promptVersion !== "string"
    || !Array.isArray(value.acceptedCandidates)
    || !Array.isArray(value.reviewCandidates)
    || !Array.isArray(value.warnings)) return false;
  return value.acceptedCandidates.every((candidate) => isRecord(candidate)
      && typeof candidate.sourceText === "string"
      && typeof candidate.confidence === "string"
      && typeof candidate.category === "string")
    && value.reviewCandidates.every((candidate) => isRecord(candidate)
      && typeof candidate.sourceText === "string"
      && typeof candidate.confidence === "string"
      && typeof candidate.category === "string")
    && value.warnings.every((warning) => isRecord(warning)
      && typeof warning.code === "string"
      && typeof warning.message === "string");
};

const isMetadata = (value: unknown): value is ContentTargetMetadata =>
  isRecord(value)
  && value.v === CONTENT_METADATA_SCHEMA_VERSION
  && typeof value.target === "string"
  && typeof value.sourceFingerprint === "string"
  && typeof value.model === "string"
  && typeof value.promptVersion === "string"
  && typeof value.technicalTermProfileFingerprint === "string"
  && typeof value.generatedAt === "string"
  && hasDiscoveryAudit(value.technicalTermDiscovery)
  && (value.seedFingerprint === undefined || typeof value.seedFingerprint === "string");

export const readContentTargetMetadata = async (
  metadataPath: string,
): Promise<ContentTargetMetadata | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    return isMetadata(parsed) ? parsed : undefined;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
};

export const writeContentTargetMetadata = async (
  metadataPath: string,
  metadata: ContentTargetMetadata,
): Promise<void> => {
  await mkdir(path.dirname(metadataPath), { recursive: true });
  const temporaryPath = `${metadataPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await rename(temporaryPath, metadataPath);
};

/**
 * 仅使用已经落盘的 metadata/audit 做命中判断；不会调用 discovery/provider。
 * 缺少任何新字段（包括旧 metadata）都视为 stale。
 */
export const isContentTargetMetadataFresh = async (
  metadata: unknown,
  expected: ContentTargetCacheExpectation,
): Promise<boolean> => {
  if (!isMetadata(metadata)
    || metadata.target !== expected.target
    || metadata.sourceFingerprint !== expected.sourceFingerprint
    || metadata.model !== expected.model
    || metadata.promptVersion !== expected.promptVersion
    || (expected.seedFingerprint !== undefined && metadata.seedFingerprint !== expected.seedFingerprint)) {
    return false;
  }

  try {
    await Promise.all(expected.requiredFiles.map(async (filePath) => {
      await stat(filePath);
    }));
  } catch {
    return false;
  }

  const guard = createTechnicalTermGuard({
    sourceText: expected.sourceText,
    ...(expected.sourceTitle === undefined ? {} : { sourceTitle: expected.sourceTitle }),
    discoveredTerms: metadata.technicalTermDiscovery.acceptedCandidates,
    discovery: metadata.technicalTermDiscovery,
  });
  return guard.profile.profileFingerprint === metadata.technicalTermProfileFingerprint;
};
