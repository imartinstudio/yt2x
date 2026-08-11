import {
  appendTechnicalTermRuleToSystemPrompt,
  createTechnicalTermGuard,
  hasHardTechnicalTermViolations,
  getNotesSystemPrompt,
  buildNotesUserPrompt,
  type FinalizedTechnicalTermValue,
  type LlmPort,
} from "@yt2x/core";
import {
  discoverTechnicalTerms,
  repairTechnicalTermViolations,
  technicalTermDiscoveryAuditFor,
} from "../technical-terms/discovery.js";
import {
  CONTENT_PROMPT_VERSIONS,
  contentSourceFingerprintFor,
  notesContentSourceFor,
} from "../content-cache.js";
import type { VideoDirArtifacts } from "./file-store.js";

export type GenerateNotesInput = {
  llm: LlmPort;
  model: string;
  /** 默认 0.3（与旧 pipeline 一致） */
  temperature?: number;
  /** 默认 16384，覆盖一般长视频笔记 */
  maxTokens?: number;
  artifacts: VideoDirArtifacts;
  outputLanguage?: "zh" | "en";
  signal?: AbortSignal;
};

export type GenerateNotesResult = {
  content: string;
  model: string;
  requestedModel: string;
  resolvedModel: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  videoId: string;
  durationMs: number;
  sourceFingerprint: string;
  promptVersion: string;
  technicalTermProfileFingerprint: string;
  technicalTermDiscovery: ReturnType<typeof technicalTermDiscoveryAuditFor>;
};

/**
 * 调 LLM 生成 structured-notes.md 内容（**不**落盘——调用方决定写哪、是否覆盖）。
 *
 * 把"业务编排"和"FS 持久化"分开是有意的：
 *  - 单测可以用 mock LlmPort 验证 prompt 构造，不碰文件系统
 *  - 后续 v0.2 extension 可以复用此函数，把笔记写到 IndexedDB 而不是磁盘
 */
export const generateNotesContent = async (
  input: GenerateNotesInput,
): Promise<GenerateNotesResult> => {
  const promptOpts = { outputLanguage: input.outputLanguage ?? "zh" as const };
  const sourceText = `${input.artifacts.chunksMd}\n${input.artifacts.timestampedCuesMd}`;
  const sourceTitle = input.artifacts.metadata.title ?? "";
  const discovery = await discoverTechnicalTerms({
    llm: input.llm,
    model: input.model,
    sourceText,
    sourceTitle,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  // 审计必须带上 sourceIdentity：内容缓存用它写 known/required 源指纹，
  // 缺了就退化成空串，笔记每次都会重算。
  const discoveryAudit = technicalTermDiscoveryAuditFor(discovery, { sourceText, sourceTitle });
  const guard = createTechnicalTermGuard({
    sourceText,
    sourceTitle,
    discoveredTerms: discovery.accepted,
    discovery: discoveryAudit,
  });
  const prepared = guard.prepare({
    metadata: input.artifacts.metadata,
    chunksMd: input.artifacts.chunksMd,
    timestampedCuesMd: input.artifacts.timestampedCuesMd,
    screenshots: input.artifacts.screenshots ?? null,
  });
  const userPrompt = buildNotesUserPrompt(prepared.value, promptOpts);
  const systemPrompt = appendTechnicalTermRuleToSystemPrompt(
    getNotesSystemPrompt(promptOpts),
    prepared.promptRule,
  );

  const finalize = async (
    value: string,
  ): Promise<FinalizedTechnicalTermValue<string>> => {
    let finalized = guard.finalize(value, prepared.restoration);
    if (hasHardTechnicalTermViolations(finalized.violations)) {
      finalized = await repairTechnicalTermViolations({
        llm: input.llm,
        model: input.model,
        guard,
        currentValue: finalized.value,
        restoration: prepared.restoration,
        violations: finalized.violations,
        parseResponse: (content) => stripCodeFenceWrapper(content.trim()),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    }
    if (hasHardTechnicalTermViolations(finalized.violations)) {
      throw new Error(`Technical term validation failed: ${finalized.violations.map((item) => item.message).join("; ")}`);
    }
    return finalized;
  };

  const t0 = Date.now();
  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: input.temperature ?? 0.3,
    maxTokens: input.maxTokens ?? 16384,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  // LLM 偶尔会在末尾给出 ```markdown ... ``` 包裹，去掉它
  let content = stripCodeFenceWrapper(resp.content.trim());

  // Post-process: fix common LLM CJK homoglyph errors (e.g. 幺→么)
  try {
    const { fixLlmHomoglyphs } = await import("../acquire/simplify-chinese.js");
    content = fixLlmHomoglyphs(content);
  } catch {
    // Keep original content if import/processing fails
  }
  content = (await finalize(content)).value;

  const result: GenerateNotesResult = {
    content,
    model: resp.model,
    requestedModel: input.model,
    resolvedModel: resp.model,
    finishReason: resp.finishReason,
    videoId: input.artifacts.videoId,
    durationMs: Date.now() - t0,
    sourceFingerprint: contentSourceFingerprintFor(notesContentSourceFor({
      metadata: input.artifacts.metadata,
      chunksMd: input.artifacts.chunksMd,
      timestampedCuesMd: input.artifacts.timestampedCuesMd,
      screenshots: input.artifacts.screenshots,
    })),
    promptVersion: CONTENT_PROMPT_VERSIONS.notes,
    technicalTermProfileFingerprint: guard.profile.profileFingerprint,
    technicalTermDiscovery: discoveryAudit,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};

const FENCE_RE = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/;
const stripCodeFenceWrapper = (s: string): string => {
  const m = s.match(FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};
