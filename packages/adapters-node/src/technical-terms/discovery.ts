import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildTechnicalTermDiscoveryPrompt,
  createTechnicalTermDiscoveryCacheRecord,
  fingerprintTechnicalTermValue,
  parseTechnicalTermDiscoveryResponse,
  parseTechnicalTermDiscoveryCacheRecord,
  recognizeDeterministicTechnicalTerms,
  sha256Hex,
  sameTechnicalTermOuterShape,
  technicalTermDiscoveryRepairPrompt,
  TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION,
  TECHNICAL_TERM_CATALOG,
  TECHNICAL_TERM_CATALOG_FINGERPRINT,
  type DiscoverTechnicalTermsInput,
  type FinalizedTechnicalTermValue,
  type RepairTechnicalTermViolationsInput,
  type TechnicalTermDiscoveryCache,
  type TechnicalTermDiscoveryAudit,
  type TechnicalTermDiscoveryResult,
} from "@yt2x/core";
import type { TechnicalTermEntry } from "@yt2x/core";

export type {
  DiscoverTechnicalTermsInput,
  RepairTechnicalTermViolationsInput,
  TechnicalTermDiscoveryResult,
} from "@yt2x/core";

const completedDiscoveryCache = new Map<string, Promise<TechnicalTermDiscoveryResult>>();
const resolvedDiscoveryCache = new Map<string, TechnicalTermDiscoveryResult>();

const confidenceRank = (confidence: TechnicalTermDiscoveryResult["accepted"][number]["confidence"]): number =>
  confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;

export const fingerprintTechnicalTermDiscoverySource = (value: string): string =>
  `sha256-${sha256Hex(value)}`;

/**
 * Keep adapter discovery output and the core profile audit on one explicit contract.
 * The prompt version is deliberately supplied here instead of inferred by callers,
 * so every generated artifact records the same discovery policy provenance.
 */
export const technicalTermDiscoveryAuditFor = (
  result: TechnicalTermDiscoveryResult,
  source?: { sourceText: string; sourceTitle?: string; sourceIdentity?: string },
): TechnicalTermDiscoveryAudit => Object.freeze({
  promptVersion: TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION,
  ...(source === undefined ? {} : {
    sourceIdentity: source.sourceIdentity ?? technicalTermDiscoverySourceIdentityFor(source),
  }),
  acceptedCandidates: Object.freeze([...result.accepted]),
  reviewCandidates: Object.freeze([...result.reviewCandidates]),
  warnings: Object.freeze([...result.warnings]),
});

export type TechnicalTermDiscoveryCacheKeyInput = {
  model: string;
  sourceText: string;
  sourceTitle?: string;
  catalogFingerprint?: string;
};

export const technicalTermDiscoverySourceIdentityFor = (input: {
  sourceText: string;
  sourceTitle?: string;
}): string => fingerprintTechnicalTermValue({
  sourceTitle: input.sourceTitle ?? "",
  sourceText: input.sourceText,
});

export const technicalTermDiscoveryCacheKeyFor = (input: TechnicalTermDiscoveryCacheKeyInput): string => {
  return fingerprintTechnicalTermValue({
    sourceIdentity: technicalTermDiscoverySourceIdentityFor(input),
    model: input.model,
    promptVersion: TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION,
    catalogFingerprint: input.catalogFingerprint ?? TECHNICAL_TERM_CATALOG_FINGERPRINT,
  });
};

/** Stable target-side location shared by article and visual prompt producers. */
export const technicalTermDiscoveryCacheDirFor = (targetDir: string): string =>
  path.join(path.resolve(targetDir), ".cache", "technical-terms");

export const technicalTermDiscoveryCacheFilePath = (cacheDir: string, cacheKey: string): string =>
  path.join(cacheDir, `${sha256Hex(cacheKey)}.json`);

export const createFileTechnicalTermDiscoveryCacheStore = (
  cacheDir: string,
): TechnicalTermDiscoveryCache => ({
  async read(cacheKey) {
    try {
      return JSON.parse(await readFile(technicalTermDiscoveryCacheFilePath(cacheDir, cacheKey), "utf8")) as unknown;
    } catch {
      return undefined;
    }
  },
  async write(cacheKey, record) {
    if (record.cacheKey !== cacheKey || parseTechnicalTermDiscoveryCacheRecord(record) === undefined) {
      throw new Error("Invalid technical-term discovery cache record");
    }
    await mkdir(cacheDir, { recursive: true });
    const filePath = technicalTermDiscoveryCacheFilePath(cacheDir, cacheKey);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  },
});

export const clearTechnicalTermDiscoveryCaches = (): void => {
  completedDiscoveryCache.clear();
  resolvedDiscoveryCache.clear();
};

/**
 * Return only a discovery result already completed in this process. Cache matching must not
 * turn a normal dub-script read into an extra provider call; an unavailable result is treated
 * as absent so the deterministic catalog-only profile remains the safe fallback.
 */
export const getCachedTechnicalTermDiscovery = (input: {
  model: string;
  sourceText: string;
  sourceTitle?: string;
  catalogFingerprint?: string;
}): TechnicalTermDiscoveryResult | undefined => {
  const result = resolvedDiscoveryCache.get(technicalTermDiscoveryCacheKeyFor(input));
  return result?.warnings.some((warning) => warning.code === "technical-term-discovery-unavailable")
    ? undefined
    : result;
};

const termPattern = (term: string): RegExp => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "iu");
};

const catalogMatches = (source: string, catalog: readonly TechnicalTermEntry[]): boolean =>
  catalog.some((entry) => [entry.canonical, ...entry.aliases].some((term) => termPattern(term).test(source)));

const hasDiscoverySignal = (source: string): boolean => /[A-Za-z0-9`{}[\]();=<>_$\\/]/u.test(source);

const unavailable = (
  message: string,
  deterministic: TechnicalTermDiscoveryResult,
): TechnicalTermDiscoveryResult => ({
  accepted: deterministic.accepted,
  reviewCandidates: deterministic.reviewCandidates,
  warnings: [
    ...deterministic.warnings,
    { code: "technical-term-discovery-unavailable", message },
  ],
});

const mergeDiscoveryResults = (
  deterministic: TechnicalTermDiscoveryResult,
  provider: TechnicalTermDiscoveryResult,
): TechnicalTermDiscoveryResult => {
  const accepted = new Map<string, TechnicalTermDiscoveryResult["accepted"][number]>();
  const review = new Map<string, TechnicalTermDiscoveryResult["reviewCandidates"][number]>();
  const add = (candidate: TechnicalTermDiscoveryResult["accepted"][number]): void => {
    const key = candidate.sourceText.toLocaleLowerCase("en-US");
    const existing = accepted.get(key) ?? review.get(key);
    if (existing === undefined || confidenceRank(candidate.confidence) > confidenceRank(existing.confidence)) {
      accepted.set(key, candidate);
      review.delete(key);
    }
  };
  const addReview = (candidate: TechnicalTermDiscoveryResult["reviewCandidates"][number]): void => {
    const key = candidate.sourceText.toLocaleLowerCase("en-US");
    if (accepted.has(key)) return;
    const existing = review.get(key);
    if (existing === undefined || confidenceRank(candidate.confidence) > confidenceRank(existing.confidence)) {
      review.set(key, candidate);
    }
  };
  for (const candidate of [...deterministic.accepted, ...provider.accepted]) add(candidate);
  for (const candidate of [...deterministic.reviewCandidates, ...provider.reviewCandidates]) addReview(candidate);
  const warningKeys = new Set<string>();
  const warnings = [...deterministic.warnings, ...provider.warnings].filter((item) => {
    const key = `${item.code}\u0000${item.sourceText ?? ""}\u0000${item.message}`;
    if (warningKeys.has(key)) return false;
    warningKeys.add(key);
    return true;
  });
  return {
    accepted: [...accepted.values()],
    reviewCandidates: [...review.values()],
    warnings,
  };
};

const repairPromptRule = (guard: RepairTechnicalTermViolationsInput<unknown>["guard"]): string => {
  const activeTerms = guard.profile.entries.map((term) => term.canonical);
  return activeTerms.length === 0
    ? "本次源材料没有已激活的专业术语。"
    : `本次源材料中必须保留的专业术语：${activeTerms.join("、")}`;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const canonicalTermPattern = (
  guard: RepairTechnicalTermViolationsInput<unknown>["guard"],
): RegExp | undefined => {
  const alternatives = [...new Set(guard.profile.entries.map((term) => term.canonical).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  return alternatives.length === 0
    ? undefined
    : new RegExp(`(?<![A-Za-z0-9])(?:${alternatives.join("|")})(?![A-Za-z0-9])`, "giu");
};

const stringMatchesTermOnlyTemplate = (
  current: string,
  repaired: string,
  termPattern: RegExp | undefined,
): boolean => {
  if (current === repaired) return true;
  if (termPattern === undefined) return false;

  const matches = [...repaired.matchAll(termPattern)];
  if (matches.length === 0) return false;
  const segments: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    segments.push(repaired.slice(cursor, match.index).trimEnd());
    cursor = match.index + match[0].length;
  }
  segments.push(repaired.slice(cursor).trimStart());
  for (let index = 1; index < segments.length - 1; index += 1) {
    segments[index] = segments[index]!.trim();
  }

  if (segments.every((segment) => segment === "")) return current.trim() === "";
  const template = new RegExp(`^${segments.map(escapeRegExp).join("[\\s\\S]*")}$`, "u");
  return template.test(current);
};

const hasOnlyTechnicalTermChanges = (
  current: unknown,
  repaired: unknown,
  guard: RepairTechnicalTermViolationsInput<unknown>["guard"],
): boolean => {
  const termPattern = canonicalTermPattern(guard);
  const visit = (left: unknown, right: unknown): boolean => {
    if (typeof left === "string" || typeof right === "string") {
      return typeof left === "string"
        && typeof right === "string"
        && stringMatchesTermOnlyTemplate(left, right, termPattern);
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left)
        && Array.isArray(right)
        && left.length === right.length
        && left.every((child, index) => visit(child, right[index]));
    }
    if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      return Object.keys(leftRecord).every((key) => visit(leftRecord[key], rightRecord[key]));
    }
    return Object.is(left, right);
  };
  return visit(current, repaired);
};

const isReusableDiscoveryResult = (result: TechnicalTermDiscoveryResult): boolean =>
  !result.warnings.some((item) => item.code === "technical-term-discovery-unavailable");

const readPersistentResult = async (input: {
  cache: TechnicalTermDiscoveryCache;
  cacheKey: string;
  sourceIdentity: string;
  model: string;
  catalogFingerprint: string;
}): Promise<TechnicalTermDiscoveryResult | undefined> => {
  try {
    const raw = await input.cache.read(input.cacheKey);
    const record = parseTechnicalTermDiscoveryCacheRecord(raw);
    if (record === undefined
      || record.cacheKey !== input.cacheKey
      || record.sourceIdentity !== input.sourceIdentity
      || record.model !== input.model
      || record.catalogFingerprint !== input.catalogFingerprint
      || !isReusableDiscoveryResult(record.result)) {
      return undefined;
    }
    return record.result;
  } catch {
    return undefined;
  }
};

const writePersistentResult = async (input: {
  cache: TechnicalTermDiscoveryCache;
  cacheKey: string;
  sourceIdentity: string;
  model: string;
  catalogFingerprint: string;
  result: TechnicalTermDiscoveryResult;
}): Promise<void> => {
  if (!isReusableDiscoveryResult(input.result)) return;
  const record = createTechnicalTermDiscoveryCacheRecord({
    cacheKey: input.cacheKey,
    sourceIdentity: input.sourceIdentity,
    model: input.model,
    catalogFingerprint: input.catalogFingerprint,
    result: input.result,
  });
  await input.cache.write(input.cacheKey, record);
};

const persistForCallerCache = (
  pending: Promise<TechnicalTermDiscoveryResult>,
  input: DiscoverTechnicalTermsInput,
  cacheKey: string,
  sourceIdentity: string,
  catalogFingerprint: string,
): Promise<TechnicalTermDiscoveryResult> => {
  if (input.cache === undefined) return pending;
  return pending.then(async (result) => {
    await writePersistentResult({
      cache: input.cache!,
      cacheKey,
      sourceIdentity,
      model: input.model,
      catalogFingerprint,
      result,
    }).catch(() => undefined);
    return result;
  });
};

export const discoverTechnicalTerms = (
  input: DiscoverTechnicalTermsInput,
): Promise<TechnicalTermDiscoveryResult> => {
  const sourceForDiscovery = input.sourceTitle?.trim() === ""
    || input.sourceTitle === undefined
    ? input.sourceText
    : `${input.sourceTitle}\n\n${input.sourceText}`;
  const catalogFingerprint = input.catalogFingerprint ?? TECHNICAL_TERM_CATALOG_FINGERPRINT;
  const key = technicalTermDiscoveryCacheKeyFor(input);
  const existing = completedDiscoveryCache.get(key);
  if (existing !== undefined) {
    return persistForCallerCache(
      existing,
      input,
      key,
      technicalTermDiscoverySourceIdentityFor(input),
      catalogFingerprint,
    );
  }

  const pending = (async (): Promise<TechnicalTermDiscoveryResult> => {
    const sourceIdentity = technicalTermDiscoverySourceIdentityFor(input);
    const deterministic = recognizeDeterministicTechnicalTerms(sourceForDiscovery);
    if (input.cache !== undefined) {
      const cached = await readPersistentResult({
        cache: input.cache,
        cacheKey: key,
        sourceIdentity,
        model: input.model,
        catalogFingerprint,
      });
      if (cached !== undefined) {
        resolvedDiscoveryCache.set(key, cached);
        return cached;
      }
    }

    const catalogHit = catalogMatches(sourceForDiscovery, TECHNICAL_TERM_CATALOG);
    if (!hasDiscoverySignal(sourceForDiscovery) && !catalogHit
      && deterministic.accepted.length === 0 && deterministic.reviewCandidates.length === 0) {
      resolvedDiscoveryCache.set(key, deterministic);
      return deterministic;
    }

    try {
      const response = await input.llm.chat({
        model: input.model,
        messages: [{
          role: "system",
          content: "你是严格的源级专业术语发现器。必须遵守 exact source span 约束，并只返回 JSON。",
        }, {
          role: "user",
          content: buildTechnicalTermDiscoveryPrompt(input.sourceText, input.sourceTitle),
        }],
        temperature: 0.1,
        jsonMode: true,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const parsed = parseTechnicalTermDiscoveryResponse({
        sourceText: sourceForDiscovery,
        response: response.content,
      });
      if (parsed.warnings.some((item) => item.code === "malformed-response")) {
        const result = unavailable("专业术语发现响应无法解析，已跳过未知术语发现。", deterministic);
        completedDiscoveryCache.delete(key);
        return result;
      }
      const result = mergeDiscoveryResults(deterministic, parsed);
      resolvedDiscoveryCache.set(key, result);
      if (input.cache !== undefined) {
        await writePersistentResult({
          cache: input.cache,
          cacheKey: key,
          sourceIdentity,
          model: input.model,
          catalogFingerprint,
          result,
        }).catch(() => undefined);
      }
      return result;
    } catch {
      completedDiscoveryCache.delete(key);
      return unavailable("专业术语发现服务不可用，已继续使用中央术语目录。", deterministic);
    }
  })();
  completedDiscoveryCache.set(key, pending);
  return pending;
};

export const repairTechnicalTermViolations = async <T>(
  input: RepairTechnicalTermViolationsInput<T>,
): Promise<FinalizedTechnicalTermValue<T>> => {
  if (input.violations.length === 0) return { value: input.currentValue, violations: [] };

  try {
    const isString = typeof input.currentValue === "string";
    const response = await input.llm.chat({
      model: input.model,
      messages: [{
        role: "system",
        content: "你是专业术语定向修复器。只修复术语错误，保留 JSON 外层形状。",
      }, {
        role: "user",
        content: technicalTermDiscoveryRepairPrompt(
          input.currentValue,
          input.violations,
          repairPromptRule(input.guard),
        ),
      }],
      temperature: 0.1,
      jsonMode: !isString,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const repaired = input.parseResponse(response.content);
    if (!sameTechnicalTermOuterShape(input.currentValue, repaired)) return {
      value: input.currentValue,
      violations: input.violations,
    };
    const finalized = input.guard.finalize(repaired, input.restoration);
    if (!hasOnlyTechnicalTermChanges(input.currentValue, finalized.value, input.guard)) return {
      value: input.currentValue,
      violations: input.violations,
    };
    return finalized;
  } catch {
    return { value: input.currentValue, violations: input.violations };
  }
};
