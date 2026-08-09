import {
  createTechnicalTermGuard,
  type TechnicalTermGuard,
} from "./technical-term-catalog.js";

export {
  appendTechnicalTermRuleToSystemPrompt,
  buildTechnicalTermPromptRule,
  createTechnicalTermGuard,
  defineTechnicalTermCatalog,
  hasHardTechnicalTermViolations,
  TECHNICAL_TERM_CATALOG,
  TECHNICAL_TERM_CATALOG_FINGERPRINT,
  type CreateTechnicalTermGuardArgs,
  type DiscoveredTechnicalTerm,
  type FinalizedTechnicalTermValue,
  type PreparedTechnicalTermValue,
  type ResolvedTechnicalTerm,
  type TechnicalTermCatalog,
  type TechnicalTermCategory,
  type TechnicalTermEntry,
  type TechnicalTermGuard,
  type TechnicalTermOccurrence,
  type TechnicalTermPolicy,
  type TechnicalTermArtifact,
  type TechnicalTermProfile,
  type TechnicalTermRestoration,
  type TechnicalTermViolation,
  type TechnicalTermViolationCode,
} from "./technical-term-catalog.js";

const guardFor = (sourceText: string, sourceTitle = ""): TechnicalTermGuard =>
  createTechnicalTermGuard({ sourceText, sourceTitle });

/** 兼容旧调用方：恢复字符串中的源技术术语。 */
export const restoreProtectedTechnicalTermsInContent = (
  content: string,
  sourceText: string,
  sourceTitle = "",
): string => {
  const guard = guardFor(sourceText, sourceTitle);
  const prepared = guard.prepare(content);
  return guard.finalize(prepared.value, prepared.restoration).value;
};

/** 兼容旧调用方：递归恢复 JSON-like 产物中的字符串字段。 */
export const restoreProtectedTechnicalTermsInValue = <T>(
  value: T,
  sourceText: string,
  sourceTitle = "",
): T => {
  const guard = guardFor(sourceText, sourceTitle);
  const prepared = guard.prepare(value);
  return guard.finalize(prepared.value, prepared.restoration).value;
};

/** 兼容旧调用方：只恢复标题源材料中实际出现的术语。 */
export const restoreProtectedTechnicalTermsInTitle = (
  translatedTitle: string,
  sourceText: string,
  sourceTitle: string,
): string => {
  const guard = createTechnicalTermGuard({ sourceText: sourceTitle });
  const prepared = guard.prepare(translatedTitle);
  return guard.finalize(prepared.value, prepared.restoration).value;
};
