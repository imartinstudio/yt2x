import { z } from "zod";
import {
  buildVideoShortUserPrompt,
  VIDEO_SHORT_X_SYSTEM_PROMPT,
  type GeneratedVideoShortPost,
  type LlmPort,
} from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";
import { parseJsonWithRepairs, salvageLooseJsonTextField, stripJsonFenceWrapper } from "../llm/parse-json.js";

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
      throw new Error(`Video short LLM response is not valid JSON: ${message}`);
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
  temperature: number,
  maxTokens: number,
): Promise<{ content: string; model: string; finishReason: string; usage?: GenerateXVideoShortResult["usage"] }> => {
  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: VIDEO_SHORT_X_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature,
    maxTokens,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  return resp;
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
  const maxTokens = input.maxTokens ?? 768;
  const temperature = input.temperature ?? 0.6;

  let resp = await chatVideoShort(input, userPrompt, temperature, maxTokens);
  let videoShortPost: GeneratedVideoShortPost;
  try {
    videoShortPost = parseGeneratedVideoShortPostJson(resp.content);
  } catch {
    const repairResp = await input.llm.chat({
      model: input.model,
      messages: [
        { role: "system", content: VIDEO_SHORT_X_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
        { role: "assistant", content: resp.content },
        { role: "user", content: JSON_REPAIR_USER_PROMPT },
      ],
      temperature: 0.2,
      maxTokens,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    resp = repairResp;
    videoShortPost = parseGeneratedVideoShortPostJson(repairResp.content);
  }

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
