/**
 * Article (markdown) → thread (string[]) 纯函数。
 *
 * X 长文 / 串推正文切分与 Markdown 剥离。
 * 做了几处工程化收紧：
 *  - 显式可注入 maxChars / maxTweets / numbering，避免硬编码
 *  - splitToChunks 不再依赖 ASCII 空格分割（中文场景）
 *  - tweetLength 按 X 加权规则计数（CJK 每个计 2，其余计 1）
 */

export type ArticleToThreadOptions = {
  /** 每条推最大加权字符数；yt2x 默认按当前发布策略使用 500。 */
  maxChars?: number;
  /** 整个 thread 最多多少条；默认 8。 */
  maxTweets?: number;
  /** 是否给每条推加 ①②③ 编号。默认 false（让用户自由控制）。 */
  numbering?: boolean;
};

export type ArticleToLongPostOptions = {
  /** 单条长文加权字符上限，默认 25000（X Premium）。 */
  maxChars?: number;
};

export type PrepareTextForXPublishOptions = {
  /** 有序步骤列表格式：x-short 用 decimal，x-thread 内部步骤用 circled。 */
  orderedListStyle?: "decimal" | "circled";
};

const DEFAULT_MAX_CHARS = 500;
const DEFAULT_MAX_TWEETS = 8;
/** X Premium 长文单条上限（非 Premium 账号请用串推 `--thread` + `--max-chars 280`） */
export const DEFAULT_LONG_POST_MAX_CHARS = 25_000;

const NUMBER_GLYPHS = [
  "①",
  "②",
  "③",
  "④",
  "⑤",
  "⑥",
  "⑦",
  "⑧",
  "⑨",
  "⑩",
  "⑪",
  "⑫",
  "⑬",
  "⑭",
  "⑮",
  "⑯",
  "⑰",
  "⑱",
  "⑲",
  "⑳",
] as const;

/**
 * X (Twitter) 加权字符计数。
 *
 * X 的计长规则（近似）：
 *  - CJK 字符（中日韩统一表意文字、平假名、片假名、谚文）每个计为 2
 *  - 其余字符（ASCII、emoji、拉丁扩展等）每个计为 1
 *
 * 这是 X API 使用的 "weighted length" 的合理近似。
 * 参见 https://developer.x.com/en/docs/counting-characters
 */
export const tweetLength = (s: string): number => {
  let len = 0;
  for (const cp of s) {
    const code = cp.codePointAt(0)!;
    // CJK Unified Ideographs (4E00-9FFF), Extension A (3400-4DBF),
    // Compatibility Ideographs (F900-FAFF), Supplement (>20000)
    // Hiragana (3040-309F), Katakana (30A0-30FF)
    // Hangul Syllables (AC00-D7AF), Hangul Jamo (1100-11FF)
    // CJK Symbols (3000-303F), Fullwidth Forms (FF01-FF60, FFE0-FFE6)
    // Kangxi Radicals (2F00-2FDF), CJK Strokes (31C0-31EF)
    // Enclosed CJK (3200-32FF)
    const isWide =
      (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
      (code >= 0x2f00 && code <= 0x2fdf) || // Kangxi Radicals
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols/Punctuation
      (code >= 0x3040 && code <= 0x30ff) || // Hiragana, Katakana
      (code >= 0x3100 && code <= 0x312f) || // Bopomofo
      (code >= 0x31c0 && code <= 0x31ef) || // CJK Strokes
      (code >= 0x3200 && code <= 0x32ff) || // Enclosed CJK
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
      (code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
      code >= 0x20000; // CJK Extension B+
    len += isWide ? 2 : 1;
  }
  return len;
};

export const threadNumber = (i: number): string =>
  i < NUMBER_GLYPHS.length ? NUMBER_GLYPHS[i]! : `(${i + 1})`;

/** 按 X 加权长度截断文本（CJK 计 2，其余计 1）。 */
export const truncateToWeightedLength = (text: string, maxWeighted: number): string => {
  if (maxWeighted <= 0) return "";
  if (tweetLength(text) <= maxWeighted) return text;
  let piece = "";
  for (const cp of text) {
    if (tweetLength(piece + cp) > maxWeighted) break;
    piece += cp;
  }
  return piece;
};

const isListLine = (line: string): boolean => /^[ \t]*(?:\d+\/|\d+\.|- |[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳] )/.test(line);

const formatOrderedListMarker = (raw: string, style: "decimal" | "circled"): string => {
  if (style === "decimal") return `${raw}.`;
  const index = Number.parseInt(raw, 10) - 1;
  return NUMBER_GLYPHS[index] ?? `${raw}.`;
};

const normalizeReadableXLayout = (text: string): string => {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }

    const prev = out[out.length - 1];
    if (out.length > 0 && prev !== "" && isListLine(trimmed) && !isListLine(prev!)) {
      // 保留列表与前一段之间的分隔，但连续步骤之间只换行，不额外空一行。
      if (out.length >= 2 && out[out.length - 2] === "") {
        // already separated
      }
    }
    out.push(trimmed);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

/**
 * X 发布前文本准备 hook。
 *
 * 目标是保留信息内容，移除或转换 X post 不适合直接展示的 Markdown 壳：
 * - 图片移除，链接保留可读文本
 * - Markdown 加粗标记直接清除，不转 Unicode bold
 * - Markdown 加粗标题前缀后换行，让标题和正文分开
 * - 有序列表统一成 `1. `，无序列表统一成 `- `
 * - 任务列表、表格、引用、脚注转换为可读文本
 * - 代码块保留代码内容但去掉围栏
 */
export const prepareTextForXPublish = (
  input: string,
  options: PrepareTextForXPublishOptions = {},
): string => {
  const orderedListStyle = options.orderedListStyle ?? "circled";
  const clean = input
    .replace(/`{3}[^\n`]*\n?([\s\S]*?)`{3}/g, (_m, code: string) => code.trim())
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*\n]{1,48}[：:])\*\*[ \t]*(?=\S)/g, "$1\n")
    .replace(/__([^_\n]{1,48}[：:])__[ \t]*(?=\S)/g, "$1\n")
    .replace(/\*\*([^*\n](?:[^*]|\*(?!\*))*)\*\*/g, "$1")
    .replace(/__([^_\n](?:[^_]|_(?!_))*)__/g, "$1")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, "")
    .replace(/^[ \t]*((?:\d+\/\s*)?)\|(.+)\|[ \t]*$/gm, (_m, prefix: string, row: string) =>
      prefix +
      String(row)
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0)
        .join(" ｜ "),
    )
    .replace(/([^\n]*｜[^\n]*)\n{2,}(?=[^\n]*｜)/g, "$1\n")
    .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, "- ")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*([0-9]+)\uFE0F?\u20E3[ \t]*/gm, (_m, n: string) => {
      return `${formatOrderedListMarker(n, orderedListStyle)} `;
    })
    .replace(/^[ \t]*[•●○◦·][ \t]*/gm, "- ")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "- ")
    .replace(/^[ \t]*(\d+)[.)][ \t]+/gm, (_m, n: string) => `${formatOrderedListMarker(n, orderedListStyle)} `)
    .replace(/\b(https?):\n\/\//g, "$1://")
    .replace(/^(\d+\/ [^：:\n]{2,80}[：:])(?!\/\/)([^\n]+)$/gm, (_m, title: string, body: string) =>
      `${title}\n\n${String(body).trimStart()}`,
    )
    .replace(/^(\d+\/ [^：:\n]{2,80}[：:])\n(?=\S)/gm, "$1\n\n")
    .replace(/^((?:\d+\.|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]) [^：:\n]{2,80}[：:])\n(?=\S)/gm, "$1 ")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    .replace(/\[\^([^\]]+)\]/g, "($1)")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "引用：")
    .replace(/[*_`>]/g, "")
    .replace(/\|\|/g, "｜")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalizeReadableXLayout(clean);
};

/** 兼容旧命名：去掉 / 转换 markdown 标记，保留人能阅读的纯文本。 */
export const stripMarkdown = prepareTextForXPublish;

/**
 * 把一段超长文本按句末标点切成 ≤ maxChars 的 chunk。
 * 中文 / 英文混排友好；当一个"句子"本身就 > maxChars 时，做硬切（避免死循环）。
 */
export const splitToChunks = (text: string, maxChars: number): string[] => {
  if (maxChars <= 0) throw new Error(`splitToChunks: maxChars must be > 0, got ${maxChars}`);
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (tweetLength(trimmed) <= maxChars) return [trimmed];

  const chunks: string[] = [];
  // 按句末标点分段；保留分隔符
  const sentences = trimmed
    .split(/(?<=[。！？!?\n.])\s*/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let current = "";
  for (const sentence of sentences) {
    if (tweetLength(sentence) > maxChars) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      // 单个句子超限 → 按加权长度硬切
      const cps = Array.from(sentence);
      let piece = "";
      for (const cp of cps) {
        if (tweetLength(piece + cp) > maxChars) {
          if (piece.length > 0) chunks.push(piece);
          piece = cp;
        } else {
          piece += cp;
        }
      }
      if (piece.length > 0) chunks.push(piece);
      continue;
    }
    const candidate = current.length === 0 ? sentence : `${current} ${sentence}`;
    if (tweetLength(candidate) > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

/**
 * Article markdown → 单条 X 长文（不拆 thread）。
 * 去掉 markdown 后按 X 加权长度截断到 maxChars。
 */
export const articleToLongPost = (article: string, opts: ArticleToLongPostOptions = {}): string => {
  const maxChars = opts.maxChars ?? DEFAULT_LONG_POST_MAX_CHARS;
  const clean = stripMarkdown(article).trim();
  if (clean.length === 0) return "";
  return truncateToWeightedLength(clean, maxChars);
};

/**
 * Article markdown → 适合发 X 的 string[]（串推模式）。
 *
 * 步骤：
 *  1. stripMarkdown
 *  2. 按空行分段，过滤极短段（< 11 字符）
 *  3. 每段 > maxChars 时切成多个 chunk
 *  4. 去重（基于前 30 字符 lowercase 头），cap 到 maxTweets
 *  5. 可选给每条加 ① 编号
 */
export const articleToThread = (article: string, opts: ArticleToThreadOptions = {}): string[] => {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxTweets = opts.maxTweets ?? DEFAULT_MAX_TWEETS;
  const numbering = opts.numbering ?? false;

  const clean = stripMarkdown(article);
  const paragraphs = clean
    .split(/\n\n+/u)
    .map((s) => s.trim())
    .filter((s) => tweetLength(s) > 10);

  if (paragraphs.length === 0) {
    const head = Array.from(clean).slice(0, maxChars).join("");
    return head.length === 0 ? [] : [head];
  }

  // fromSplit=true 的 draft 来自同一段的硬切，开头会重复——这种**不**参与去重，
  // 否则会被误删（旧 publish-to-x.ts 的真实 bug）。
  type Draft = { text: string; fromSplit: boolean };
  const drafts: Draft[] = [];
  for (const paragraph of paragraphs) {
    if (tweetLength(paragraph) <= maxChars) {
      drafts.push({ text: paragraph, fromSplit: false });
    } else {
      const chunks = splitToChunks(paragraph, maxChars);
      for (const c of chunks) drafts.push({ text: c, fromSplit: true });
    }
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const d of drafts) {
    if (!d.fromSplit) {
      const key = d.text.toLowerCase().slice(0, 30);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    deduped.push(d.text);
    if (deduped.length >= maxTweets) break;
  }

  if (!numbering) return deduped;

  return deduped.map((t, i) => {
    const prefix = `${threadNumber(i)} `;
    const room = maxChars - tweetLength(prefix);
    const truncated = truncateToWeightedLength(t, room);
    return `${prefix}${truncated}`;
  });
};
