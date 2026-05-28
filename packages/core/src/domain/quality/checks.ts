import type { GeneratedShortPost } from "../short/types.js";
import type { GeneratedThread } from "../thread/types.js";
import {
  ARTICLE_LEAD_MAX_CHARS,
  ARTICLE_MAX_CONSECUTIVE_PARAGRAPHS,
  ARTICLE_PARAGRAPH_MAX_CHARS,
  EXECUTABLE_ASSET_KEYWORDS,
  FORBIDDEN_AUTHOR_PHRASES,
  RISK_SECTION_KEYWORDS,
  SHORT_LIST_MAX_ITEMS,
  SHORT_LIST_MIN_ITEMS,
  SUMMARY_TONE_PHRASES,
  THREAD_FIRST_TWEET_FORBIDDEN_PREFIXES,
  THREAD_MAX_TWEETS,
  THREAD_MIN_TWEETS,
  THREAD_TWEET_MAX_CHARS,
  detectHighTrustTopics,
  matchesAny,
} from "./rules.js";
import type { HighTrustTopic } from "./types.js";

/**
 * Article / Short / Thread 内容质量的 deterministic checks。
 *
 * 所有检查均为纯函数：
 * - 输入只有内容字符串 / 结构化对象 + 可选的「来源文本」上下文。
 * - 输出是 `QualityIssue[]`；空数组表示通过。
 * - severity 始终为 "warning"，调用方负责日志或决定是否阻断。
 *
 * 这些检查不会调用 LLM，不会增加生成成本。
 */

export type QualityIssueSeverity = "warning";

export type QualityIssueCode =
  | "article.title-missing"
  | "article.title-not-bold"
  | "article.lead-missing"
  | "article.lead-too-long"
  | "article.no-sections"
  | "article.long-paragraph"
  | "article.too-many-consecutive-paragraphs"
  | "article.summary-tone-hook"
  | "article.missing-risk-section"
  | "article.missing-executable-asset"
  | "article.author-phrase"
  | "short.text-missing"
  | "short.list-out-of-range"
  | "short.summary-tone-hook"
  | "short.no-executable-item"
  | "short.missing-risk-reminder"
  | "short.author-phrase"
  | "thread.tweets-out-of-range"
  | "thread.tweet-too-long"
  | "thread.first-tweet-numbering"
  | "thread.first-tweet-summary-tone"
  | "thread.no-executable-tweet"
  | "thread.missing-risk-tweet"
  | "thread.author-phrase";

export type QualityIssue = {
  code: QualityIssueCode;
  severity: QualityIssueSeverity;
  message: string;
  /** 可选的辅助上下文：受影响的段落、tweet 序号、命中关键字等。 */
  detail?: string;
};

export type QualityCheckContext = {
  /**
   * 用于检测高信任主题的源文本（通常是 metadata.title + structured-notes 全文）。
   *
   * 如果不传，则只对正文内容做检测；可能会漏报。
   */
  sourceText?: string;
};

/** 简单去除 Markdown 加粗 / 斜体标记，便于按可见字符计数。 */
const stripMarkdownEmphasis = (text: string): string =>
  text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

/** 计算「可见字符」长度，去掉 markdown 标记后按字符数估算。 */
const visibleCharLength = (text: string): number =>
  stripMarkdownEmphasis(text).replace(/\s+/g, "").length;

/** 检测一段文本是否命中任意可执行资产关键字。 */
const hasExecutableAssetKeyword = (text: string): boolean => {
  const lower = text.toLowerCase();
  for (const keywords of Object.values(EXECUTABLE_ASSET_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k.toLowerCase()))) return true;
  }
  return false;
};

/** Article 是否包含「可执行资产」信号。 */
const articleHasExecutableAsset = (content: string): boolean => {
  // 1. fenced code block 直接算
  if (/```[\s\S]*?```/.test(content)) return true;

  // 2. 有序列表至少 3 项视为「步骤 / 清单」
  const orderedListItems = content.match(/^\s*\d+\.\s+/gm);
  if (orderedListItems !== null && orderedListItems.length >= 3) return true;

  // 3. 无序列表至少 3 项视为「清单」
  const unorderedListItems = content.match(/^\s*-\s+/gm);
  if (unorderedListItems !== null && unorderedListItems.length >= 3) return true;

  // 4. 关键字命中
  if (hasExecutableAssetKeyword(content)) return true;

  return false;
};

/** 解析 Article 第一段（导语）：在 H1 之后、第一个 H2 / 空行之前的连续非空行。 */
const extractArticleLead = (content: string): string | null => {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i += 1;
  if (i >= lines.length) return null;
  if (!lines[i]!.startsWith("# ")) {
    // 没有 H1，把第一段当导语处理
  } else {
    i += 1;
  }
  while (i < lines.length && lines[i]!.trim() === "") i += 1;
  if (i >= lines.length) return null;

  const buf: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") break;
    if (line.startsWith("## ")) break;
    buf.push(line);
    i += 1;
  }
  if (buf.length === 0) return null;
  return buf.join("\n").trim();
};

const ARTICLE_TITLE_LINE_RE = /^#\s+\*\*.+\*\*\s*$/;

/** 提取所有正文段落（按空行切分，过滤掉标题与代码块）。 */
const splitArticleParagraphs = (
  content: string,
): Array<{ text: string; isStructural: boolean }> => {
  const blocks: Array<{ text: string; isStructural: boolean }> = [];
  const lines = content.split(/\r?\n/);
  let buf: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (buf.length === 0) return;
    const text = buf.join("\n").trim();
    if (text === "") {
      buf = [];
      return;
    }
    const isStructural =
      /^\s*```/.test(text) ||
      /^\s*[-*+]\s+/.test(text) ||
      /^\s*\d+\.\s+/.test(text) ||
      /^\s*>/.test(text) ||
      /^\s*#{1,6}\s+/.test(text) ||
      /^\s*!\[/.test(text) ||
      /^\s*---+\s*$/.test(text);
    blocks.push({ text, isStructural });
    buf = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
};

const findArticleHeadings = (content: string): string[] => {
  const out: string[] = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith("## ")) out.push(line.slice(3).trim());
  }
  return out;
};

const headingMentionsRisk = (heading: string): boolean =>
  matchesAny(stripMarkdownEmphasis(heading), RISK_SECTION_KEYWORDS);

const articleHasRiskSection = (content: string): boolean =>
  findArticleHeadings(content).some(headingMentionsRisk);

/**
 * 检测一段文本第一句是否以「摘要腔」开头。
 *
 * 第一句定义：首个句号 / 问号 / 感叹号 / 换行 之前的内容。
 */
const firstSentence = (text: string): string => {
  const stripped = stripMarkdownEmphasis(text.trim());
  const m = stripped.match(/^[^。！？!?\n]+/);
  return m === null ? stripped : m[0];
};

const startsWithSummaryTone = (text: string): string | null => {
  const head = firstSentence(text);
  for (const phrase of SUMMARY_TONE_PHRASES) {
    if (head.includes(phrase)) return phrase;
  }
  return null;
};

const containsAuthorPhrase = (text: string): string | null => {
  for (const phrase of FORBIDDEN_AUTHOR_PHRASES) {
    if (text.includes(phrase)) return phrase;
  }
  return null;
};

const detectTopicsForCheck = (
  content: string,
  context: QualityCheckContext | undefined,
): HighTrustTopic[] => {
  const text = `${context?.sourceText ?? ""}\n${content}`;
  return detectHighTrustTopics(text);
};

/** 检查 Article 内容质量。 */
export const checkArticleQuality = (
  content: string,
  context: QualityCheckContext = {},
): QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const lines = content.split(/\r?\n/);

  // 1. 标题
  const firstNonEmpty = lines.find((line) => line.trim() !== "");
  if (firstNonEmpty === undefined || !firstNonEmpty.startsWith("# ")) {
    issues.push({
      code: "article.title-missing",
      severity: "warning",
      message: "Article 缺少 H1 标题，第一行应以 `# **标题**` 开头。",
    });
  } else if (!ARTICLE_TITLE_LINE_RE.test(firstNonEmpty)) {
    issues.push({
      code: "article.title-not-bold",
      severity: "warning",
      message: "Article 标题未加粗，应写成 `# **标题**` 格式。",
      detail: firstNonEmpty,
    });
  }

  // 2. 导语
  const lead = extractArticleLead(content);
  if (lead === null) {
    issues.push({
      code: "article.lead-missing",
      severity: "warning",
      message: "Article 缺少导语段落（标题之后应有一段强 Hook）。",
    });
  } else {
    const leadLen = visibleCharLength(lead);
    if (leadLen > ARTICLE_LEAD_MAX_CHARS) {
      issues.push({
        code: "article.lead-too-long",
        severity: "warning",
        message: `Article 导语过长：${leadLen} 字 > 上限 ${ARTICLE_LEAD_MAX_CHARS}。`,
        detail: lead.slice(0, 60),
      });
    }
    const toneHit = startsWithSummaryTone(lead);
    if (toneHit !== null) {
      issues.push({
        code: "article.summary-tone-hook",
        severity: "warning",
        message: `Article 导语命中摘要腔禁用词：「${toneHit}」。改写为场景/痛点/损失/收益承诺。`,
      });
    }
  }

  // 3. 小节
  const headings = findArticleHeadings(content);
  if (headings.length === 0) {
    issues.push({
      code: "article.no-sections",
      severity: "warning",
      message: "Article 没有 `##` 小节，无法构建移动端扫描节奏。",
    });
  }

  // 4. 段落长度 + 连续段落
  const blocks = splitArticleParagraphs(content);
  let consecutive = 0;
  for (const block of blocks) {
    if (block.isStructural) {
      consecutive = 0;
      continue;
    }
    if (/^#\s+\*\*/.test(block.text)) {
      consecutive = 0;
      continue;
    }
    const len = visibleCharLength(block.text);
    if (len > ARTICLE_PARAGRAPH_MAX_CHARS) {
      issues.push({
        code: "article.long-paragraph",
        severity: "warning",
        message: `Article 出现超长段落：${len} 字 > 上限 ${ARTICLE_PARAGRAPH_MAX_CHARS}。`,
        detail: block.text.slice(0, 60),
      });
    }
    consecutive += 1;
    if (consecutive > ARTICLE_MAX_CONSECUTIVE_PARAGRAPHS) {
      issues.push({
        code: "article.too-many-consecutive-paragraphs",
        severity: "warning",
        message: `Article 连续超过 ${ARTICLE_MAX_CONSECUTIVE_PARAGRAPHS} 个正文段落未插入列表/引用/代码块/图片等视觉锚点。`,
        detail: block.text.slice(0, 60),
      });
      consecutive = 0;
    }
  }

  // 5. 风险小节
  const topics = detectTopicsForCheck(content, context);
  if (topics.length > 0 && !articleHasRiskSection(content)) {
    issues.push({
      code: "article.missing-risk-section",
      severity: "warning",
      message: `Article 主题命中高信任成本场景（${topics.join(", ")}），缺少 \`## **风险与适用边界**\` 小节。`,
    });
  }

  // 6. 可执行资产
  if (!articleHasExecutableAsset(content)) {
    issues.push({
      code: "article.missing-executable-asset",
      severity: "warning",
      message: "Article 缺少可执行资产：至少需要一个 prompt、模板、清单、步骤表、风险清单或决策树。",
    });
  }

  // 7. 作者腔
  const author = containsAuthorPhrase(content);
  if (author !== null) {
    issues.push({
      code: "article.author-phrase",
      severity: "warning",
      message: `Article 出现禁用词「${author}」。`,
    });
  }

  return issues;
};

/** 计算 Short post text 中的 list item 数量。 */
const collectShortListItems = (text: string): string[] => {
  const lines = text.split(/\r?\n/);
  const items: string[] = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    if (/^\s*(?:\d+\.|[-*+])\s+/.test(line)) {
      items.push(line);
      continue;
    }
    if (/^\s*(?:\d+|[①②③④⑤⑥⑦⑧⑨⑩]|[0-9]️⃣)\s*$/.test(line)) {
      const next = lines.slice(idx + 1).find((candidate) => candidate.trim().length > 0);
      if (next !== undefined) {
        items.push(`${line.trim()} ${next.trim()}`);
      }
    }
  }
  return items;
};

const countShortListItems = (text: string): number => collectShortListItems(text).length;

/** Short text 中是否包含至少一条「可执行要点」：命令风格行、或命中关键字的 list item。 */
const shortHasExecutableItem = (text: string): boolean => {
  const items = collectShortListItems(text);
  for (const item of items) {
    if (hasExecutableAssetKeyword(item)) return true;
  }
  return false;
};

const shortHasRiskReminder = (text: string): boolean => {
  const items = collectShortListItems(text);
  for (const item of items) {
    if (matchesAny(stripMarkdownEmphasis(item), RISK_SECTION_KEYWORDS)) return true;
  }
  return false;
};

/** 检查 X short post 质量。 */
export const checkShortQuality = (
  shortPost: GeneratedShortPost,
  context: QualityCheckContext = {},
): QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const text = shortPost.text ?? "";
  if (text.trim() === "") {
    issues.push({
      code: "short.text-missing",
      severity: "warning",
      message: "Short post text 为空。",
    });
    return issues;
  }

  const listCount = countShortListItems(text);
  if (listCount < SHORT_LIST_MIN_ITEMS || listCount > SHORT_LIST_MAX_ITEMS) {
    issues.push({
      code: "short.list-out-of-range",
      severity: "warning",
      message: `Short post list item 数量为 ${listCount}，应在 ${SHORT_LIST_MIN_ITEMS}–${SHORT_LIST_MAX_ITEMS} 之间。`,
    });
  }

  const toneHit = startsWithSummaryTone(text);
  if (toneHit !== null) {
    issues.push({
      code: "short.summary-tone-hook",
      severity: "warning",
      message: `Short post 首句命中摘要腔禁用词：「${toneHit}」。改写为强判断或强反差。`,
    });
  }

  if (!shortHasExecutableItem(text)) {
    issues.push({
      code: "short.no-executable-item",
      severity: "warning",
      message: "Short post 缺少可执行要点：至少 1 条 list item 应该是命令、可复制 prompt、模板、步骤或检查项。",
    });
  }

  const topics = detectTopicsForCheck(text, context);
  if (topics.length > 0 && !shortHasRiskReminder(text)) {
    issues.push({
      code: "short.missing-risk-reminder",
      severity: "warning",
      message: `Short post 主题命中高信任成本场景（${topics.join(", ")}），缺少独立的风险/边界 list item。`,
    });
  }

  const author = containsAuthorPhrase(text);
  if (author !== null) {
    issues.push({
      code: "short.author-phrase",
      severity: "warning",
      message: `Short post 出现禁用词「${author}」。`,
    });
  }

  return issues;
};

const firstTweetStartsWithForbiddenPrefix = (tweet: string): string | null => {
  const head = stripMarkdownEmphasis(tweet).trim();
  for (const prefix of THREAD_FIRST_TWEET_FORBIDDEN_PREFIXES) {
    if (head.startsWith(prefix)) return prefix;
  }
  return null;
};

const threadHasExecutableTweet = (tweets: readonly string[]): boolean => {
  for (const tweet of tweets) {
    if (/```[\s\S]*?```/.test(tweet)) return true;
    if (/`[^`]+`/.test(tweet)) return true;
    if (hasExecutableAssetKeyword(tweet)) return true;
    if (matchesAny(stripMarkdownEmphasis(tweet), RISK_SECTION_KEYWORDS)) return true;
  }
  return false;
};

const threadHasRiskTweet = (tweets: readonly string[]): boolean =>
  tweets.some((tweet) => matchesAny(stripMarkdownEmphasis(tweet), RISK_SECTION_KEYWORDS));

/** 检查 X thread 质量。 */
export const checkThreadQuality = (
  thread: GeneratedThread,
  context: QualityCheckContext = {},
): QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const tweets = thread.tweets ?? [];

  if (tweets.length < THREAD_MIN_TWEETS || tweets.length > THREAD_MAX_TWEETS) {
    issues.push({
      code: "thread.tweets-out-of-range",
      severity: "warning",
      message: `Thread tweet 数量为 ${tweets.length}，应在 ${THREAD_MIN_TWEETS}–${THREAD_MAX_TWEETS} 之间。`,
    });
  }

  tweets.forEach((tweet, idx) => {
    if (tweet.length > THREAD_TWEET_MAX_CHARS) {
      issues.push({
        code: "thread.tweet-too-long",
        severity: "warning",
        message: `Thread tweets[${idx}] 长度 ${tweet.length} > 上限 ${THREAD_TWEET_MAX_CHARS}。`,
      });
    }
  });

  const first = tweets[0];
  if (first !== undefined) {
    const prefix = firstTweetStartsWithForbiddenPrefix(first);
    if (prefix !== null) {
      issues.push({
        code: "thread.first-tweet-numbering",
        severity: "warning",
        message: `Thread 首推不应以「${prefix}」开头，应该像独立 X 帖子那样成立。`,
      });
    }
    const toneHit = startsWithSummaryTone(first);
    if (toneHit !== null) {
      issues.push({
        code: "thread.first-tweet-summary-tone",
        severity: "warning",
        message: `Thread 首推命中摘要腔禁用词：「${toneHit}」。改写为强判断、强对立或痛点。`,
      });
    }
  }

  if (!threadHasExecutableTweet(tweets)) {
    issues.push({
      code: "thread.no-executable-tweet",
      severity: "warning",
      message: "Thread 缺少可执行 tweet：至少需要一条提供 prompt、模板、清单、步骤或风险提示。",
    });
  }

  const topics = detectTopicsForCheck(tweets.join("\n"), context);
  if (topics.length > 0 && !threadHasRiskTweet(tweets)) {
    issues.push({
      code: "thread.missing-risk-tweet",
      severity: "warning",
      message: `Thread 主题命中高信任成本场景（${topics.join(", ")}），缺少独立的风险/边界 tweet。`,
    });
  }

  const joinedText = tweets.join("\n");
  const author = containsAuthorPhrase(joinedText);
  if (author !== null) {
    issues.push({
      code: "thread.author-phrase",
      severity: "warning",
      message: `Thread 出现禁用词「${author}」。`,
    });
  }

  return issues;
};

/**
 * 把 quality issues 序列化为一段人类可读的 warning 日志正文。
 *
 * 适合 logger 输出，让调用方知道命中了哪些规则、产物路径在哪。
 */
export const formatQualityIssues = (
  issues: readonly QualityIssue[],
): string => {
  if (issues.length === 0) return "";
  return issues
    .map((issue) => {
      const detail = issue.detail !== undefined ? ` (${issue.detail})` : "";
      return `- [${issue.severity}] ${issue.code}: ${issue.message}${detail}`;
    })
    .join("\n");
};
