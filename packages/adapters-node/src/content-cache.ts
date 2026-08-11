import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  createTechnicalTermGuard,
  fingerprintTechnicalTermValue,
  metadataPromptText,
  type TechnicalTermDiscoveryAudit,
  type YouTubeMetadata,
} from "@yt2x/core";
import { atomicWriteUtf8 } from "./content-transaction.js";

export const CONTENT_METADATA_SCHEMA_VERSION = 3 as const;

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
  technicalTermKnownSourceFingerprint: string;
  technicalTermRequiredSourceFingerprint: string;
  technicalTermScope: "full" | "scoped";
  seedFingerprint?: string;
  generatedAt: string;
};

export type ContentTargetMetadataInput = Omit<
  ContentTargetMetadata,
  | "v"
  | "generatedAt"
  | "requestedModel"
  | "resolvedModel"
  | "technicalTermKnownSourceFingerprint"
  | "technicalTermRequiredSourceFingerprint"
  | "technicalTermScope"
> & {
  /** 新记录使用 requestedModel；model 仅用于迁移旧调用方，写盘时不会保留。 */
  requestedModel?: string;
  resolvedModel?: string;
  model?: string;
  generatedAt?: string;
  technicalTermKnownSourceFingerprint?: string;
  technicalTermRequiredSourceFingerprint?: string;
  technicalTermScope?: "full" | "scoped";
};

export type ContentTargetCacheExpectation = {
  target: string;
  sourceFingerprint: string;
  requestedModel?: string;
  /** 兼容旧调用方；cache key 只会取 requestedModel。 */
  model?: string;
  promptVersion: string;
  sourceText?: string;
  knownSourceText?: string;
  requiredSourceText?: string;
  sourceTitle?: string;
  technicalTermScope?: "full" | "scoped";
  seedFingerprint?: string;
  requiredFiles: readonly string[];
};

export const contentSourceFingerprintFor = (source: unknown): string =>
  fingerprintTechnicalTermValue(source);

export const contentTechnicalTermSourceFingerprintFor = (
  sourceText: string,
  sourceTitle = "",
): string => fingerprintTechnicalTermValue({ sourceText, sourceTitle });

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
 * 派生产物的术语已知范围：prompt 里可见的 metadata + 上游正文。
 *
 * 每个 generator 都把 `stripHeavyMetadata(metadata)` 塞进 user prompt，所以作者名、
 * 频道名、简介里的产品名都是模型"看得见的材料"。已知范围不覆盖它们的话，输出一提到
 * 就会被判成凭空造词。它们只进已知范围、不进必需范围，所以也不会反过来要求每篇产物
 * 都提到作者。
 */
export const knownSourceTextWithMetadata = (
  metadata: YouTubeMetadata,
  ...sources: readonly string[]
): string => [metadataPromptText(metadata), ...sources].join("\n");

/** notes 要求输出携带的范围：只有转录，metadata 不在其中。 */
export const notesRequiredSourceTextFor = (input: {
  chunksMd: string;
  timestampedCuesMd: string;
}): string => `${input.chunksMd}\n${input.timestampedCuesMd}`;

/**
 * notes 的术语已知范围：模型在 prompt 里看得见的全部材料 = metadata + 转录。
 *
 * 生成器和内容缓存必须用同一个函数算，否则缓存重建出来的 profile 指纹对不上，
 * notes 会每次重算。
 */
export const notesKnownSourceTextFor = (input: {
  metadata: YouTubeMetadata;
  chunksMd: string;
  timestampedCuesMd: string;
}): string => knownSourceTextWithMetadata(input.metadata, notesRequiredSourceTextFor(input));

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
  const discoverySourceIdentity = input.technicalTermDiscovery.sourceIdentity ?? "";
  return {
    v: CONTENT_METADATA_SCHEMA_VERSION,
    target: input.target,
    sourceFingerprint: input.sourceFingerprint,
    requestedModel,
    resolvedModel: input.resolvedModel ?? requestedModel,
    promptVersion: input.promptVersion,
    technicalTermProfileFingerprint: input.technicalTermProfileFingerprint,
    technicalTermDiscovery: input.technicalTermDiscovery,
    technicalTermKnownSourceFingerprint:
      input.technicalTermKnownSourceFingerprint ?? discoverySourceIdentity,
    technicalTermRequiredSourceFingerprint:
      input.technicalTermRequiredSourceFingerprint ?? discoverySourceIdentity,
    technicalTermScope: input.technicalTermScope ?? "full",
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
  && typeof value.technicalTermKnownSourceFingerprint === "string"
  && typeof value.technicalTermRequiredSourceFingerprint === "string"
  && (value.technicalTermScope === "full" || value.technicalTermScope === "scoped")
  && typeof value.generatedAt === "string"
  && hasDiscoveryAudit(value.technicalTermDiscovery)
  && (value.seedFingerprint === undefined || typeof value.seedFingerprint === "string");

/**
 * v3 之前（schema v2）没有落盘 known/required source 与 scope 字段的目标。
 * 只有 full-scope 目标可以安全迁移：v2 时代它们本来就用整份 discovery source
 * 校验（known === required === discovery.sourceIdentity，scope="full"），这正是
 * `createContentTargetMetadata` 至今仍在用的 fallback 逻辑，迁移只是把它落回磁盘。
 * scoped 目标（x-thread / x-short / x-video-short）在 v2 里没有 required 层信息，
 * 无法安全重建，必须继续判 stale，逼一次真实重新生成来补齐两层身份。
 */
const FULL_SCOPE_MIGRATABLE_TARGETS: readonly string[] = [
  "article",
  "notes",
  "deconstruct-run",
  "clip-post",
];

const isFullScopeMigratableTarget = (target: string): boolean =>
  FULL_SCOPE_MIGRATABLE_TARGETS.includes(target) || target.startsWith("platform-article-");

const isLegacyV2Metadata = (
  value: unknown,
): value is Omit<ContentTargetMetadata, "v" | "technicalTermKnownSourceFingerprint" | "technicalTermRequiredSourceFingerprint" | "technicalTermScope"> & { v: 2 } =>
  isRecord(value)
  && value.v === 2
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
  if (!isLegacyV2Metadata(value) || !isFullScopeMigratableTarget(value.target)) return undefined;
  const discoverySourceIdentity = value.technicalTermDiscovery.sourceIdentity ?? "";
  const migrated: unknown = {
    ...value,
    v: CONTENT_METADATA_SCHEMA_VERSION,
    technicalTermKnownSourceFingerprint: discoverySourceIdentity,
    technicalTermRequiredSourceFingerprint: discoverySourceIdentity,
    technicalTermScope: "full",
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
  const knownSourceText = expected.knownSourceText ?? expected.sourceText ?? "";
  const requiredSourceText = expected.requiredSourceText ?? expected.sourceText ?? "";
  const technicalTermScope = expected.technicalTermScope ?? "full";
  if (normalizedMetadata === undefined
    || expectedRequestedModel === undefined
    || normalizedMetadata.target !== expected.target
    || normalizedMetadata.sourceFingerprint !== expected.sourceFingerprint
    || normalizedMetadata.requestedModel !== expectedRequestedModel
    || normalizedMetadata.promptVersion !== expected.promptVersion
    || normalizedMetadata.technicalTermKnownSourceFingerprint
      !== contentTechnicalTermSourceFingerprintFor(knownSourceText, expected.sourceTitle)
    || normalizedMetadata.technicalTermRequiredSourceFingerprint
      !== contentTechnicalTermSourceFingerprintFor(requiredSourceText, expected.sourceTitle)
    || normalizedMetadata.technicalTermScope !== technicalTermScope
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

  const fullGuard = createTechnicalTermGuard({
    sourceText: knownSourceText,
    ...(expected.sourceTitle === undefined ? {} : { sourceTitle: expected.sourceTitle }),
    discoveredTerms: normalizedMetadata.technicalTermDiscovery.acceptedCandidates,
    discovery: normalizedMetadata.technicalTermDiscovery,
  });
  const guard = technicalTermScope === "scoped"
    ? fullGuard.scope(requiredSourceText, expected.sourceTitle)
    : fullGuard;
  return guard.profile.profileFingerprint === normalizedMetadata.technicalTermProfileFingerprint;
};
