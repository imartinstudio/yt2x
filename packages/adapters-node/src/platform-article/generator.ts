import { z } from "zod";
import {
  appendTechnicalTermRuleToSystemPrompt,
  buildPlatformArticleUserPrompt,
  createTechnicalTermGuard,
  getPlatformArticleSystemPrompt,
  hasHardTechnicalTermViolations,
  type FinalizedTechnicalTermValue,
  type LlmPort,
  type PlatformArticleTarget,
} from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";
import { parseJsonWithRepairs } from "../llm/parse-json.js";
import {
  discoverTechnicalTerms,
  repairTechnicalTermViolations,
  technicalTermDiscoveryAuditFor,
} from "../technical-terms/discovery.js";

export type GeneratePlatformArticleInput = {
  llm: LlmPort;
  model: string;
  target: PlatformArticleTarget;
  temperature?: number;
  maxTokens?: number;
  artifacts: StructuredNotesArtifacts;
  articleMd: string;
  timestampedCuesMd?: string;
  signal?: AbortSignal;
};

export type GeneratePlatformArticleResult = {
  platformArticle: GeneratedPlatformArticle;
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  videoId: string;
  durationMs: number;
};

const CoverSchema = z.object({
  headline: z.string().min(1),
  subhead: z.string().min(1).optional(),
  visual_prompt: z.string().min(1),
});

const XiaohongshuArticleSchema = z.object({
  target: z.literal("xiaohongshu"),
  title: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string().min(1)).min(3).max(8),
  cover: CoverSchema.optional(),
  notes: z.array(z.string().min(1)).optional(),
});

const WechatArticleSchema = z.object({
  target: z.literal("wechat"),
  title: z.string().min(1),
  title_options: z.array(z.string().min(1)).min(1).max(6),
  summary: z.string().min(1),
  lead: z.string().min(1),
  body: z.string().min(1),
  cover: CoverSchema,
});

const BilibiliTimelineItemSchema = z.object({
  time: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
});

const BilibiliArticleSchema = z.object({
  target: z.literal("bilibili"),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1),
  tags: z.array(z.string().min(1)).min(3).max(12),
  timeline: z.array(BilibiliTimelineItemSchema).min(1),
  comment_prompt: z.string().min(1),
});

const GeneratedPlatformArticleSchema = z.discriminatedUnion("target", [
  XiaohongshuArticleSchema,
  WechatArticleSchema,
  BilibiliArticleSchema,
]);

export type GeneratedPlatformArticle = z.infer<typeof GeneratedPlatformArticleSchema>;

/**
 * Thrown when the response is not parseable JSON at all — as opposed to parsing
 * fine but failing the schema. Only the former is worth asking the model again:
 * a malformed brace is a slip, a wrong shape is a misread prompt.
 */
export class PlatformArticleJsonError extends Error {}

export const parseGeneratedPlatformArticleJson = (
  raw: string,
  expectedTarget: PlatformArticleTarget,
): GeneratedPlatformArticle => {
  let parsed: unknown;
  try {
    parsed = parseJsonWithRepairs(raw.trim());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PlatformArticleJsonError(`Platform article LLM response is not valid JSON: ${message}`);
  }

  const result = GeneratedPlatformArticleSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Platform article LLM response does not match expected schema: ${result.error.message}`);
  }
  if (result.data.target !== expectedTarget) {
    throw new Error(
      `Platform article LLM response target "${result.data.target}" does not match requested target "${expectedTarget}".`,
    );
  }
  return result.data;
};

export const generatePlatformArticleContent = async (
  input: GeneratePlatformArticleInput,
): Promise<GeneratePlatformArticleResult> => {
  const sourceText = [input.artifacts.structuredNotesMd, input.articleMd, input.timestampedCuesMd ?? ""].join("\n");
  const sourceTitle = input.artifacts.metadata.title ?? "";
  const discovery = await discoverTechnicalTerms({
    llm: input.llm,
    model: input.model,
    sourceText,
    sourceTitle,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const guard = createTechnicalTermGuard({
    sourceText,
    sourceTitle,
    discoveredTerms: discovery.accepted,
    discovery: technicalTermDiscoveryAuditFor(discovery),
  });
  const prepared = guard.prepare({
    metadata: input.artifacts.metadata,
    articleMd: input.articleMd,
    ...(input.timestampedCuesMd !== undefined ? { timestampedCuesMd: input.timestampedCuesMd } : {}),
  });
  const userPrompt = buildPlatformArticleUserPrompt(prepared.value, { target: input.target });
  const systemPrompt = appendTechnicalTermRuleToSystemPrompt(
    getPlatformArticleSystemPrompt(input.target),
    prepared.promptRule,
  );

  const request = {
    model: input.model,
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ],
    temperature: input.temperature ?? 0.5,
    maxTokens: input.maxTokens ?? 8192,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };

  const t0 = Date.now();
  let resp = await input.llm.chat(request);
  let platformArticle: GeneratedPlatformArticle;
  try {
    platformArticle = parseGeneratedPlatformArticleJson(resp.content, input.target);
  } catch (err: unknown) {
    if (!(err instanceof PlatformArticleJsonError)) throw err;
    // Malformed JSON is a one-off slip (a dropped comma between two fields is the
    // one seen in the wild). Repairs are not safe on article text that gets
    // published verbatim, so ask once more and let a second failure stand.
    resp = await input.llm.chat(request);
    platformArticle = parseGeneratedPlatformArticleJson(resp.content, input.target);
  }

  const finalize = async (
    value: GeneratedPlatformArticle,
  ): Promise<FinalizedTechnicalTermValue<GeneratedPlatformArticle>> => {
    let finalized = guard.finalize(value, prepared.restoration);
    if (hasHardTechnicalTermViolations(finalized.violations)) {
      finalized = await repairTechnicalTermViolations({
        llm: input.llm,
        model: input.model,
        guard,
        currentValue: finalized.value,
        restoration: prepared.restoration,
        violations: finalized.violations,
        parseResponse: (content) => parseGeneratedPlatformArticleJson(content, input.target),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    }
    if (hasHardTechnicalTermViolations(finalized.violations)) {
      throw new Error(`Technical term validation failed: ${finalized.violations.map((item) => item.message).join("; ")}`);
    }
    return finalized;
  };

  // Post-process: fix common LLM CJK homoglyph errors (e.g. 幺→么) in text fields
  try {
    const { fixLlmHomoglyphs } = await import("../acquire/simplify-chinese.js");
    if (platformArticle.target === "xiaohongshu" || platformArticle.target === "wechat") {
      platformArticle.title = fixLlmHomoglyphs(platformArticle.title);
      platformArticle.body = fixLlmHomoglyphs(platformArticle.body);
    }
    if (platformArticle.target === "wechat") {
      platformArticle.summary = fixLlmHomoglyphs(platformArticle.summary);
      platformArticle.lead = fixLlmHomoglyphs(platformArticle.lead);
    }
    if (platformArticle.target === "bilibili") {
      platformArticle.title = fixLlmHomoglyphs(platformArticle.title);
      platformArticle.description = fixLlmHomoglyphs(platformArticle.description);
    }
  } catch {
    // Keep original if import/processing fails
  }
  platformArticle = (await finalize(platformArticle)).value;

  const result: GeneratePlatformArticleResult = {
    platformArticle,
    model: resp.model,
    finishReason: resp.finishReason,
    videoId: input.artifacts.videoId,
    durationMs: Date.now() - t0,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};
