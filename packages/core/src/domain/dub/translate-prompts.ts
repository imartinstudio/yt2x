import { PROTECTED_GLOSSARY_TERMS, PROTECTED_NAMES } from "./glossary.js";
import type { Utterance } from "./types.js";

/**
 * 长度受限翻译 prompt。
 *
 * 输入是**英文原文**的话语单元和它可用的时长，直接产出能在该时长内说完的中文。
 *
 * 与 prompts.ts 的朗读化改写是两种做法，区别很关键：改写拿到的是一句已经凝练的
 * 中文、被要求砍短，除了删信息没有别的办法（实测因此丢掉 44% 信息点）；本 prompt
 * 让模型从英文出发、带着预算生成，挤掉的是英文口语固有的冗余——填充词、同义反复、
 * 换个说法再说一遍——实质内容基本不动。
 *
 * 同一个"牺牲译文"的取舍，做在翻译阶段和做在事后压缩阶段，质量差一个数量级。
 */

/**
 * 中文 TTS 时长模型：`时长 ≈ 固定开销 + 每字成本 × 字数`。
 *
 * 刻意不用单一的"每字毫秒"常数——实测每字成本从 131ms（61 字长句）到 387ms
 * （7 字短句）相差近三倍，短句每字更贵。用常数拟合，两头都不准：20 条真实样本上
 * 单常数的平均误差 1096ms，线性模型 539ms，减半。
 *
 * 固定开销来自起音与句末拖长，不是首尾静音——按纯语音时长（引擎时间戳）重新拟合
 * 后截距几乎不变（1873 vs 1984），说明它是说话本身的固有成本。
 *
 * 常数来自 zh-CN-YunxiNeural 的 20 条真实合成；换音色需要重新校准。
 */
export const TTS_FIXED_OVERHEAD_MS = 1_873;
export const TTS_MS_PER_CHINESE_CHAR = 114.5;

/**
 * 单个字符的平均耗时，仅用于粗略换算与向后兼容。
 *
 * 想估算某段中文的时长请用 {@link estimateSpokenMs}——它含固定开销，短句上准得多。
 */
export const DEFAULT_MS_PER_CHINESE_CHAR = TTS_MS_PER_CHINESE_CHAR;

export type SpeechRateModel = {
  fixedOverheadMs: number;
  msPerChar: number;
};

export const DEFAULT_SPEECH_RATE: SpeechRateModel = {
  fixedOverheadMs: TTS_FIXED_OVERHEAD_MS,
  msPerChar: TTS_MS_PER_CHINESE_CHAR,
};

/** 估算一段中文说完需要多久。 */
export const estimateSpokenMs = (
  charCount: number,
  rate: SpeechRateModel = DEFAULT_SPEECH_RATE,
): number => rate.fixedOverheadMs + Math.max(0, charCount) * rate.msPerChar;

/**
 * 把可用时长换算成字符预算。
 *
 * 至少留 1 个字：可用时长低于固定开销时（实测约 14% 的话语单元短于 1.9 秒）算出来
 * 会是负数，但产出空译文只会变成一段静音。这类单元靠翻译压不进去，得由后续的时长
 * 协商用相邻间隔或调速吸收——预算阶段能做的只是不让它变成空。
 */
export const dubTranslateCharBudget = (
  availableMs: number,
  rate: SpeechRateModel = DEFAULT_SPEECH_RATE,
): number => {
  const perChar = rate.msPerChar > 0 ? rate.msPerChar : TTS_MS_PER_CHINESE_CHAR;
  const usable = Math.max(0, availableMs) - rate.fixedOverheadMs;
  return Math.max(1, Math.floor(usable / perChar));
};

export const DUB_TRANSLATE_RULES: readonly string[] = [
  '1. Translate to FILL the budget, not merely to fit inside it. Each item carries a "maxChars" budget derived from how long that line may be spoken. Target 85-100% of maxChars. Never exceed it — but landing far short of it (below roughly 60%) is just as much a failure: the Chinese voice stops talking while the English speaker is still going, leaving that stretch of video with no dubbed audio and no subtitle.',
  "2. Spend the budget on completeness and natural phrasing, not padding. Spoken English is padded with filler and restatement — cut those first. Then use the room you freed up to restore details, qualifiers, examples, and causal links that a tight literal translation would drop, and to phrase the sentence the way a person would actually say it in Chinese. Do not add filler words, hedges, or repetition merely to consume characters — every character you add must carry meaning. Every fact, number, name, and causal link in the source must survive.",
  "3. Proper nouns, brand names, product names, shell commands, API names, and code identifiers stay EXACTLY as written. Never translate or transliterate them.",
  '4. Write for the EAR. Convert percentages, multipliers, and units into spoken Chinese ("30%" -> "百分之三十", "2x" -> "两倍"). Version numbers and model names (GPT-4, Claude 3.5, o3) stay verbatim.',
  '5. NEVER signal omission. No ellipses, no "等等", no "以此类推", no trailing dashes. A line that reads as truncated is a failure even when it fits.',
  "6. Each item is one spoken sentence. Keep it self-contained so it can be understood by ear without the neighbouring lines.",
  '7. Return ONLY a JSON array of objects with "index" (number) and "text" (string). One object per input index, same indices, same order. No commentary, no code fences.',
  "8. The output MUST be Simplified Chinese (zh-CN). Traditional Chinese is forbidden.",
  "9. " +
    "These are skill/product names and person names — keep them EXACTLY as spelled in English, " +
    "never translated or transliterated, even when the transcript writes them in lowercase " +
    "(ASR output is not capitalized, so match case-insensitively): " +
    `${PROTECTED_GLOSSARY_TERMS.join(", ")}. Names: ${PROTECTED_NAMES.join(", ")}. ` +
    'This applies even inside a longer phrase, e.g. "grill me skills" keeps "grill me" ' +
    'in English and translates only "skills".',
];

export const getDubTranslateSystemPrompt = (): string =>
  [
    "You are a Chinese dubbing translator. You receive English speech transcribed from a video, one spoken sentence per item, each with the number of Chinese characters it may occupy. You produce Simplified Chinese that carries the same meaning and can be spoken aloud within that budget.",
    "",
    "Rules:",
    ...DUB_TRANSLATE_RULES,
  ].join("\n");

/** LLM 漏行时的补齐 prompt，索引写死在指令里，逼它一条不落地返回。 */
export const buildDubTranslateRepairPrompt = (missingIndices: readonly number[]): string =>
  [
    `You are a Chinese dubbing translator. Translate these ${missingIndices.length} items from English into Simplified Chinese.`,
    `CRITICAL: return EXACTLY one object per index listed here — no more, no less: ${missingIndices.join(", ")}.`,
    "",
    "Rules:",
    ...DUB_TRANSLATE_RULES,
  ].join("\n");

export type DubTranslatePayloadItem = {
  index: number;
  text: string;
  maxChars: number;
};

/**
 * 预算按**话语单元自身的时长**算，不按词数——同样词数的句子说得快慢差很多，
 * 而时间轴上的余量只由时长决定。
 */
export const buildDubTranslatePayload = (
  utterances: readonly Utterance[],
  rate: SpeechRateModel = DEFAULT_SPEECH_RATE,
): DubTranslatePayloadItem[] =>
  utterances.map((u) => ({
    index: u.index,
    text: u.text,
    maxChars: dubTranslateCharBudget(u.endMs - u.startMs, rate),
  }));

export const buildDubTranslateUserPrompt = (
  utterances: readonly Utterance[],
  rate: SpeechRateModel = DEFAULT_SPEECH_RATE,
): string => JSON.stringify(buildDubTranslatePayload(utterances, rate));

/** 超预算重译 prompt：把实际字数和上限一起写死，逼模型给出更紧的一版。 */
export const buildDubTranslateTightenPrompt = (
  over: readonly { index: number; actualChars: number; maxChars: number }[],
): string =>
  [
    "You are a Chinese dubbing translator. Your previous translation of the following items exceeded its character budget.",
    "Translate each item again from the English source, tighter this time.",
    ...over.map(
      (o) =>
        `  index ${o.index}: previous attempt was ${o.actualChars} characters, the budget is ${o.maxChars}.`,
    ),
    "This is NOT an instruction to cut information out of your previous attempt. Translate the English source afresh and find a more compact wording for it.",
    "",
    "Rules:",
    ...DUB_TRANSLATE_RULES,
  ].join("\n");

/**
 * 低于预算重译 prompt：与 {@link buildDubTranslateTightenPrompt} 相反的方向。
 *
 * 把实际字数和预算一起写死，逼模型给出更完整的一版——不是让它灌水凑字数，而是把
 * 上一版被过度精简掉的细节、限定语、例子补回来，用更自然完整的中文句式表达。
 */
export const buildDubTranslateExpandPrompt = (
  under: readonly { index: number; actualChars: number; maxChars: number }[],
): string =>
  [
    "You are a Chinese dubbing translator. Your previous translation of the following items used far less than its character budget.",
    "This means the Chinese voice will finish speaking while the English speaker in the video is still talking — leaving dead air with no voice and no subtitle for the rest of that line's slot.",
    "Translate each item again from the English source, and use most of the budget this time.",
    ...under.map(
      (o) =>
        `  index ${o.index}: previous attempt was ${o.actualChars} characters, the budget is ${o.maxChars}.`,
    ),
    "This is NOT an instruction to pad the previous attempt with filler or repetition. Translate the English source afresh, restoring details, qualifiers, and examples a tight version dropped, and phrasing it the way a person would naturally say it in Chinese.",
    "",
    "Rules:",
    ...DUB_TRANSLATE_RULES,
  ].join("\n");
