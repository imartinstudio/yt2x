import { z } from "zod";
import {
  buildThreadUserPrompt,
  THREAD_X_SYSTEM_PROMPT,
  type AvailableVisual,
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
  availableVisuals?: AvailableVisual[] | null;
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

const ThreadVisualSchema = z.object({
  tweet_index: z.number().int().min(0).max(9),
  visual_id: z.string().min(1),
  caption: z.string().min(1),
});

const GeneratedThreadSchema = z.object({
  title: z.string().min(1),
  planning: ThreadPlanningSchema,
  tweets: z.array(TweetSchema).min(6).max(10),
  hooks: z.array(ThreadHookSchema).min(3).max(8),
  visuals: z.array(ThreadVisualSchema).max(3).optional(),
});

const MARKDOWN_TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const MARKDOWN_TABLE_ROW_RE = /^\s*\|.+\|\s*$/;
const TEMPLATE_TWEET_LABELS = new Set([
  "核心公式",
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
]);

const TEMPLATE_TWEET_LABEL_RE = /^\s*(?:\*\*)?([^：:\n]{2,24})([：:])(?:\*\*)?\s*/u;

const stripTemplateTweetLabel = (tweet: string): string => {
  const text = tweet.trim();
  const match = text.match(TEMPLATE_TWEET_LABEL_RE);
  const label = match?.[1]?.trim();
  if (match === null || label === undefined || !TEMPLATE_TWEET_LABELS.has(label)) return text;
  return text.slice(match[0].length).trim();
};

const hasMarkdownTable = (text: string): boolean =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => MARKDOWN_TABLE_DIVIDER_RE.test(line) || MARKDOWN_TABLE_ROW_RE.test(line));

const assertNoMarkdownTables = (tweets: string[]): void => {
  const index = tweets.findIndex((tweet) => hasMarkdownTable(tweet));
  if (index >= 0) {
    throw new Error(
      `Thread LLM response contains a markdown table in tweets[${index}]. Regenerate x-thread content as numbered lists, bullet lists, or field/value lines instead of tables.`,
    );
  }
};

const normalizeThread = (
  raw: z.infer<typeof GeneratedThreadSchema>,
): GeneratedThread => {
  assertNoMarkdownTables(raw.tweets);
  const thread: GeneratedThread = {
    title: raw.title,
    planning: raw.planning,
    tweets: raw.tweets.map((tweet) => stripTemplateTweetLabel(tweet)),
    hooks: raw.hooks,
  };
  if (raw.visuals !== undefined && raw.visuals.length > 0) {
    thread.visuals = raw.visuals;
  }
  return thread;
};

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
      availableVisuals: input.availableVisuals ?? null,
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

  // 验证 visuals 只引用 available_visuals 中存在的截图
  if (thread.visuals !== undefined && thread.visuals.length > 0) {
    const availVisuals = input.availableVisuals ?? [];
    const validIds = new Set(availVisuals.map((v) => v.visual_id));
    // 过滤掉无效引用（LLM 幻觉常见），保留有效配图
    const validVisuals = thread.visuals.filter((v) => {
      if (!validIds.has(v.visual_id)) return false;
      if (v.tweet_index < 0 || v.tweet_index >= thread.tweets.length) return false;
      return true;
    });
    if (validVisuals.length > 0) {
      thread.visuals = validVisuals;
    } else {
      delete thread.visuals;
    }
  }

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
