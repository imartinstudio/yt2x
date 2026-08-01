/**
 * 领域词汇表：双语字幕翻译（`packages/adapters-node/src/acquire/semantic-bilingual-subtitles.ts`）
 * 与配音翻译（`translate-prompts.ts`）共享的唯一事实来源。
 *
 * 这本来就是领域词汇——它是人读的 `CONTEXT.md` 术语表的机器可读版本。两条翻译链路各翻
 * 各的曾直接导致同一个词（"grill"）在配音里被译成四种不同的东西，而双语字幕链路早就有
 * 这套保护机制。放在 core 让两条链路消费同一份表，不再重演。
 *
 * core 不能依赖 `packages/adapters-node`，所以这张表只能住在这里；adapters-node 反过来
 * 从 `@yt2x/core` 导入。
 */

/** 保留英文、整体不译的专有名词（技能名 / 产品名 / 品牌名）。 */
export const PROTECTED_GLOSSARY_TERMS = [
  "Grill Me",
  "Grill with Docs",
  "2PRD",
  "Codex",
  "Plan Mode",
  "Agents",
  "PRD",
  "Air Coding Cohort",
  "Shape Up",
  "YouTube",
  "Discord",
] as const;

/** 保留英文、整体不译的人名。 */
export const PROTECTED_NAMES = ["Matt Pocock", "Ryan Singer", "Gary Tan", "G Stack"] as const;

export const PROTECTED_TERMS: readonly string[] = [...PROTECTED_GLOSSARY_TERMS, ...PROTECTED_NAMES];

/**
 * 大小写不敏感地判断 `text` 中是否出现了 `term`。
 *
 * 转写稿（ASR）几乎总是纯小写（"grill me" 而非 "Grill Me"），术语表则沿用文档惯用的
 * 首字母大写拼写；两边字面不一致，任何依据术语表判断"这句话里有没有这个词"的逻辑
 * 都必须先做一次大小写归一化，否则表里列了词也匹配不上——真实成片里 4 句提到
 * "grill me"/"grill with docs" 的话语单元只有 1 句偶然保住了英文，很可能就是这个
 * 匹配缺陷的后果。
 */
export const containsTermCaseInsensitive = (text: string, term: string): boolean =>
  text.toLocaleLowerCase("en").includes(term.toLocaleLowerCase("en"));

/** 大小写不敏感地找出 `enText` 中实际出现（因而必须原样保留）的术语子集。 */
export const findPresentProtectedTerms = (
  enText: string,
  terms: readonly string[] = PROTECTED_TERMS,
): string[] => terms.filter((term) => containsTermCaseInsensitive(enText, term));

// Chinese has no spaces between words, so a raw character-position split can
// (and in real DeepSeek output did) land inside an ordinary multi-character
// word like "范围" or "可能". Intl.Segmenter's dictionary-based word
// segmentation is built into Node (ICU) — no new dependency needed.
const CJK_WORD_SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * Finds every span in `text` that a split must not land inside: every
 * occurrence of a known glossary term (may contain spaces, e.g. "Grill with
 * Docs"), plus every bare run of Latin/digit characters (covers embedded
 * English words like "Agents" even when they aren't in the glossary at all),
 * plus every multi-character Chinese word (so a split never lands mid-word).
 */
export const findProtectedSpans = (
  text: string,
  terms: readonly string[] = PROTECTED_TERMS,
): [number, number][] => {
  const spans: [number, number][] = [];
  for (const term of terms) {
    let fromIndex = 0;
    let idx: number;
    while ((idx = text.indexOf(term, fromIndex)) !== -1) {
      spans.push([idx, idx + term.length]);
      fromIndex = idx + term.length;
    }
  }
  const latinRun = /[A-Za-z0-9]+/gu;
  let match: RegExpExecArray | null;
  while ((match = latinRun.exec(text)) !== null) {
    spans.push([match.index, match.index + match[0].length]);
  }
  // Protect multi-character Chinese words; a single character has no
  // internal boundary to protect, and punctuation is never word-like.
  for (const seg of CJK_WORD_SEGMENTER.segment(text)) {
    if (seg.isWordLike && seg.segment.length > 1) {
      spans.push([seg.index, seg.index + seg.segment.length]);
    }
  }
  return spans;
};

/**
 * 派生词的锁定译法：源词不是专有名词，允许翻译成中文，但全片必须逐字统一，不能一句
 * 一个译法。与 {@link PROTECTED_GLOSSARY_TERMS} 相反——那张表是"整体保留英文"，这张
 * 表是"必须翻译，但译法写死"。条目按长度降序排列，供构造提示词文本时优先展示更具体
 * 的短语（如 "grilling session" 排在裸词 "grilling" 之前）。
 *
 * ## grill 系
 *
 * 技能名 "Grill Me" / "Grill with Docs" 本身整体保留英文（见上表）；但它的动词/形容词
 * 派生形式（grilling、grillable、ungrillable）是普通英文构词，逐字保留英文会让中文
 * 听感很怪。真实成片曾把同一个 "grill" 译成"提问环节""评审会""可评审""带文档的评审"
 * 四种不同的东西——观众串不起来，而且"评审"本身就是误译：grill 在这里的字面意思是
 * "追问、盘问"（该技能自己的描述是 "Grill the user relentlessly"）。统一改用"追问"系。
 *
 * ## fidelity
 *
 * 借自 Ryan Singer《Shape Up》的方法论术语（真实转写稿第 17 句明确点名了这个出处），
 * 在同一支转写稿里出现 18 次，实测被译成"保真""精确""精度"三种不同的词——同样是
 * 全片译法不统一，锁定为"保真度"（含 high/low fidelity 的常见搭配）。
 *
 * `scope`、`hand off`/`handoff`、`prototype session` 也在同一支转写稿里高频出现
 * （分别 10 次、11 次、4 次），但抽样比对真实译文后发现它们已经被稳定译成"范围"、
 * "交接"、"原型会议/环节"，没有观测到 grill / fidelity 那种全片译法打架的问题，因此
 * 没有加入这张表——写死一个已经稳定的译法收益很小，却会让提示词变长。
 */
export const DUB_TERM_TRANSLATIONS: readonly { source: string; zh: string }[] = [
  { source: "grilling session", zh: "追问环节" },
  { source: "grilling sessions", zh: "追问环节" },
  { source: "high fidelity", zh: "高保真" },
  { source: "low fidelity", zh: "低保真" },
  { source: "grillable", zh: "可追问" },
  { source: "ungrillable", zh: "不可追问" },
  { source: "grilling", zh: "追问" },
  { source: "fidelity", zh: "保真度" },
  { source: "grill", zh: "追问" },
];
