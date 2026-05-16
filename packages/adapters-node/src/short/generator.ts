import { z } from "zod";
import {
  buildShortUserPrompt,
  SHORT_X_SYSTEM_PROMPT,
  type AvailableVisual,
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
  availableVisuals?: AvailableVisual[] | null;
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

const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const stripJsonFenceWrapper = (s: string): string => {
  const m = s.match(JSON_FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};

export const parseGeneratedShortPostJson = (jsonText: string): GeneratedShortPost => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFenceWrapper(jsonText.trim()));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Short post LLM response is not valid JSON: ${message}`);
  }

  const result = GeneratedShortPostSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Short post LLM response does not match expected schema: ${result.error.message}`);
  }
  const raw = result.data;
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
  const userPrompt = buildShortUserPrompt(
    {
      metadata: input.artifacts.metadata,
      structuredNotesMd: input.artifacts.structuredNotesMd,
      availableVisuals: input.availableVisuals ?? null,
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

  // 验证 visual 只引用 available_visuals 中存在的截图
  if (shortPost.visual !== undefined) {
    const availVisuals = input.availableVisuals ?? [];
    const validIds = new Set(availVisuals.map((v) => v.visual_id));
    if (!validIds.has(shortPost.visual.visual_id)) {
      // 静默去除无效 visual 引用（LLM 幻觉常见，不中断流程）
      delete shortPost.visual;
    }
  }

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
