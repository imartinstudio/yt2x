type TechnicalTermPair = {
  translatedTerm: string;
  originalTerm: string;
};

const TECHNICAL_TERM_PAIR_RE =
  /([\p{Script=Han}]{2,20})[（(]([A-Z][A-Za-z0-9+./-]*(?:\s+[A-Z][A-Za-z0-9+./-]*)*)[）)]/gu;

const KNOWN_TECHNICAL_TERM_PAIRS: readonly TechnicalTermPair[] = [
  { translatedTerm: "提示工程", originalTerm: "Prompt Engineering" },
  { translatedTerm: "上下文工程", originalTerm: "Context Engineering" },
  { translatedTerm: "图工程", originalTerm: "Graph Engineering" },
  { translatedTerm: "知识图谱", originalTerm: "Knowledge Graph" },
  { translatedTerm: "代理图谱", originalTerm: "Agent Graph" },
];

const NON_GRAPH_IMAGE_TERM_RE =
  /(?:截图|截屏|缩略图|图片|图像|图表|图标|图形|图案|图层|图纸|图书|图解|图示|示意图|流程图|封面图|配图|插图|地图|草图|图文)/gu;
const SOURCE_GRAPH_TERM_RE = /\bGraph\b/i;
const HAN_CHAR_RE = /\p{Script=Han}/u;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hasOriginalTerm = (sourceText: string, originalTerm: string): boolean =>
  new RegExp(`\\b${escapeRegExp(originalTerm)}\\b`, "i").test(sourceText);

const normalizeTranslatedTerm = (translatedTerm: string): string =>
  translatedTerm.replace(/^(?:和|与|及|或|以及|此外|使用|关于|通过|将|把|是|即|如|按|从|在)+/u, "").trim();

const getProtectedTechnicalTermPairs = (
  sourceText: string,
  sourceTitle = "",
): TechnicalTermPair[] => {
  const pairs: TechnicalTermPair[] = [];
  const seen = new Set<string>();
  const add = (pair: TechnicalTermPair): void => {
    const key = `${pair.translatedTerm}\u0000${pair.originalTerm}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(pair);
  };

  for (const match of sourceText.matchAll(TECHNICAL_TERM_PAIR_RE)) {
    const translatedTerm = match[1] === undefined ? undefined : normalizeTranslatedTerm(match[1]);
    const originalTerm = match[2]?.trim();
    if (translatedTerm === undefined || originalTerm === undefined) continue;
    add({ translatedTerm, originalTerm });
  }

  const sourceContext = `${sourceText}\n${sourceTitle}`;
  for (const pair of KNOWN_TECHNICAL_TERM_PAIRS) {
    if (hasOriginalTerm(sourceContext, pair.originalTerm)) add(pair);
  }

  return pairs.sort((a, b) => b.translatedTerm.length - a.translatedTerm.length);
};

const replaceWithEnglishSpacing = (content: string, translatedTerm: string, originalTerm: string): string => {
  const termRe = new RegExp(escapeRegExp(translatedTerm), "gu");
  return content.replace(termRe, (match: string, offset: number, fullText: string) => {
    const previous = fullText[offset - 1] ?? "";
    const next = fullText[offset + match.length] ?? "";
    return `${HAN_CHAR_RE.test(previous) ? " " : ""}${originalTerm}${HAN_CHAR_RE.test(next) ? " " : ""}`;
  });
};

/**
 * 恢复所有内容产物中的源技术术语。
 *
 * sourceText 可以是 structured-notes、article.md 或其它包含源术语的输入材料；
 * sourceTitle 用于补充原标题中出现、但笔记未生成中英并列形式的术语。
 */
export const restoreProtectedTechnicalTermsInContent = (
  content: string,
  sourceText: string,
  sourceTitle = "",
): string => {
  const pairs = getProtectedTechnicalTermPairs(sourceText, sourceTitle);
  const sourceContext = `${sourceText}\n${sourceTitle}`;
  const hasGraphTerm = SOURCE_GRAPH_TERM_RE.test(sourceContext);
  if (pairs.length === 0 && !hasGraphTerm) return content;

  const placeholders = new Map<string, string>();
  const addPlaceholder = (match: string): string => {
    const token = `\uE000YT2X_KEEP_${placeholders.size}\uE001`;
    placeholders.set(token, match);
    return token;
  };

  let restored = content;
  for (const { translatedTerm, originalTerm } of pairs) {
    const pairRe = new RegExp(
      `(?:${escapeRegExp(originalTerm)}\\s*[（(]\\s*${escapeRegExp(translatedTerm)}\\s*[）)]|${escapeRegExp(translatedTerm)}\\s*[（(]\\s*${escapeRegExp(originalTerm)}\\s*[）)])`,
      "gu",
    );
    restored = restored.replace(pairRe, addPlaceholder);
  }

  for (const { translatedTerm, originalTerm } of pairs) {
    restored = replaceWithEnglishSpacing(restored, translatedTerm, originalTerm);
  }

  if (hasGraphTerm) {
    const activeTranslatedTerms = new Set(pairs.map(({ translatedTerm }) => translatedTerm));
    for (const { translatedTerm } of KNOWN_TECHNICAL_TERM_PAIRS) {
      if (activeTranslatedTerms.has(translatedTerm)) continue;
      const unconfirmedTermRe = new RegExp(escapeRegExp(translatedTerm), "gu");
      restored = restored.replace(unconfirmedTermRe, addPlaceholder);
    }
    restored = restored.replace(NON_GRAPH_IMAGE_TERM_RE, addPlaceholder);
    restored = restored.replace(/图/gu, (match: string, offset: number, fullText: string) => {
      const previous = fullText[offset - 1] ?? "";
      const next = fullText[offset + match.length] ?? "";
      return `${HAN_CHAR_RE.test(previous) ? " " : ""}Graph${HAN_CHAR_RE.test(next) ? " " : ""}`;
    });
  }

  for (const [token, original] of placeholders) {
    restored = restored.replaceAll(token, original);
  }
  return restored;
};

/** 恢复 JSON-like 产物中的所有字符串字段，覆盖 title/body/tags/hooks 等嵌套字段。 */
export const restoreProtectedTechnicalTermsInValue = <T>(
  value: T,
  sourceText: string,
  sourceTitle = "",
): T => {
  const restore = (current: unknown): unknown => {
    if (typeof current === "string") {
      return restoreProtectedTechnicalTermsInContent(current, sourceText, sourceTitle);
    }
    if (Array.isArray(current)) return current.map((item) => restore(item));
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current).map(([key, child]) => [key, restore(child)]),
      );
    }
    return current;
  };
  return restore(value) as T;
};

/** 仅用于主文章 H1：只恢复原标题确实包含的英文术语，避免标题凭空增词。 */
export const restoreProtectedTechnicalTermsInTitle = (
  translatedTitle: string,
  sourceText: string,
  sourceTitle: string,
): string => {
  let title = translatedTitle;
  for (const { translatedTerm, originalTerm } of getProtectedTechnicalTermPairs(sourceText, sourceTitle)) {
    if (!hasOriginalTerm(sourceTitle, originalTerm) || new RegExp(`\\b${escapeRegExp(originalTerm)}\\b`, "i").test(title)) {
      continue;
    }
    title = title
      .replaceAll(translatedTerm, ` ${originalTerm} `)
      .replace(/\s+/gu, " ")
      .trim();
  }
  return title;
};
