import {
  buildDubTranslateRepairPrompt,
  buildDubTranslateTightenPrompt,
  buildDubTranslateUserPrompt,
  DEFAULT_SPEECH_RATE,
  dubTranslateCharBudget,
  getDubTranslateSystemPrompt,
  type LlmPort,
  type SpeechRateModel,
  type Utterance,
} from "@yt2x/core";
import { parseJsonWithRepairs, salvagePartialJsonArray } from "../llm/parse-json.js";

/**
 * 长度受限翻译：英文话语单元 → 能在其时长内说完的中文。
 *
 * 与 script.ts 的朗读化改写并存，不替换它——切换链路是后续 PR 的事，两条路径共存
 * 期间可以在同一素材上对比译文质量与时长达标率。
 */

const BATCH_SIZE = 20;

export type DubTranslatedLine = {
  index: number;
  text: string;
  /** 英文原文，供事后核对信息保留率。 */
  sourceText: string;
  /** 该单元可用时长，供事后核对时长达标率。 */
  availableMs: number;
};

export type TranslateUtterancesInput = {
  llm: LlmPort;
  model: string;
  utterances: readonly Utterance[];
  /** 中文 TTS 时长模型；换音色后应重新校准再传入。 */
  rate?: SpeechRateModel;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onBatchDone?: (done: number, total: number) => void;
};

export type TranslateUtterancesResult = {
  lines: DubTranslatedLine[];
  warnings: string[];
};

type ParsedLine = { index: number; text: string };

const parseResponse = (content: string): ParsedLine[] => {
  let parsed: unknown;
  try {
    parsed = parseJsonWithRepairs(content);
  } catch {
    parsed = salvagePartialJsonArray(content);
  }
  if (!Array.isArray(parsed)) parsed = salvagePartialJsonArray(content);
  if (!Array.isArray(parsed)) return [];

  const lines: ParsedLine[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.index === "number" && typeof obj.text === "string") {
      const text = obj.text.trim();
      // 空串当成没返回，交给补齐阶段——写进配音稿会变成一段静音
      if (text.length > 0) lines.push({ index: obj.index, text });
    }
  }
  return lines;
};

const translateBatch = async (
  batch: readonly Utterance[],
  input: TranslateUtterancesInput,
  repairMode: boolean,
): Promise<ParsedLine[]> => {
  const rate = input.rate ?? DEFAULT_SPEECH_RATE;
  const systemPrompt = repairMode
    ? buildDubTranslateRepairPrompt(batch.map((u) => u.index))
    : getDubTranslateSystemPrompt();

  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildDubTranslateUserPrompt(batch, rate) },
    ],
    temperature: input.temperature ?? 0.3,
    maxTokens: input.maxTokens ?? 8192,
    jsonMode: true,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const known = new Set(batch.map((u) => u.index));
  // LLM 偶尔自己编 index，编出来的行没有对应原文，留着只会污染补齐判断
  return parseResponse(resp.content.trim()).filter((l) => known.has(l.index));
};

export const translateUtterances = async (
  input: TranslateUtterancesInput,
): Promise<TranslateUtterancesResult> => {
  const warnings: string[] = [];
  const translated = new Map<number, string>();
  const total = input.utterances.length;
  if (total === 0) return { lines: [], warnings };

  let done = 0;
  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = input.utterances.slice(i, i + BATCH_SIZE);
    try {
      for (const line of await translateBatch(batch, input, false)) {
        translated.set(line.index, line.text);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(
        `translate batch ${batch[0]!.index}-${batch[batch.length - 1]!.index} failed: ${message}`,
      );
    }
    done += batch.length;
    input.onBatchDone?.(done, total);
  }

  // 补齐：把所有缺行凑成一批，用写死 index 的 repair prompt 再要一次
  const missing = input.utterances.filter((u) => !translated.has(u.index));
  if (missing.length > 0) {
    try {
      const before = translated.size;
      for (const line of await translateBatch(missing, input, true)) {
        translated.set(line.index, line.text);
      }
      warnings.push(`repaired ${translated.size - before}/${missing.length} missing lines`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`repair pass failed: ${message}`);
    }
  }

  // 仍然缺的行如实报出来，不编造译文——一段静音比一句假话好排查
  const stillMissing = input.utterances.filter((u) => !translated.has(u.index));
  if (stillMissing.length > 0) {
    warnings.push(`no translation for index ${stillMissing.map((u) => u.index).join(", ")}`);
  }

  // 收紧：超预算的行拿英文原文重译一版，而不是把已有译文砍短
  const rate = input.rate ?? DEFAULT_SPEECH_RATE;
  const budgetOf = (u: Utterance): number => dubTranslateCharBudget(u.endMs - u.startMs, rate);
  const overBudget = input.utterances.filter((u) => {
    const text = translated.get(u.index);
    return text !== undefined && text.length > budgetOf(u);
  });

  if (overBudget.length > 0) {
    try {
      const resp = await input.llm.chat({
        model: input.model,
        messages: [
          {
            role: "system",
            content: buildDubTranslateTightenPrompt(
              overBudget.map((u) => ({
                index: u.index,
                actualChars: translated.get(u.index)!.length,
                maxChars: budgetOf(u),
              })),
            ),
          },
          { role: "user", content: buildDubTranslateUserPrompt(overBudget, rate) },
        ],
        temperature: input.temperature ?? 0.3,
        maxTokens: input.maxTokens ?? 8192,
        jsonMode: true,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      const known = new Set(overBudget.map((u) => u.index));
      let tightened = 0;
      for (const line of parseResponse(resp.content.trim())) {
        if (!known.has(line.index)) continue;
        // 只在真的更短时替换：重译偶尔会更长，那一版没有价值
        if (line.text.length < translated.get(line.index)!.length) {
          translated.set(line.index, line.text);
          tightened += 1;
        }
      }
      warnings.push(`tightened ${tightened}/${overBudget.length} over-budget lines`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`tighten pass failed: ${message}`);
    }
  }

  const lines: DubTranslatedLine[] = input.utterances
    .filter((u) => translated.has(u.index))
    .map((u) => ({
      index: u.index,
      text: translated.get(u.index)!,
      sourceText: u.text,
      availableMs: u.endMs - u.startMs,
    }));

  return { lines, warnings };
};
