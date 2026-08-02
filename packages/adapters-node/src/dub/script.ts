import type {
  DubScript,
  DubScriptLine,
  LlmPort,
  SpeechRateModel,
  Utterance,
} from "@yt2x/core";
import { translateUtterances } from "./translate.js";

/**
 * 配音稿生成：话语单元 → 长度受限翻译 → DubScript。
 *
 * 只是 translateUtterances（批量/补齐/收紧都在那边实现并测试过）的组装层：把
 * 话语单元的时间戳和英文原文，与译出的中文行拼回 DubScript 的形状。业务编排与
 * FS 持久化分离——这里只返回结果，落盘由 file-store 决定。
 *
 * 取代了旧的「合并字幕行 → LLM 朗读化改写」路径（DubSegment / core/dub/prompts.ts）：
 * 新链路直接从话语单元的英文原文翻译，不再有中文合并句这一步，见 docs/DUB-TASK.md。
 */

export type GenerateDubScriptInput = {
  llm: LlmPort;
  model: string;
  videoId: string;
  /** 写进 DubScript 的词级时间戳文件相对路径，如 "video/full.local.en.words.json"。 */
  sourceWords: string;
  utterances: readonly Utterance[];
  /** 中文 TTS 时长模型；换音色后应重新校准再传入。 */
  rate?: SpeechRateModel;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onBatchDone?: (done: number, total: number) => void;
};

export type GenerateDubScriptResult = {
  script: DubScript;
  warnings: string[];
  /** 成功译出并进入配音稿的话语单元数。 */
  translatedCount: number;
  /**
   * 没有可用译文、因而未进入配音稿的话语单元数。
   *
   * 与旧路径不同：旧路径改写失败时退回合并原文（本身已经是中文），仍能凑出一行；
   * 这里源文本是英文，拿英文喂中文 TTS 只会念出乱码，因此没有安全的兜底文本——
   * 缺译文的话语单元直接跳过，不写入 script.lines，warnings 里如实记录。
   */
  droppedCount: number;
};

export const generateDubScript = async (
  input: GenerateDubScriptInput,
): Promise<GenerateDubScriptResult> => {
  const { lines: translated, warnings } = await translateUtterances({
    llm: input.llm,
    model: input.model,
    utterances: input.utterances,
    ...(input.rate !== undefined ? { rate: input.rate } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.onBatchDone !== undefined ? { onBatchDone: input.onBatchDone } : {}),
  });

  const byIndex = new Map(translated.map((line) => [line.index, line]));
  const lines: DubScriptLine[] = [];
  let droppedCount = 0;

  for (const utterance of input.utterances) {
    const line = byIndex.get(utterance.index);
    if (line === undefined) {
      droppedCount += 1;
      continue;
    }
    lines.push({
      index: utterance.index,
      startMs: utterance.startMs,
      endMs: utterance.endMs,
      targetDurationMs: Math.max(0, utterance.endMs - utterance.startMs),
      text: line.text,
      sourceText: utterance.text,
      cueIndices: [utterance.index],
    });
  }

  if (droppedCount > 0) {
    warnings.push(
      `${droppedCount}/${input.utterances.length} utterances have no usable translation and were dropped`,
    );
  }

  return {
    script: {
      version: 2,
      videoId: input.videoId,
      sourceWords: input.sourceWords,
      rewriteModel: input.model,
      lines,
      droppedCount,
    },
    warnings,
    translatedCount: lines.length,
    droppedCount,
  };
};
