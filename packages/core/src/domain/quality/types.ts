import type { YouTubeMetadata } from "../notes/types.js";

/**
 * 内容质量规则与 fixture 的领域类型。
 *
 * 该模块只定义规则与检查所需的纯数据结构，不依赖 fs / fetch 等 Node-only API。
 * 配套实现位于：
 * - `rules.ts`：跨目标共用的质量规则常量
 * - `fixtures.ts`：用于 prompt 单测与确定性检查的脱敏 fixture
 * - `checks.ts`：Article / Short / Thread 的确定性校验函数
 */

/** 高信任成本主题分类。 */
export type HighTrustTopic =
  | "account"
  | "payment"
  | "credentials"
  | "automation";

/** 可执行资产类型。 */
export type ExecutableAssetKind =
  | "prompt"
  | "template"
  | "checklist"
  | "steps"
  | "risk-list"
  | "decision-tree";

/** Hook 元素类型。前 120 字必须命中至少 2 个。 */
export type HookElement = "scene" | "pain" | "loss" | "gain" | "contrast";

/** 视觉建议类型。 */
export type VisualSuggestionKind =
  | "ui-screenshot"
  | "diagram"
  | "comparison"
  | "template-card"
  | "none";

/** Article / Short / Thread 通用质量期望。 */
export type ContentQualityExpectation = {
  /** 期望命中的 Hook 元素。 */
  hookElements: readonly HookElement[];
  /** 是否需要独立风险/边界小节或 tweet。 */
  requiresRiskSection: boolean;
  /** 命中的高信任主题；为空表示非高信任内容。 */
  highTrustTopics: readonly HighTrustTopic[];
  /** 至少应提供的可执行资产类型。 */
  executableAssetKinds: readonly ExecutableAssetKind[];
  /** 视觉需求。 */
  visualNeed: VisualSuggestionKind;
};

/** Fixture 类别。 */
export type ContentQualityFixtureCategory =
  | "high-trust-tutorial"
  | "abstract-framework"
  | "general-tool-tutorial";

/**
 * 用于 prompt / quality check 单测的内容 fixture。
 *
 * 约束：
 * - metadata.id、metadata.title 必须是占位符或脱敏值，不得使用真实视频 ID。
 * - structuredNotesMd 中不得包含真实 API key、OAuth token、cookies、浏览器凭证。
 * - 仅作为单测样例，不会进入运行时数据流。
 */
export type ContentQualityFixture = {
  /** 在测试中引用的稳定 ID，例如 `fx-account-region`。 */
  id: string;
  /** 内容类别。 */
  category: ContentQualityFixtureCategory;
  /** 人类可读的简介，说明这条 fixture 关心的质量点。 */
  description: string;
  metadata: YouTubeMetadata;
  structuredNotesMd: string;
  /** 三个目标各自的期望，便于 prompt 测试和 quality check 测试复用。 */
  expectations: {
    article: ContentQualityExpectation;
    short: ContentQualityExpectation;
    thread: ContentQualityExpectation;
  };
};
