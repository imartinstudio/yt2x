import { createHash } from "node:crypto";
import {
  buildTechnicalTermDiscoveryPrompt,
  parseTechnicalTermDiscoveryResponse,
  sameTechnicalTermOuterShape,
  technicalTermDiscoveryRepairPrompt,
  TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION,
  TECHNICAL_TERM_CATALOG,
  TECHNICAL_TERM_CATALOG_FINGERPRINT,
  type DiscoverTechnicalTermsInput,
  type FinalizedTechnicalTermValue,
  type RepairTechnicalTermViolationsInput,
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

export const fingerprintTechnicalTermDiscoverySource = (value: string): string =>
  `sha256-${createHash("sha256").update(value, "utf8").digest("hex")}`;

const discoveryCacheKey = (input: {
  model: string;
  sourceText: string;
  sourceTitle?: string;
  catalogFingerprint?: string;
}): string => {
  const sourceForDiscovery = input.sourceTitle?.trim() === ""
    || input.sourceTitle === undefined
    ? input.sourceText
    : `${input.sourceTitle}\n\n${input.sourceText}`;
  return [
    fingerprintTechnicalTermDiscoverySource(sourceForDiscovery),
    input.model,
    TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION,
    input.catalogFingerprint ?? TECHNICAL_TERM_CATALOG_FINGERPRINT,
  ].join("\u0000");
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
  const result = resolvedDiscoveryCache.get(discoveryCacheKey(input));
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

const unavailable = (message: string): TechnicalTermDiscoveryResult => ({
  accepted: [],
  reviewCandidates: [],
  warnings: [{ code: "technical-term-discovery-unavailable", message }],
});

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

export const discoverTechnicalTerms = (
  input: DiscoverTechnicalTermsInput,
): Promise<TechnicalTermDiscoveryResult> => {
  const sourceForDiscovery = input.sourceTitle?.trim() === ""
    || input.sourceTitle === undefined
    ? input.sourceText
    : `${input.sourceTitle}\n\n${input.sourceText}`;
  const key = discoveryCacheKey(input);
  const existing = completedDiscoveryCache.get(key);
  if (existing !== undefined) return existing;

  const catalogHit = catalogMatches(sourceForDiscovery, TECHNICAL_TERM_CATALOG);
  if (!hasDiscoverySignal(sourceForDiscovery) && !catalogHit) {
    const skipped = Promise.resolve({ accepted: [], reviewCandidates: [], warnings: [] });
    completedDiscoveryCache.set(key, skipped);
    return skipped;
  }

  const pending = input.llm.chat({
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
  }).then((response) => {
    const parsed = parseTechnicalTermDiscoveryResponse({
      sourceText: sourceForDiscovery,
      response: response.content,
    });
    if (parsed.warnings.some((item) => item.code === "malformed-response")) {
      completedDiscoveryCache.delete(key);
      return unavailable("专业术语发现响应无法解析，已跳过未知术语发现。");
    }
    resolvedDiscoveryCache.set(key, parsed);
    return parsed;
  }).catch(() => {
    completedDiscoveryCache.delete(key);
    return unavailable("专业术语发现服务不可用，已继续使用中央术语目录。");
  });
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
