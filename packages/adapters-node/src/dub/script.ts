import {
  buildDubRewriteRepairPrompt,
  buildDubRewriteUserPrompt,
  getDubRewriteSystemPrompt,
  type DubScript,
  type DubScriptLine,
  type DubSegment,
  type LlmPort,
} from "@yt2x/core";
import { parseJsonWithRepairs, salvagePartialJsonArray } from "../llm/parse-json.js";

/**
 * 配音稿生成：合并句 → LLM 朗读化改写 → DubScript。
 *
 * 和 notes/generator.ts 一样，业务编排与 FS 持久化分离——这里只返回结果，落盘由
 * file-store 决定。单测因此可以纯 mock LlmPort，不碰文件系统。
 */

/** 一批 20 句。太大 LLM 容易漏行，太小是白烧 system prompt 的 token。 */
const BATCH_SIZE = 20;

type RewrittenLine = { index: number; text: string };

export type GenerateDubScriptInput = {
  llm: LlmPort;
  model: string;
  videoId: string;
  /** 写进 DubScript 的字幕来源相对路径，如 "video/full.zh.srt"。 */
  sourceSubtitle: string;
  segments: readonly DubSegment[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type GenerateDubScriptResult = {
  script: DubScript;
  warnings: string[];
  /** LLM 成功改写的行数。 */
  rewrittenCount: number;
  /** 改写失败、退回合并原文的行数。 */
  fallbackCount: number;
};

const parseRewriteResponse = (content: string): RewrittenLine[] => {
  let parsed: unknown;
  try {
    parsed = parseJsonWithRepairs(content);
  } catch {
    parsed = null;
  }
  // parseJsonWithRepairs 可能从截断的数组里抠出单个对象，不是数组就一律回退到
  // salvage，尽量多捞几条完整的
  if (!Array.isArray(parsed)) parsed = salvagePartialJsonArray(content);
  if (!Array.isArray(parsed)) return [];

  const lines: RewrittenLine[] = [];
  for (const item of parsed) {
    const obj = item as Record<string, unknown>;
    if (typeof obj.index === "number" && typeof obj.text === "string") {
      const text = obj.text.trim();
      // 空串当成没返回，交给补齐阶段——写进配音稿会变成一段静音
      if (text.length > 0) lines.push({ index: obj.index, text });
    }
  }
  return lines;
};

const rewriteBatch = async (
  batch: readonly DubSegment[],
  input: GenerateDubScriptInput,
  repairMode: boolean,
): Promise<RewrittenLine[]> => {
  const systemPrompt = repairMode
    ? buildDubRewriteRepairPrompt(batch.map((s) => s.index))
    : getDubRewriteSystemPrompt();

  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildDubRewriteUserPrompt(batch) },
    ],
    temperature: input.temperature ?? 0.3,
    maxTokens: input.maxTokens ?? 8192,
    jsonMode: true,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const known = new Set(batch.map((s) => s.index));
  // LLM 偶尔会自己编 index，编出来的行没有对应原文，留着只会污染后面的补齐判断
  return parseRewriteResponse(resp.content.trim()).filter((line) => known.has(line.index));
};

export const generateDubScript = async (
  input: GenerateDubScriptInput,
): Promise<GenerateDubScriptResult> => {
  const warnings: string[] = [];
  const rewritten = new Map<number, string>();

  for (let i = 0; i < input.segments.length; i += BATCH_SIZE) {
    const batch = input.segments.slice(i, i + BATCH_SIZE);
    try {
      for (const line of await rewriteBatch(batch, input, false)) {
        rewritten.set(line.index, line.text);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(
        `rewrite batch ${batch[0]!.index}-${batch[batch.length - 1]!.index} failed: ${message}`,
      );
    }
  }

  // 补齐一：把所有缺行凑成一批，用写死 index 的 repair prompt 再要一次
  const missingAfterBatches = input.segments.filter((s) => !rewritten.has(s.index));
  if (missingAfterBatches.length > 0) {
    try {
      const before = rewritten.size;
      for (const line of await rewriteBatch(missingAfterBatches, input, true)) {
        rewritten.set(line.index, line.text);
      }
      warnings.push(
        `repaired ${rewritten.size - before}/${missingAfterBatches.length} missing lines`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`repair pass failed: ${message}`);
    }
  }

  // 补齐二：还缺的逐句单独要。到这一步剩下的通常是个别难句，一次一条最省事
  for (const segment of input.segments.filter((s) => !rewritten.has(s.index))) {
    try {
      for (const line of await rewriteBatch([segment], input, true)) {
        rewritten.set(line.index, line.text);
      }
    } catch {
      // 下面的兜底会用原文，这里不必额外告警
    }
  }

  /*
   * 最后兜底用合并原文。
   *
   * 改写只是"更好听"，原文本身已经是通顺的中文译文，照读也能听懂；相比之下让整个
   * 命令失败会丢掉其余几百句的真实时长数据，而那正是 PR1 唯一的目的。
   */
  let fallbackCount = 0;
  const lines: DubScriptLine[] = input.segments.map((segment) => {
    const text = rewritten.get(segment.index);
    if (text === undefined) fallbackCount += 1;
    return {
      index: segment.index,
      startMs: segment.startMs,
      endMs: segment.endMs,
      targetDurationMs: Math.max(0, segment.endMs - segment.startMs),
      text: text ?? segment.text,
      sourceText: segment.text,
      cueIndices: segment.cueIndices,
    };
  });
  if (fallbackCount > 0) {
    warnings.push(`${fallbackCount}/${input.segments.length} lines fell back to the merged source text`);
  }

  return {
    script: {
      version: 1,
      videoId: input.videoId,
      sourceSubtitle: input.sourceSubtitle,
      rewriteModel: input.model,
      lines,
    },
    warnings,
    rewrittenCount: input.segments.length - fallbackCount,
    fallbackCount,
  };
};
