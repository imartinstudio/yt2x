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

export const fingerprintTechnicalTermDiscoverySource = (value: string): string =>
  `sha256-${createHash("sha256").update(value, "utf8").digest("hex")}`;

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

export const discoverTechnicalTerms = (
  input: DiscoverTechnicalTermsInput,
): Promise<TechnicalTermDiscoveryResult> => {
  const sourceForDiscovery = input.sourceTitle?.trim() === ""
    || input.sourceTitle === undefined
    ? input.sourceText
    : `${input.sourceTitle}\n\n${input.sourceText}`;
  const catalogFingerprint = input.catalogFingerprint ?? TECHNICAL_TERM_CATALOG_FINGERPRINT;
  const key = [
    fingerprintTechnicalTermDiscoverySource(sourceForDiscovery),
    input.model,
    TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION,
    catalogFingerprint,
  ].join("\u0000");
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
    return input.guard.finalize(repaired, input.restoration);
  } catch {
    return { value: input.currentValue, violations: input.violations };
  }
};
