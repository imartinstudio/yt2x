import type { LlmPort } from "../ports/llm.js";
import type {
  DiscoveredTechnicalTerm,
  FinalizedTechnicalTermValue,
  TechnicalTermCategory,
  TechnicalTermGuard,
  TechnicalTermRestoration,
  TechnicalTermViolation,
} from "./technical-term-catalog.js";

export const TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION = "technical-term-discovery-v1";

export type TechnicalTermDiscoveryWarningCode =
  | "malformed-response"
  | "invalid-candidate"
  | "candidate-not-in-source"
  | "duplicate-candidate"
  | "low-confidence-candidate"
  | "technical-term-discovery-unavailable";

export type TechnicalTermDiscoveryWarning = {
  code: TechnicalTermDiscoveryWarningCode;
  message: string;
  sourceText?: string;
};

export type TechnicalTermDiscoveryResult = {
  accepted: readonly DiscoveredTechnicalTerm[];
  reviewCandidates: readonly DiscoveredTechnicalTerm[];
  warnings: readonly TechnicalTermDiscoveryWarning[];
};

export type ParseTechnicalTermDiscoveryResponseInput = {
  sourceText: string;
  response: string;
};

export type DiscoverTechnicalTermsInput = {
  llm: LlmPort;
  model: string;
  sourceText: string;
  sourceTitle?: string;
  catalogFingerprint?: string;
  signal?: AbortSignal;
};

export type RepairTechnicalTermViolationsInput<T> = {
  llm: LlmPort;
  model: string;
  guard: TechnicalTermGuard;
  currentValue: T;
  restoration: TechnicalTermRestoration;
  violations: readonly TechnicalTermViolation[];
  parseResponse: (content: string) => T;
  signal?: AbortSignal;
};

const CATEGORIES: readonly TechnicalTermCategory[] = [
  "ai",
  "ai-coding",
  "ai-agent",
  "product",
  "person",
  "domain",
];
const CONFIDENCES = ["high", "medium", "low"] as const;

const findExactSourceSpan = (sourceText: string, candidate: string): string | undefined => {
  const trimmed = candidate.trim();
  if (trimmed === "") return undefined;
  const escapedWords = trimmed.split(/\s+/u).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const match = sourceText.match(new RegExp(`(?<![A-Za-z0-9])${escapedWords.join("\\s+")}(?![A-Za-z0-9])`, "iu"));
  return match?.[0];
};

const warning = (
  code: TechnicalTermDiscoveryWarningCode,
  message: string,
  sourceText?: string,
): TechnicalTermDiscoveryWarning => ({
  code,
  message,
  ...(sourceText === undefined ? {} : { sourceText }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const confidenceRank = (confidence: DiscoveredTechnicalTerm["confidence"]): number =>
  confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;

export const parseTechnicalTermDiscoveryResponse = ({
  sourceText,
  response,
}: ParseTechnicalTermDiscoveryResponseInput): TechnicalTermDiscoveryResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response) as unknown;
  } catch {
    return {
      accepted: [],
      reviewCandidates: [],
      warnings: [warning("malformed-response", "术语发现响应不是合法 JSON。")],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      accepted: [],
      reviewCandidates: [],
      warnings: [warning("malformed-response", "术语发现响应必须是 JSON 数组。")],
    };
  }

  const warnings: TechnicalTermDiscoveryWarning[] = [];
  const candidates = new Map<string, DiscoveredTechnicalTerm>();
  for (const raw of parsed) {
    if (!isRecord(raw)
      || typeof raw.sourceText !== "string"
      || !CONFIDENCES.includes(raw.confidence as typeof CONFIDENCES[number])
      || !CATEGORIES.includes(raw.category as TechnicalTermCategory)) {
      warnings.push(warning("invalid-candidate", "术语发现候选缺少有效的 sourceText、confidence 或 category。"));
      continue;
    }

    const confidence = raw.confidence as DiscoveredTechnicalTerm["confidence"];
    const category = raw.category as TechnicalTermCategory;
    const exactSourceText = findExactSourceSpan(sourceText, raw.sourceText);
    if (exactSourceText === undefined) {
      warnings.push(warning("candidate-not-in-source", `候选术语不在源材料中：${raw.sourceText}`, raw.sourceText));
      continue;
    }

    const candidate: DiscoveredTechnicalTerm = { sourceText: exactSourceText, confidence, category };
    const key = exactSourceText.toLocaleLowerCase("en-US");
    const previous = candidates.get(key);
    if (previous !== undefined) {
      warnings.push(warning("duplicate-candidate", `候选术语重复：${exactSourceText}`, exactSourceText));
      if (confidenceRank(candidate.confidence) <= confidenceRank(previous.confidence)) continue;
    }
    candidates.set(key, candidate);
  }

  const accepted: DiscoveredTechnicalTerm[] = [];
  const reviewCandidates: DiscoveredTechnicalTerm[] = [];
  for (const candidate of candidates.values()) {
    if (candidate.confidence === "high") accepted.push(candidate);
    else if (candidate.confidence === "medium") reviewCandidates.push(candidate);
    else warnings.push(warning("low-confidence-candidate", `忽略低置信度候选：${candidate.sourceText}`, candidate.sourceText));
  }
  return { accepted, reviewCandidates, warnings };
};

export const buildTechnicalTermDiscoveryPrompt = (
  sourceText: string,
  sourceTitle = "",
): string => [
  `Prompt version: ${TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION}.`,
  "从源材料中发现 AI、AI coding、AI agent 相关的专业术语。",
  "只返回 JSON 数组，每项包含 sourceText、confidence（high/medium/low）和 category（ai/ai-coding/ai-agent/product/person/domain）。",
  "sourceText 必须是从源材料逐字复制的、连续且 exact 的 source span；不要翻译、改写、归一化大小写或凭空创造术语。",
  "只把明确的专业术语作为候选，不要把普通动词、泛化名词或完整句子列入结果。",
  sourceTitle.trim() === "" ? `Source text:\n${sourceText}` : `Source title:\n${sourceTitle}\n\nSource text:\n${sourceText}`,
].join("\n\n");

export const technicalTermDiscoveryRepairPrompt = <T>(
  currentValue: T,
  violations: readonly TechnicalTermViolation[],
  promptRule: string,
): string => [
  "修复当前产物中的专业术语硬错误，只做必要的术语恢复，不改变外层数据形状或其他内容。",
  promptRule,
  `当前违反项：${JSON.stringify(violations)}`,
  "保留当前值中所有字段、数组结构和非术语文本；缺失的源术语必须使用标准 canonical 原文。",
  `Current value:\n${typeof currentValue === "string" ? currentValue : JSON.stringify(currentValue)}`,
  "只输出修复后的值；对象/数组输出合法 JSON，字符串直接输出字符串内容。",
].join("\n\n");

export const sameTechnicalTermOuterShape = (left: unknown, right: unknown): boolean => {
  if (typeof left === "string" || typeof right === "string") {
    return typeof left === "string" && typeof right === "string";
  }
  if (left === null || right === null) return left === null && right === null;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((child, index) => sameTechnicalTermOuterShape(child, right[index]));
  }
  if (typeof left === "object" || typeof right === "object") {
    if (typeof left !== "object" || typeof right !== "object") return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && sameTechnicalTermOuterShape(leftRecord[key], rightRecord[key]));
  }
  return typeof left === typeof right;
};

export type { DiscoveredTechnicalTerm, FinalizedTechnicalTermValue };
