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
