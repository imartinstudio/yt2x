import { DUB_TERM_TRANSLATIONS, PROTECTED_GLOSSARY_TERMS, PROTECTED_NAMES } from "./glossary.js";
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
 * 刻意不用单一的"每字毫秒"常数——实测每字成本从约 306ms（8 字短句）到约 200ms
 * （55 字长句）相差超过 50%，短句每字更贵。用常数拟合，两头都不准。
 *
 * 固定开销来自起音与句末拖长，不是首尾静音——按纯语音时长（引擎时间戳，即
 * `--write-subtitles` 首条 cue 起点到末条 cue 终点）测量，不是整个音频文件时长。
 *
 * **当前常数来自 `zh-CN-YunjianNeural`（云健）的 27 条真实合成，覆盖 8–60 字，
 * 平均绝对误差 325ms。样本取自两条真实视频已交付的配音译文（覆盖长度分层，
 * 含少量内嵌英文专有名词的行，与生产环境实际输入一致）。旧常数（云希 20 条
 * 样本、覆盖 7–61 字）套用在云健的这 27 条真实数据上平均绝对误差达 1119ms——
 * 云健不是慢 4% 那么简单，是整条时长曲线的斜率都不同（每字成本 175.2ms vs
 * 云希的 114.5ms，高出约 53%），这也是全片曾被硬门禁拦下（`extendMs` 超限）
 * 的根因：字符预算按云希的曲线算，云健念出来系统性地比预算长。**
 *
 * 换音色需要重新校准——这次崩溃就是因为上一次换音色（zh-CN-YunxiNeural →
 * zh-CN-YunjianNeural）只标定了门禁阈值，漏了这两个常数本身。以后每次换音色，
 * 两者必须一起重新标定，缺一个都会让字符预算与门禁互相打架。
 *
 * 旧值（zh-CN-YunxiNeural，20 条真实样本，7–61 字，保留作对照）：
 * fixedOverheadMs 1873，msPerChar 114.5，平均绝对误差 539ms。
 */
export const TTS_FIXED_OVERHEAD_MS = 1_132;
export const TTS_MS_PER_CHINESE_CHAR = 175.2;

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
    'in English and translates only "skills". ' +
    'Example: "My grill me skills and grill with docs have been out there for a while now" -> ' +
    '"我的 Grill Me 技能和 Grill with Docs 已经发布一段时间了" — "grill me" and "grill with docs" ' +
    "stay in English; everything around them is translated. " +
    'A single sentence can contain BOTH the protected skill name AND an ordinary derived word ' +
    'from rule 10 at the same time — do not let one "grill" pull the other into the same ' +
    'treatment; scan the whole sentence for each pattern independently. Example: ' +
    '"the grill me skills is trying to answer high fidelity questions during a grilling session" ' +
    '-> "Grill Me 技能试图在追问环节回答高保真问题" — "grill me" (part of the skill name ' +
    '"grill me skills") stays in English even though "grilling session", later in the very same ' +
    'sentence, must be translated to 追问环节 per rule 10.',
  "10. " +
    "The following ARE ordinary English words, not proper nouns, so translate them — but their " +
    "Chinese rendering must be IDENTICAL every single time they occur anywhere in the whole " +
    "transcript. Treat this as a fixed vocabulary lookup, not a case-by-case translation " +
    "decision, even when a different wording would otherwise read more naturally in a given " +
    "sentence: " +
    DUB_TERM_TRANSLATIONS.map((t) => `"${t.source}" -> ${t.zh}`).join(", ") +
    '. This rule does NOT apply to "grill me" or "grill with docs" — those are the skill names ' +
    "from rule 9 and must stay in English exactly as rule 9 says, even though the word " +
    '"grill" appears inside them. Rule 9 always wins over this rule when both could apply to ' +
    "the same words.",
  "11. " +
    "You are shown ALL items in this transcript together, but each is still translated and " +
    "scored independently — a protected term (rule 9) can be split across two adjacent items " +
    'by sentence segmentation, e.g. one item ends "...they create a new context window and ' +
    'just run two" and the very next item begins "PRD in there. This is totally crazy to me. ' +
    'What are you doing?" (the term "PRD", from the skill name "2PRD", spans the boundary). ' +
    "When that happens, the term MUST still appear in the translation of EVERY item whose own " +
    "source text contains it — never drop it from an item just because a neighboring item's " +
    'translation already used it. For the example above: translate the second item as ' +
    '"PRD 就搁在那儿，这太疯狂了，你在干什么？" (keeping "PRD"), never as "这太疯狂了，你在干什么？" ' +
    "(dropping it). This redundancy across two adjacent items is required, not the kind of " +
    "padding rule 2 tells you to avoid.",
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

/**
 * 术语补漏重译 prompt：上一版译文丢了源文本里该有的保护术语（rule 9），把具体缺失的
 * 术语写死在指令里，逼模型把术语本身按原文拼写原样放回译文——不是抽象重申规则，而是
 * 指名道姓地告诉它这次漏了什么。真实全片复现过这个缺陷即使有 few-shot 示例仍偶发
 * （LLM 输出非确定），需要一道事后校验 + 定向重译兜底，而不是只靠提示词词法穷举。
 */
/**
 * 术语补漏 prompt：**编辑任务，不是重译任务**。
 *
 * 上一版让模型「从英文原文重译一遍」，等于把它刚刚失败的那道题原样再出一次——真实
 * 素材上复现过一句连续失败：`"...with the grill me skills is trying to answer high
 * fidelity questions during a grilling session"` 里，专名 `grill me` 与派生词
 * `grilling session` 紧挨着出现，模型两次都把整块处理成「追问」，即使被点名要求补
 * `Grill Me` 也不改。加 few-shot 示例同样无效。
 *
 * 改成把**已有译文**交给它、只要求把缺的词插回去：模型不必再做那个它已经证明会
 * 做错的取舍，只需在一句现成的中文里找个位置插入。同时给出字符上限，避免补词把
 * 这一行推过时长预算。
 */
export const buildDubTranslateGlossaryRepairPrompt = (
  missing: readonly { index: number; terms: readonly string[] }[],
): string =>
  [
    "You are editing existing Chinese dubbing subtitles. Each item below is a finished Chinese translation that is missing one or more protected terms — proper nouns that must appear verbatim in English.",
    ...missing.map(
      (m) => `  index ${m.index}: missing term(s): ${m.terms.map((t) => `"${t}"`).join(", ")}.`,
    ),
    "",
    "Your job is to insert the listed term(s) into the existing Chinese text. This is an editing task, not a translation task:",
    "- Keep the existing wording. Change as little as possible around the insertion point.",
    "- Each term must appear with the exact spelling and capitalization shown above.",
    "- A term is a proper noun even when a related ordinary word sits next to it in the same sentence. Insert the proper noun; leave the ordinary word's existing Chinese rendering alone.",
    "- Stay within each item's `maxChars` budget. Drop filler elsewhere in the line if you need the room.",
    "",
    'Return a JSON array: [{"index":<number>,"text":"<edited Chinese>"}]',
  ].join("\n");

export type DubGlossaryRepairItem = {
  index: number;
  /** 当前译文——模型要编辑的对象，不是英文原文。 */
  text: string;
  maxChars: number;
};

/** 术语补漏的用户消息：喂当前中文译文，不喂英文原文；格式与其余各 pass 一致，裸数组。 */
export const buildDubGlossaryRepairUserPrompt = (
  items: readonly DubGlossaryRepairItem[],
): string => JSON.stringify(items);

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
