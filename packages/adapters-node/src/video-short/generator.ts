import { z } from "zod";
import {
  appendTechnicalTermRuleToSystemPrompt,
  buildVideoShortUserPrompt,
  createTechnicalTermGuard,
  hasHardTechnicalTermViolations,
  VIDEO_SHORT_X_SYSTEM_PROMPT,
  type GeneratedVideoShortPost,
  type FinalizedTechnicalTermValue,
  type LlmPort,
} from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";
import { parseJsonWithRepairs, salvageLooseJsonTextField, stripJsonFenceWrapper } from "../llm/parse-json.js";
import {
  discoverTechnicalTerms,
  createFileTechnicalTermDiscoveryCacheStore,
  repairTechnicalTermViolations,
  technicalTermDiscoveryAuditFor,
} from "../technical-terms/discovery.js";
import {
  CONTENT_PROMPT_VERSIONS,
  contentSourceFingerprintFor,
  knownSourceTextWithMetadata,
  summarySourceTextFor,
  structuredNotesContentSourceFor,
} from "../content-cache.js";

export type GenerateXVideoShortInput = {
  llm: LlmPort;
  model: string;
  temperature?: number;
  maxTokens?: number;
  artifacts: StructuredNotesArtifacts;
  availableVisuals?: unknown;
  signal?: AbortSignal;
  technicalTermDiscoveryCacheDir?: string;
};

export type GenerateXVideoShortResult = {
  videoShortPost: GeneratedVideoShortPost;
  model: string;
  requestedModel: string;
  resolvedModel: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  videoId: string;
  durationMs: number;
  technicalTermProfileFingerprint: string;
  technicalTermDiscovery: ReturnType<typeof technicalTermDiscoveryAuditFor>;
  sourceFingerprint: string;
  promptVersion: string;
};

const GeneratedVideoShortPostSchema = z.object({
  text: z.string().min(1),
});

const JSON_REPAIR_USER_PROMPT =
  'Your previous reply was not valid JSON. Reply again with strict JSON only in the shape {"text":"..."}. Escape every double quote and newline inside the text field. Do not add markdown fences or commentary.';

export const parseGeneratedVideoShortPostJson = (jsonText: string): GeneratedVideoShortPost => {
  const raw = stripJsonFenceWrapper(jsonText);
  let parsed: unknown;
  try {
    parsed = parseJsonWithRepairs(raw);
  } catch (err: unknown) {
    const salvaged = salvageLooseJsonTextField(raw, "text");
    if (salvaged === null || salvaged.trim().length === 0) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Video short LLM response is not valid JSON: ${message}`, { cause: err });
    }
    parsed = { text: salvaged };
  }

  const result = GeneratedVideoShortPostSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Video short LLM response does not match expected schema: ${result.error.message}`);
  }
  return { text: result.data.text };
};

const chatVideoShort = async (
  input: GenerateXVideoShortInput,
  userPrompt: string,
  systemPrompt: string,
  temperature: number,
  maxTokens: number,
): Promise<{ content: string; model: string; finishReason: string; usage?: GenerateXVideoShortResult["usage"] }> => {
  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature,
    maxTokens,
    reasoningMode: "disabled",
    jsonMode: true,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  return resp;
};

export const generateXVideoShortContent = async (
  input: GenerateXVideoShortInput,
): Promise<GenerateXVideoShortResult> => {
  const sourceText = input.artifacts.structuredNotesMd;
  const sourceTitle = input.artifacts.metadata.title ?? "";
  const discovery = await discoverTechnicalTerms({
    llm: input.llm,
    model: input.model,
    sourceText,
    sourceTitle,
    ...(input.technicalTermDiscoveryCacheDir === undefined ? {} : {
      cache: createFileTechnicalTermDiscoveryCacheStore(input.technicalTermDiscoveryCacheDir),
    }),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const discoveryAudit = technicalTermDiscoveryAuditFor(discovery, { sourceText, sourceTitle });
  // 已知范围要覆盖 prepare() 递给模型的全部材料：metadata 也在 prompt 里，
  // 只在其中出现的词（作者名、频道名、简介里的产品名）不该被判成凭空造词。
  const fullGuard = createTechnicalTermGuard({
    sourceText: knownSourceTextWithMetadata(input.artifacts.metadata, sourceText),
    sourceTitle,
    discoveredTerms: discovery.accepted,
    discovery: discoveryAudit,
  });
  const guard = fullGuard.scope(summarySourceTextFor(sourceText), sourceTitle);
  const prepared = guard.prepare({
    metadata: input.artifacts.metadata,
    structuredNotesMd: input.artifacts.structuredNotesMd,
  });
  const userPrompt = buildVideoShortUserPrompt(prepared.value, { platform: "x" });
  const systemPrompt = appendTechnicalTermRuleToSystemPrompt(VIDEO_SHORT_X_SYSTEM_PROMPT, prepared.promptRule);

  const t0 = Date.now();
  const maxTokens = input.maxTokens ?? 2048;
  const temperature = input.temperature ?? 0.6;

  let resp = await chatVideoShort(input, userPrompt, systemPrompt, temperature, maxTokens);
  let videoShortPost: GeneratedVideoShortPost;
  try {
    videoShortPost = parseGeneratedVideoShortPostJson(resp.content);
  } catch {
    const repairResp = await input.llm.chat({
      model: input.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
        { role: "assistant", content: resp.content },
        { role: "user", content: JSON_REPAIR_USER_PROMPT },
      ],
      temperature: 0.2,
      maxTokens,
      reasoningMode: "disabled",
      jsonMode: true,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    resp = repairResp;
    videoShortPost = parseGeneratedVideoShortPostJson(repairResp.content);
  }

  // Post-process: fix common LLM CJK homoglyph errors (e.g. 幺→么)
  try {
    const { fixLlmHomoglyphs } = await import("../acquire/simplify-chinese.js");
    videoShortPost.text = fixLlmHomoglyphs(videoShortPost.text);
  } catch {
    // Keep original if import/processing fails
  }
  let finalized: FinalizedTechnicalTermValue<GeneratedVideoShortPost> = guard.finalize(
    videoShortPost,
    prepared.restoration,
  );
  if (hasHardTechnicalTermViolations(finalized.violations)) {
    finalized = await repairTechnicalTermViolations({
      llm: input.llm,
      model: input.model,
      guard,
      currentValue: finalized.value,
      restoration: prepared.restoration,
      violations: finalized.violations,
      parseResponse: parseGeneratedVideoShortPostJson,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }
  if (hasHardTechnicalTermViolations(finalized.violations)) {
    throw new Error(`Technical term validation failed: ${finalized.violations.map((item) => item.message).join("; ")}`);
  }
  videoShortPost = finalized.value;
  const finalSchemaResult = GeneratedVideoShortPostSchema.safeParse(videoShortPost);
  if (!finalSchemaResult.success) {
    throw new Error(`Video short final post-process result does not match expected schema: ${finalSchemaResult.error.message}`);
  }

  const result: GenerateXVideoShortResult = {
    videoShortPost,
    model: resp.model,
    requestedModel: input.model,
    resolvedModel: resp.model,
    finishReason: resp.finishReason,
    videoId: input.artifacts.videoId,
    durationMs: Date.now() - t0,
    technicalTermProfileFingerprint: prepared.profileFingerprint,
    technicalTermDiscovery: discoveryAudit,
    sourceFingerprint: contentSourceFingerprintFor(structuredNotesContentSourceFor({
      metadata: input.artifacts.metadata,
      structuredNotesMd: input.artifacts.structuredNotesMd,
    })),
    promptVersion: CONTENT_PROMPT_VERSIONS.xVideoShort,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};
