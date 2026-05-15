import {
  ARTICLE_X_SYSTEM_PROMPT,
  buildArticleUserPrompt,
  type LlmPort,
} from "@yt2x/core";
import type { StructuredNotesArtifacts } from "./file-store.js";

export type GenerateXArticleInput = {
  llm: LlmPort;
  model: string;
  temperature?: number;
  maxTokens?: number;
  artifacts: StructuredNotesArtifacts;
  signal?: AbortSignal;
};

export type GenerateXArticleResult = {
  content: string;
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  videoId: string;
  durationMs: number;
};

const FENCE_RE = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/;
const stripCodeFenceWrapper = (s: string): string => {
  const m = s.match(FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};

/**
 * 调用 LLM 生成 X 长文 `article.md` 正文（不落盘）。
 */
export const generateXArticleContent = async (
  input: GenerateXArticleInput,
): Promise<GenerateXArticleResult> => {
  const userPrompt = buildArticleUserPrompt(
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
      { role: "system", content: ARTICLE_X_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: input.temperature ?? 0.55,
    maxTokens: input.maxTokens ?? 16384,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const content = stripCodeFenceWrapper(resp.content.trim());
  const result: GenerateXArticleResult = {
    content,
    model: resp.model,
    finishReason: resp.finishReason,
    videoId: input.artifacts.videoId,
    durationMs: Date.now() - t0,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};
