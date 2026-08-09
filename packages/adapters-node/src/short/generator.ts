import { z } from "zod";
import {
  appendTechnicalTermRuleToSystemPrompt,
  buildShortUserPrompt,
  createTechnicalTermGuard,
  hasHardTechnicalTermViolations,
  SHORT_X_SYSTEM_PROMPT,
  type AvailableVisual,
  type FinalizedTechnicalTermValue,
  type GeneratedShortPost,
  type LlmPort,
} from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";
import { parseJsonWithRepairs, salvageLooseJsonTextField } from "../llm/parse-json.js";
import {
  discoverTechnicalTerms,
  createFileTechnicalTermDiscoveryCacheStore,
  repairTechnicalTermViolations,
  technicalTermDiscoveryAuditFor,
} from "../technical-terms/discovery.js";
import {
  CONTENT_PROMPT_VERSIONS,
  contentSourceFingerprintFor,
  structuredNotesContentSourceFor,
} from "../content-cache.js";

export type GenerateXShortInput = {
  llm: LlmPort;
  model: string;
  temperature?: number;
  maxTokens?: number;
  artifacts: StructuredNotesArtifacts;
  availableVisuals?: AvailableVisual[] | null;
  signal?: AbortSignal;
  technicalTermDiscoveryCacheDir?: string;
};

export type GenerateXShortResult = {
  shortPost: GeneratedShortPost;
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  videoId: string;
  durationMs: number;
  technicalTermProfileFingerprint: string;
  technicalTermDiscovery: ReturnType<typeof technicalTermDiscoveryAuditFor>;
  sourceFingerprint: string;
  promptVersion: string;
};

const ShortVisualSchema = z.object({
  visual_id: z.string().min(1),
  caption: z.string().min(1),
});

const GeneratedShortPostSchema = z.object({
  text: z.string().min(1),
  angle: z.enum(["contrarian", "practical", "trend", "technical", "discussion"]),
  risk: z.enum(["low", "medium", "high"]),
  visual: ShortVisualSchema.optional(),
});

const MARKDOWN_TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const MARKDOWN_TABLE_ROW_RE = /^\s*\|.+\|\s*$/;

const hasMarkdownTable = (text: string): boolean =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => MARKDOWN_TABLE_DIVIDER_RE.test(line) || MARKDOWN_TABLE_ROW_RE.test(line));

const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const stripJsonFenceWrapper = (s: string): string => {
  const m = s.match(JSON_FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};

export const parseGeneratedShortPostJson = (jsonText: string): GeneratedShortPost => {
  const cleaned = stripJsonFenceWrapper(jsonText.trim());
  let parsed: unknown;

  // Try repaired JSON first (handles trailing commas, unescaped chars, etc.)
  try {
    parsed = parseJsonWithRepairs(cleaned);
  } catch {
    // Fall back to salvage: extract the "text" field by regex
    const salvaged = salvageLooseJsonTextField(cleaned, "text");
    if (salvaged !== null && salvaged.trim().length > 0) {
      parsed = { text: salvaged, angle: "discussion", risk: "low" };
    } else {
      throw new Error(`Short post LLM response is not valid JSON and could not be salvaged`);
    }
  }

  const result = GeneratedShortPostSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Short post LLM response does not match expected schema: ${result.error.message}`);
  }
  const raw = result.data;
  if (hasMarkdownTable(raw.text)) {
    throw new Error(
      "Short post LLM response contains a markdown table. Regenerate x-short content as a numbered list, bullet list, or field/value lines instead of tables.",
    );
  }
  const data: GeneratedShortPost = {
    text: raw.text,
    angle: raw.angle,
    risk: raw.risk,
  };
  if (raw.visual !== undefined) data.visual = raw.visual;
  return data;
};

export const generateXShortContent = async (
  input: GenerateXShortInput,
): Promise<GenerateXShortResult> => {
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
  const guard = createTechnicalTermGuard({
    sourceText,
    sourceTitle,
    discoveredTerms: discovery.accepted,
    discovery: discoveryAudit,
  });
  const prepared = guard.prepare({
    metadata: input.artifacts.metadata,
    structuredNotesMd: input.artifacts.structuredNotesMd,
    availableVisuals: input.availableVisuals ?? null,
  });
  const userPrompt = buildShortUserPrompt(prepared.value, { platform: "x" });
  const systemPrompt = appendTechnicalTermRuleToSystemPrompt(SHORT_X_SYSTEM_PROMPT, prepared.promptRule);

  const t0 = Date.now();
  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: input.temperature ?? 0.55,
    maxTokens: input.maxTokens ?? 2048,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  let shortPost = parseGeneratedShortPostJson(resp.content);

  // Post-process: fix common LLM CJK homoglyph errors (e.g. 幺→么)
  try {
    const { fixLlmHomoglyphs } = await import("../acquire/simplify-chinese.js");
    shortPost.text = fixLlmHomoglyphs(shortPost.text);
  } catch {
    // Keep original if import/processing fails
  }
  // Remove invalid visual references before the one and only term repair/final validation.
  if (shortPost.visual !== undefined) {
    const availVisuals = input.availableVisuals ?? [];
    const validIds = new Set(availVisuals.map((v) => v.visual_id));
    if (!validIds.has(shortPost.visual.visual_id)) delete shortPost.visual;
  }
  const schemaResult = GeneratedShortPostSchema.safeParse(shortPost);
  if (!schemaResult.success) {
    throw new Error(`Short post-process result does not match expected schema: ${schemaResult.error.message}`);
  }
  shortPost = {
    text: schemaResult.data.text,
    angle: schemaResult.data.angle,
    risk: schemaResult.data.risk,
    ...(schemaResult.data.visual === undefined ? {} : { visual: schemaResult.data.visual }),
  };

  let finalized: FinalizedTechnicalTermValue<GeneratedShortPost> = guard.finalize(shortPost, prepared.restoration);
  if (hasHardTechnicalTermViolations(finalized.violations)) {
    finalized = await repairTechnicalTermViolations({
      llm: input.llm,
      model: input.model,
      guard,
      currentValue: finalized.value,
      restoration: prepared.restoration,
      violations: finalized.violations,
      parseResponse: parseGeneratedShortPostJson,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }
  if (hasHardTechnicalTermViolations(finalized.violations)) {
    throw new Error(`Technical term validation failed: ${finalized.violations.map((item) => item.message).join("; ")}`);
  }
  shortPost = finalized.value;
  const finalSchemaResult = GeneratedShortPostSchema.safeParse(shortPost);
  if (!finalSchemaResult.success) {
    throw new Error(`Short final post-process result does not match expected schema: ${finalSchemaResult.error.message}`);
  }

  const result: GenerateXShortResult = {
    shortPost,
    model: resp.model,
    finishReason: resp.finishReason,
    videoId: input.artifacts.videoId,
    durationMs: Date.now() - t0,
    technicalTermProfileFingerprint: prepared.profileFingerprint,
    technicalTermDiscovery: discoveryAudit,
    sourceFingerprint: contentSourceFingerprintFor(structuredNotesContentSourceFor({
      metadata: input.artifacts.metadata,
      structuredNotesMd: input.artifacts.structuredNotesMd,
      availableVisuals: input.availableVisuals,
    })),
    promptVersion: CONTENT_PROMPT_VERSIONS.xShort,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};
