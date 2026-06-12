import { z } from "zod";
import {
  buildPlatformArticleUserPrompt,
  getPlatformArticleSystemPrompt,
  type LlmPort,
  type PlatformArticleTarget,
} from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";

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
  titles: z.array(z.string().min(1)).min(1).max(8),
  body: z.string().min(1),
  tags: z.array(z.string().min(1)).min(3).max(8),
  cover: CoverSchema,
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

const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const stripJsonFenceWrapper = (s: string): string => {
  const m = s.match(JSON_FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};

export const parseGeneratedPlatformArticleJson = (
  raw: string,
  expectedTarget: PlatformArticleTarget,
): GeneratedPlatformArticle => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFenceWrapper(raw.trim()));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Platform article LLM response is not valid JSON: ${message}`);
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
  const userPrompt = buildPlatformArticleUserPrompt(
    {
      metadata: input.artifacts.metadata,
      articleMd: input.articleMd,
      ...(input.timestampedCuesMd !== undefined ? { timestampedCuesMd: input.timestampedCuesMd } : {}),
    },
    { target: input.target },
  );

  const t0 = Date.now();
  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: getPlatformArticleSystemPrompt(input.target) },
      { role: "user", content: userPrompt },
    ],
    temperature: input.temperature ?? 0.5,
    maxTokens: input.maxTokens ?? 8192,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const platformArticle = parseGeneratedPlatformArticleJson(resp.content, input.target);
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
