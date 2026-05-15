import {
  getNotesSystemPrompt,
  buildNotesUserPrompt,
  type LlmPort,
} from "@yt2x/core";
import type { VideoDirArtifacts } from "./file-store.js";

export type GenerateNotesInput = {
  llm: LlmPort;
  model: string;
  /** 默认 0.3（与旧 pipeline 一致） */
  temperature?: number;
  /** 默认 16384，覆盖一般长视频笔记 */
  maxTokens?: number;
  artifacts: VideoDirArtifacts;
  outputLanguage?: "zh" | "en";
  signal?: AbortSignal;
};

export type GenerateNotesResult = {
  content: string;
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  videoId: string;
  durationMs: number;
};

/**
 * 调 LLM 生成 structured-notes.md 内容（**不**落盘——调用方决定写哪、是否覆盖）。
 *
 * 把"业务编排"和"FS 持久化"分开是有意的：
 *  - 单测可以用 mock LlmPort 验证 prompt 构造，不碰文件系统
 *  - 后续 v0.2 extension 可以复用此函数，把笔记写到 IndexedDB 而不是磁盘
 */
export const generateNotesContent = async (
  input: GenerateNotesInput,
): Promise<GenerateNotesResult> => {
  const promptOpts = { outputLanguage: input.outputLanguage ?? "zh" as const };
  const userPrompt = buildNotesUserPrompt({
    metadata: input.artifacts.metadata,
    chunksMd: input.artifacts.chunksMd,
    timestampedCuesMd: input.artifacts.timestampedCuesMd,
    screenshots: input.artifacts.screenshots ?? null,
  }, promptOpts);

  const t0 = Date.now();
  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: getNotesSystemPrompt(promptOpts) },
      { role: "user", content: userPrompt },
    ],
    temperature: input.temperature ?? 0.3,
    maxTokens: input.maxTokens ?? 16384,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  // LLM 偶尔会在末尾给出 ```markdown ... ``` 包裹，去掉它
  const content = stripCodeFenceWrapper(resp.content.trim());

  const result: GenerateNotesResult = {
    content,
    model: resp.model,
    finishReason: resp.finishReason,
    videoId: input.artifacts.videoId,
    durationMs: Date.now() - t0,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};

const FENCE_RE = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/;
const stripCodeFenceWrapper = (s: string): string => {
  const m = s.match(FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};
