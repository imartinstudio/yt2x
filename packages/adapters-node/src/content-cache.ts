import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  createTechnicalTermGuard,
  fingerprintTechnicalTermValue,
  type TechnicalTermDiscoveryAudit,
} from "@yt2x/core";
import { atomicWriteUtf8 } from "./content-transaction.js";

export const CONTENT_METADATA_SCHEMA_VERSION = 2 as const;

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
  deconstruct: "native-deconstruct-v2",
});

export type ContentTargetMetadata = {
  v: typeof CONTENT_METADATA_SCHEMA_VERSION;
  target: string;
  sourceFingerprint: string;
  requestedModel: string;
  resolvedModel: string;
  promptVersion: string;
  technicalTermProfileFingerprint: string;
  technicalTermDiscovery: TechnicalTermDiscoveryAudit;
  seedFingerprint?: string;
  generatedAt: string;
};

export type ContentTargetMetadataInput = Omit<ContentTargetMetadata, "v" | "generatedAt" | "requestedModel" | "resolvedModel"> & {
  /** 新记录使用 requestedModel；model 仅用于迁移旧调用方，写盘时不会保留。 */
  requestedModel?: string;
  resolvedModel?: string;
  model?: string;
  generatedAt?: string;
};

export type ContentTargetCacheExpectation = {
  target: string;
  sourceFingerprint: string;
  requestedModel?: string;
  /** 兼容旧调用方；cache key 只会取 requestedModel。 */
  model?: string;
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

export const notesContentSourceFor = (input: {
  metadata: unknown;
  chunksMd: string;
  timestampedCuesMd: string;
  screenshots?: unknown;
}): Record<string, unknown> => ({
  metadata: input.metadata,
  chunksMd: input.chunksMd,
  timestampedCuesMd: input.timestampedCuesMd,
  screenshots: input.screenshots ?? null,
});

/**
 * 摘要型内容只把源材料中明确的摘要/提纲/要点区段作为 active source scope。
 * 没有这些结构时保留全文，兼容旧 notes 和非结构化 fixtures。
 */
export const summarySourceTextFor = (structuredNotesMd: string): string => {
  const lines = structuredNotesMd.split(/\r?\n/);
  const selected: string[] = [];
  const wanted = /^(?:executive\s+summary|summary|topic\s+outline|key\s+takeaways|takeaways|摘要|执行摘要|主题大纲|关键要点|核心结论|结论)$/iu;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index]?.match(/^(#{1,6})\s+(.+?)\s*$/u);
    if (heading === null || heading === undefined) continue;
    const title = heading[2]!.replaceAll("**", "").trim();
    if (!wanted.test(title)) continue;
    const level = heading[1]!.length;
    let end = index + 1;
    while (end < lines.length) {
      const nextHeading = lines[end]?.match(/^(#{1,6})\s+/u);
      if (nextHeading !== null && nextHeading !== undefined && nextHeading[1]!.length <= level) break;
      end += 1;
    }
    selected.push(lines.slice(index, end).join("\n"));
    index = end - 1;
  }
  return selected.length > 0 ? selected.join("\n\n") : structuredNotesMd;
};

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
): ContentTargetMetadata => {
  const requestedModel = input.requestedModel ?? input.model;
  if (requestedModel === undefined || requestedModel.length === 0) {
    throw new Error(`Content target metadata for "${input.target}" requires requestedModel.`);
  }
  return {
    v: CONTENT_METADATA_SCHEMA_VERSION,
    target: input.target,
    sourceFingerprint: input.sourceFingerprint,
    requestedModel,
    resolvedModel: input.resolvedModel ?? requestedModel,
    promptVersion: input.promptVersion,
    technicalTermProfileFingerprint: input.technicalTermProfileFingerprint,
    technicalTermDiscovery: input.technicalTermDiscovery,
    ...(input.seedFingerprint === undefined ? {} : { seedFingerprint: input.seedFingerprint }),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
};

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
  && typeof value.requestedModel === "string"
  && typeof value.resolvedModel === "string"
  && typeof value.promptVersion === "string"
  && typeof value.technicalTermProfileFingerprint === "string"
  && typeof value.generatedAt === "string"
  && hasDiscoveryAudit(value.technicalTermDiscovery)
  && (value.seedFingerprint === undefined || typeof value.seedFingerprint === "string");

const migrateMetadata = (value: unknown): ContentTargetMetadata | undefined => {
  if (isMetadata(value)) return value;
  if (!isRecord(value) || value.v !== 1 || typeof value.model !== "string") return undefined;
  const migrated: unknown = {
    ...value,
    v: CONTENT_METADATA_SCHEMA_VERSION,
    requestedModel: value.model,
    resolvedModel: value.model,
  };
  return isMetadata(migrated) ? migrated : undefined;
};

export const readContentTargetMetadata = async (
  metadataPath: string,
): Promise<ContentTargetMetadata | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    return migrateMetadata(parsed);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
};

export const writeContentTargetMetadata = async (
  metadataPath: string,
  metadata: ContentTargetMetadata,
): Promise<void> => {
  await atomicWriteUtf8(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
};

/**
 * 仅使用已经落盘的 metadata/audit 做命中判断；不会调用 discovery/provider。
 * 缺少任何新字段（包括旧 metadata）都视为 stale。
 */
export const isContentTargetMetadataFresh = async (
  metadata: unknown,
  expected: ContentTargetCacheExpectation,
): Promise<boolean> => {
  const normalizedMetadata = migrateMetadata(metadata);
  const expectedRequestedModel = expected.requestedModel ?? expected.model;
  if (normalizedMetadata === undefined
    || expectedRequestedModel === undefined
    || normalizedMetadata.target !== expected.target
    || normalizedMetadata.sourceFingerprint !== expected.sourceFingerprint
    || normalizedMetadata.requestedModel !== expectedRequestedModel
    || normalizedMetadata.promptVersion !== expected.promptVersion
    || (expected.seedFingerprint !== undefined && normalizedMetadata.seedFingerprint !== expected.seedFingerprint)) {
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
    discoveredTerms: normalizedMetadata.technicalTermDiscovery.acceptedCandidates,
    discovery: normalizedMetadata.technicalTermDiscovery,
  });
  return guard.profile.profileFingerprint === normalizedMetadata.technicalTermProfileFingerprint;
};
