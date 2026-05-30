import { z } from "zod";
import {
  buildVideoShortUserPrompt,
  VIDEO_SHORT_X_SYSTEM_PROMPT,
  type GeneratedVideoShortPost,
  type LlmPort,
} from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";

export type GenerateXVideoShortInput = {
  llm: LlmPort;
  model: string;
  temperature?: number;
  maxTokens?: number;
  artifacts: StructuredNotesArtifacts;
  availableVisuals?: unknown;
  signal?: AbortSignal;
};

export type GenerateXVideoShortResult = {
  videoShortPost: GeneratedVideoShortPost;
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  videoId: string;
  durationMs: number;
};

const GeneratedVideoShortPostSchema = z.object({
  text: z.string().min(1),
});

const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const stripJsonFenceWrapper = (s: string): string => {
  const m = s.match(JSON_FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};

/**
 * 修复 LLM 输出的 JSON 中 text 字段内未转义的控制字符。
 * LLM 有时会在 JSON 字符串值中直接插入真实换行，导致 JSON.parse 失败。
 */
const repairTextControlChars = (s: string): string => {
  // 匹配 JSON 字符串值内的控制字符并转义
  // 策略：找到所有 JSON string literal（"..."），对其内部的控制字符进行转义
  return s.replace(/"((?:[^"\\]|\\.)*)"/g, (_match, content: string) => {
    // eslint-disable-next-line no-control-regex
    const escaped = content.replace(/[\x00-\x1F]/g, (ch) => {
      switch (ch) {
        case "\n": return "\\n";
        case "\r": return "\\r";
        case "\t": return "\\t";
        default: return " ";
      }
    });
    return `"${escaped}"`;
  });
};

export const parseGeneratedVideoShortPostJson = (jsonText: string): GeneratedVideoShortPost => {
  let parsed: unknown;
  const raw = stripJsonFenceWrapper(jsonText.trim());
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 如果首次解析失败，尝试修复字符串内的控制字符后重试
    try {
      parsed = JSON.parse(repairTextControlChars(raw));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Video short LLM response is not valid JSON: ${message}`);
    }
  }

  const result = GeneratedVideoShortPostSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Video short LLM response does not match expected schema: ${result.error.message}`);
  }
  return { text: result.data.text };
};

export const generateXVideoShortContent = async (
  input: GenerateXVideoShortInput,
): Promise<GenerateXVideoShortResult> => {
  const userPrompt = buildVideoShortUserPrompt(
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
      { role: "system", content: VIDEO_SHORT_X_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: input.temperature ?? 0.6,
    maxTokens: input.maxTokens ?? 256,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const videoShortPost = parseGeneratedVideoShortPostJson(resp.content);

  const result: GenerateXVideoShortResult = {
    videoShortPost,
    model: resp.model,
    finishReason: resp.finishReason,
    videoId: input.artifacts.videoId,
    durationMs: Date.now() - t0,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};
