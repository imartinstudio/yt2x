import { z } from "zod";
import {
  buildThreadUserPrompt,
  THREAD_X_SYSTEM_PROMPT,
  type GeneratedThread,
  type LlmPort,
} from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";

export type GenerateXThreadInput = {
  llm: LlmPort;
  model: string;
  temperature?: number;
  maxTokens?: number;
  artifacts: StructuredNotesArtifacts;
  signal?: AbortSignal;
};

export type GenerateXThreadResult = {
  thread: GeneratedThread;
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  videoId: string;
  durationMs: number;
};

const ThreadHookSchema = z.object({
  text: z.string().min(1),
  angle: z.string().min(1),
  risk: z.enum(["low", "medium", "high"]),
});

const ThreadPlanningSchema = z.object({
  core_thesis: z.string().min(1),
  conflict: z.string().min(1),
  key_points: z.array(z.string().min(1)).min(4).max(6),
  reader_gain: z.string().min(1),
  final_post: z.string().min(1),
});

const TweetSchema = z.string().min(1);

const GeneratedThreadSchema = z.object({
  title: z.string().min(1),
  planning: ThreadPlanningSchema,
  tweets: z.array(TweetSchema).min(6).max(15),
  hooks: z.array(ThreadHookSchema).min(3).max(8),
});

const TWEET_LABEL_RE = /^[^：:\n]{2,24}[：:]\s*\S/u;
const FALLBACK_LABELS = [
  "核心判断",
  "主要误区",
  "关键方法",
  "配置重点",
  "验证路径",
  "进阶技巧",
  "读者收益",
  "开放问题",
  "风险提醒",
  "维护方式",
  "排障方法",
  "最终结论",
  "行动建议",
  "系统思维",
  "讨论入口",
] as const;

const ensureTweetLabel = (tweet: string, index: number): string => {
  const text = tweet.trim();
  if (TWEET_LABEL_RE.test(text)) return text;
  const label = FALLBACK_LABELS[index] ?? `要点${index + 1}`;
  return `${label}：${text}`;
};

const normalizeThread = (thread: GeneratedThread): GeneratedThread => ({
  ...thread,
  tweets: thread.tweets.map((tweet, index) => ensureTweetLabel(tweet, index)),
});

const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const stripJsonFenceWrapper = (s: string): string => {
  const m = s.match(JSON_FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};

export const parseGeneratedThreadJson = (raw: string): GeneratedThread => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFenceWrapper(raw.trim()));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Thread LLM response is not valid JSON: ${message}`);
  }

  const result = GeneratedThreadSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Thread LLM response does not match expected schema: ${result.error.message}`);
  }
  return normalizeThread(result.data);
};

export const generateXThreadContent = async (
  input: GenerateXThreadInput,
): Promise<GenerateXThreadResult> => {
  const userPrompt = buildThreadUserPrompt(
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
      { role: "system", content: THREAD_X_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: input.temperature ?? 0.55,
    maxTokens: input.maxTokens ?? 8192,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const thread = parseGeneratedThreadJson(resp.content);
  const result: GenerateXThreadResult = {
    thread,
    model: resp.model,
    finishReason: resp.finishReason,
    videoId: input.artifacts.videoId,
    durationMs: Date.now() - t0,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};
