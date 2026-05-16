import { z } from "zod";
import {
  buildShortUserPrompt,
  SHORT_X_SYSTEM_PROMPT,
  type GeneratedShortPost,
  type LlmPort,
} from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";

export type GenerateXShortInput = {
  llm: LlmPort;
  model: string;
  temperature?: number;
  maxTokens?: number;
  artifacts: StructuredNotesArtifacts;
  signal?: AbortSignal;
};

export type GenerateXShortResult = {
  shortPost: GeneratedShortPost;
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  videoId: string;
  durationMs: number;
};

const GeneratedShortPostSchema = z.object({
  text: z.string().min(1),
  angle: z.enum(["contrarian", "practical", "trend", "technical", "discussion"]),
  risk: z.enum(["low", "medium", "high"]),
});

const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const stripJsonFenceWrapper = (s: string): string => {
  const m = s.match(JSON_FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};

export const parseGeneratedShortPostJson = (raw: string): GeneratedShortPost => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFenceWrapper(raw.trim()));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Short post LLM response is not valid JSON: ${message}`);
  }

  const result = GeneratedShortPostSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Short post LLM response does not match expected schema: ${result.error.message}`);
  }
  return result.data;
};

export const generateXShortContent = async (
  input: GenerateXShortInput,
): Promise<GenerateXShortResult> => {
  const userPrompt = buildShortUserPrompt(
    {
      metadata: input.artifacts.metadata,
      structuredNotesMd: input.artifacts.structuredNotesMd,
    },
    { platform: "x" },
  );

  const t0 = Date.now();
  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: SHORT_X_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: input.temperature ?? 0.55,
    maxTokens: input.maxTokens ?? 2048,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const shortPost = parseGeneratedShortPostJson(resp.content);
  const result: GenerateXShortResult = {
    shortPost,
    model: resp.model,
    finishReason: resp.finishReason,
    videoId: input.artifacts.videoId,
    durationMs: Date.now() - t0,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};
