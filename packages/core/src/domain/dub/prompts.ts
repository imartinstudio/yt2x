import type { DubSegment } from "./types.js";

/**
 * 朗读化改写 prompt。
 *
 * 输入是**已经翻译好**的中文字幕合并句，这一步只把"能看懂的书面中文"改成
 * "能听懂的口语中文"——不重新翻译、不增删信息点。重新翻译会让本阶段变成第二个
 * 翻译源，和 full.zh.srt 产生分叉，后面反向生成字幕时对不上。
 */

/**
 * 单句改写后的字符预算。
 *
 * 混合对齐策略的最后一道兜底是"LLM 改短"，所以改写阶段本身绝不能把句子改长：
 * 一旦超出原句太多，调速就要吃掉全部余量，语速会失真。留 10% + 2 字的松弛，
 * 是因为口语化经常要补主语（"它" / "我们"），一个字不给会逼 LLM 违反规则。
 */
export const dubRewriteCharBudget = (sourceText: string): number =>
  Math.ceil(sourceText.trim().length * 1.1) + 2;

export const DUB_REWRITE_RULES: readonly string[] = [
  "1. Rewrite for the EAR only. Do NOT re-translate, do NOT add or drop any information point. Every fact, number, and name in the source must survive.",
  "2. Proper nouns, brand names, product names, shell commands, API names, and code identifiers stay EXACTLY as written. Never translate or transliterate them.",
  '3. Convert percentages, multipliers, and units into spoken Chinese ("30%" -> "百分之三十", "2x" -> "两倍", "10GB" -> "十个 G"). Version numbers and model names (GPT-4, Claude 3.5, o3) stay verbatim.',
  '4. Delete parentheticals and reader-facing asides — "（如图）", "（见下文）", "如下表所示" have no meaning when heard.',
  '5. Replace written connectives with spoken ones ("因此" -> "所以", "此外" -> "另外"). Add an explicit subject when the sentence cannot stand on its own by ear.',
  '6. The rewrite MUST NOT be noticeably longer than the source. Never exceed the item\'s "maxChars". Shorter is always acceptable.',
  '7. Return ONLY a JSON array of objects with "index" (number) and "text" (string). One object per input index, same indices, same order. No commentary, no code fences.',
  "8. The output MUST be Simplified Chinese (zh-CN). Traditional Chinese is forbidden.",
];

export const getDubRewriteSystemPrompt = (): string =>
  [
    "You are a Chinese dubbing script editor. You receive Simplified Chinese subtitle sentences and rewrite each one so a text-to-speech voice can read it aloud naturally.",
    "",
    "Rules:",
    ...DUB_REWRITE_RULES,
  ].join("\n");

/** LLM 漏行时的补齐 prompt，索引写死在指令里，逼它一条不落地返回。 */
export const buildDubRewriteRepairPrompt = (missingIndices: readonly number[]): string =>
  [
    `You are a Chinese dubbing script editor. Rewrite these ${missingIndices.length} sentences for spoken delivery.`,
    `CRITICAL: return EXACTLY one object per index, no more, no less. The indices are: ${missingIndices.join(", ")}.`,
    "",
    "Rules:",
    ...DUB_REWRITE_RULES,
  ].join("\n");

export type DubRewritePromptItem = {
  index: number;
  text: string;
  maxChars: number;
};

/** 送进 LLM 的最小载荷：时间戳对改写没用，只会烧 token。 */
export const buildDubRewritePayload = (
  segments: readonly DubSegment[],
): DubRewritePromptItem[] =>
  segments.map((segment) => ({
    index: segment.index,
    text: segment.text,
    maxChars: dubRewriteCharBudget(segment.text),
  }));

export const buildDubRewriteUserPrompt = (segments: readonly DubSegment[]): string =>
  JSON.stringify(buildDubRewritePayload(segments));
