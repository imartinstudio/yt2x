import type { GeneratedShortPost } from "../short/types.js";
import type { GeneratedThread } from "../thread/types.js";

const COLON_TITLE_RE = /^(.{1,48}[：:])\s*(.*)$/u;
const THREAD_ITEM_START_RE = /^[ \t]*\d+\/(?:\d+)?(?:[ \t]|$)/u;

const stripThreadPositionMarker = (line: string): string =>
  line.replace(/^[ \t]*\d+\/(?:\d+)?[ \t]*/u, "");
const ORDERED_STEP_RE = /^[ \t]*(\d+)[.)／/][ \t]*(.*)$/u;
const CIRCLED_STEP_RE = /^[ \t]*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])[ \t]*(.*)$/u;
const BULLET_RE = /^[ \t]*[-*+•●○◦·][ \t]+(.*)$/u;
const LONE_NUMBER_RE = /^[ \t]*(\d+)[ \t]*$/u;
const LIST_ITEM_CONTINUATION_INDENT = "   ";
const SECTION_TITLE_ONLY_RE = /^(.{1,48}[：:])\s*$/u;
const SECTION_WITH_EMBEDDED_NUM_RE = /^(.+?)\s+(\d+)[：:]\s*(.*)$/u;
const LABELED_SUB_ITEM_RE = /^(.{1,24}?)\s+(\d+)[：:]\s*(.*)$/u;

const deriveSubLabelPrefix = (sectionTitle: string): string => {
  const bare = sectionTitle.replace(/[：:]\s*$/u, "").trim();
  const trimmed = bare.replace(/^(?:未来|关键|核心|主要|三个|几个|若干|多个)/u, "");
  return trimmed.length >= 2 ? trimmed : bare;
};

const isLabeledSubItemLine = (line: string): boolean => LABELED_SUB_ITEM_RE.test(line.trim());

type NumberedSubsectionGroup = { num: string; contentLines: string[] };

const parseColonSectionTitle = (
  line: string,
): { title: string; firstGroup?: NumberedSubsectionGroup } | null => {
  const trimmed = line.trim();

  const embedded = trimmed.match(SECTION_WITH_EMBEDDED_NUM_RE);
  if (embedded !== null) {
    const title = `${embedded[1]!.replace(/[：:]\s*$/u, "").trim()}：`;
    const bodyLines = embedded[3]!.trim().length > 0 ? [embedded[3]!.trim()] : [];
    return { title, firstGroup: { num: embedded[2]!, contentLines: bodyLines } };
  }

  const only = trimmed.match(SECTION_TITLE_ONLY_RE);
  if (only !== null) return { title: only[1]! };

  return null;
};

const parseNumberedSubsectionGroups = (lines: string[]): NumberedSubsectionGroup[] | null => {
  const groups: NumberedSubsectionGroup[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const lone = line.match(LONE_NUMBER_RE);
    if (lone !== null) {
      const contentLines: string[] = [];
      i += 1;
      while (i < lines.length && !LONE_NUMBER_RE.test(lines[i]!) && !isLabeledSubItemLine(lines[i]!)) {
        contentLines.push(lines[i]!);
        i += 1;
      }
      groups.push({ num: lone[1]!, contentLines });
      continue;
    }

    const labeled = line.trim().match(LABELED_SUB_ITEM_RE);
    if (labeled !== null) {
      const contentLines: string[] = [];
      if (labeled[3]!.trim().length > 0) contentLines.push(labeled[3]!.trim());
      i += 1;
      while (i < lines.length && !LONE_NUMBER_RE.test(lines[i]!) && !isLabeledSubItemLine(lines[i]!)) {
        contentLines.push(lines[i]!);
        i += 1;
      }
      groups.push({ num: labeled[2]!, contentLines });
      continue;
    }

    return null;
  }

  return groups.length > 0 ? groups : null;
};

const formatNumberedSubsectionItem = (prefix: string, num: string, contentLines: string[]): string => {
  const label = `${prefix} ${num}：`;
  const content = joinProseLines(contentLines).trim();
  return content.length > 0 ? `${label}${content}` : label;
};

/** 章节标题 + 数字子项 →「未来预测：/ 预测 1：正文」同结构，章节标题只出现一次。 */
const tryFormatNumberedSubsectionBlock = (lines: string[]): string | null => {
  if (lines.length === 0) return null;

  const section = parseColonSectionTitle(lines[0]!);
  if (section === null) return null;

  const prefix = deriveSubLabelPrefix(section.title);
  const bare = section.title.replace(/[：:]\s*$/u, "").trim();
  if (prefix === bare && bare.length > 8) return null;

  let rest = lines.slice(1);
  const groups: NumberedSubsectionGroup[] = [];
  if (section.firstGroup !== undefined) groups.push(section.firstGroup);

  let restStart = 0;
  if (groups.length > 0 && groups[0]!.contentLines.length === 0) {
    while (
      restStart < rest.length &&
      !LONE_NUMBER_RE.test(rest[restStart]!) &&
      !isLabeledSubItemLine(rest[restStart]!)
    ) {
      groups[0]!.contentLines.push(rest[restStart]!);
      restStart += 1;
    }
  }

  const parsed = parseNumberedSubsectionGroups(rest.slice(restStart));
  if (parsed === null && groups.length === 0) return null;
  if (parsed !== null) groups.push(...parsed);
  if (groups.length === 0) return null;

  const chunks: string[] = [section.title];
  for (const group of groups) {
    chunks.push("", formatNumberedSubsectionItem(prefix, group.num, group.contentLines));
  }

  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

const mergeNumberedSubsectionBlocks = (blocks: string[][]): string[][] => {
  const merged: string[][] = [];
  for (const block of blocks) {
    const section = parseColonSectionTitle(block[0] ?? "");
    if (section !== null && merged.length > 0) {
      const previous = merged[merged.length - 1]!;
      const previousSection = parseColonSectionTitle(previous[0] ?? "");
      if (previousSection?.title === section.title) {
        merged[merged.length - 1] = [...previous, ...block.slice(1)];
        continue;
      }
    }
    merged.push(block);
  }
  return merged;
};

/** 把「**标题：**正文」从同一行拆开，避免 `2/8 **标题：**正文` 在预览里加粗失效。 */
const reflowInlineBoldColonTitles = (text: string): string =>
  text
    .split("\n")
    .flatMap((line) => {
      const markerMatch = line.match(/^(\d+\/\d+\s+)(.*)$/u);
      const markerPrefix = markerMatch?.[1] ?? "";
      const content = markerMatch?.[2] ?? line;

      const inlineLabeled = content.match(LABELED_SUB_ITEM_RE);
      if (inlineLabeled !== null && inlineLabeled[3]!.trim().length > 0) {
        return [line];
      }

      const alreadyBold = content.match(/^\*\*(.{1,48}[：:])\*\*\s*(.+)$/u);
      if (alreadyBold !== null && alreadyBold[2]!.trim().length > 0) {
        return [`${markerPrefix}**${alreadyBold[1]!}**`, "", alreadyBold[2]!.trim()];
      }

      const plainColon = content.match(COLON_TITLE_RE);
      if (plainColon !== null && plainColon[2]!.trim().length > 0 && !content.startsWith("**")) {
        return [`${markerPrefix}**${plainColon[1]!}**`, "", plainColon[2]!.trim()];
      }

      return [line];
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

const formatColonTitleLines = (line: string): string[] => {
  const alreadyBold = line.match(/^\*\*(.{1,48}[：:])\*\*\s*(.*)$/u);
  if (alreadyBold !== null) {
    const titleLine = `**${alreadyBold[1]!}**`;
    const body = alreadyBold[2]!.trim();
    if (body.length === 0) return [titleLine];
    return [titleLine, "", body];
  }

  const match = line.match(COLON_TITLE_RE);
  if (match === null) return [line];
  const title = match[1]!;
  const body = match[2]!.trim();
  const titleLine = `**${title}**`;
  if (body.length === 0) return [titleLine];
  return [titleLine, "", body];
};

const isParallelListCandidate = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (BULLET_RE.test(line)) return true;
  if (ORDERED_STEP_RE.test(line)) return true;
  if (CIRCLED_STEP_RE.test(line)) return true;
  if (LONE_NUMBER_RE.test(line)) return true;
  const colonIdx = trimmed.search(/[：:]/u);
  if (colonIdx <= 0 || colonIdx > 20) return false;
  const body = trimmed.slice(colonIdx + 1).trim();
  return body.length > 0 && body.length <= 80;
};

const formatBulletLine = (line: string): string => {
  const bullet = line.match(BULLET_RE);
  if (bullet !== null) {
    const inner = bullet[1]!.trim();
    const colon = inner.match(COLON_TITLE_RE);
    if (colon !== null && colon[2]!.trim().length > 0) {
      return `- **${colon[1]!}**\n\n${LIST_ITEM_CONTINUATION_INDENT}${colon[2]!.trim()}`;
    }
    return `- ${inner}`;
  }

  const ordered = line.match(ORDERED_STEP_RE);
  if (ordered !== null) {
    const body = ordered[2]!.trim();
    if (body.length === 0) return `${ordered[1]}.`;
    const colon = body.match(COLON_TITLE_RE);
    if (colon !== null && colon[2]!.trim().length > 0) {
      return `${ordered[1]}. **${colon[1]!}**\n\n${LIST_ITEM_CONTINUATION_INDENT}${colon[2]!.trim()}`;
    }
    return `${ordered[1]}. ${body}`;
  }

  const circled = line.match(CIRCLED_STEP_RE);
  if (circled !== null) {
    const body = circled[2]!.trim();
    if (body.length === 0) return circled[1]!;
    const colon = body.match(COLON_TITLE_RE);
    if (colon !== null && colon[2]!.trim().length > 0) {
      return `- **${colon[1]!}**\n\n${LIST_ITEM_CONTINUATION_INDENT}${colon[2]!.trim()}`;
    }
    return `- ${body}`;
  }

  const colon = line.match(COLON_TITLE_RE);
  if (colon !== null) {
    const body = colon[2]!.trim();
    if (body.length === 0) return `- **${colon[1]!}**`;
    return `- **${colon[1]!}**\n\n${LIST_ITEM_CONTINUATION_INDENT}${body}`;
  }

  return `- ${line.trim()}`;
};

const joinProseLines = (lines: string[]): string => {
  if (lines.length === 0) return "";
  if (lines.length === 1) return lines[0]!;
  return lines.map((line) => line.trimEnd()).join("  \n");
};

const formatLineGroup = (lines: string[]): string => {
  const nonEmpty = lines.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return "";
  if (nonEmpty.length === 1) return formatColonTitleLines(nonEmpty[0]!).join("\n").trim();

  const firstColon = nonEmpty[0]!.match(COLON_TITLE_RE);
  if (firstColon !== null && firstColon[2]!.trim().length === 0) {
    const header = formatColonTitleLines(nonEmpty[0]!);
    const bodyLines = nonEmpty.slice(1);
    const listishBody = bodyLines.filter(isParallelListCandidate);
    if (bodyLines.length >= 2 && listishBody.length >= 2) {
      return [...header, "", bodyLines.map(formatBulletLine).join("\n")].join("\n").trim();
    }
    if (bodyLines.every((line) => !isParallelListCandidate(line))) {
      return [...header, "", joinProseLines(bodyLines)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }
  }

  const listishLines = nonEmpty.filter(isParallelListCandidate);
  const colonHeavy =
    nonEmpty.length >= 2 &&
    nonEmpty.filter((line) => {
      const idx = line.search(/[：:]/u);
      return idx > 0 && idx <= 20;
    }).length >= 2;
  if (colonHeavy) {
    return nonEmpty.map((line) => formatBulletLine(line)).join("\n");
  }

  const firstBody = nonEmpty[0]!.match(COLON_TITLE_RE)?.[2]?.trim() ?? "";
  const hasSectionTitle = COLON_TITLE_RE.test(nonEmpty[0]!) && firstBody.length > 0;

  if (hasSectionTitle && listishLines.length >= 2 && listishLines.length === nonEmpty.length - 1) {
    const header = formatColonTitleLines(nonEmpty[0]!);
    return [...header, "", nonEmpty.slice(1).map(formatBulletLine).join("\n")].join("\n").trim();
  }

  if (nonEmpty.length >= 2 && listishLines.length >= 2 && listishLines.length === nonEmpty.length) {
    return nonEmpty.map(formatBulletLine).join("\n");
  }

  if (nonEmpty.every((line) => !isParallelListCandidate(line))) {
    return joinProseLines(nonEmpty);
  }

  const [first, ...rest] = nonEmpty;
  const firstFormatted = formatColonTitleLines(first!);
  const prose: string[] = [];
  const listish: string[] = [];

  for (const line of rest) {
    if (isParallelListCandidate(line)) listish.push(line);
    else prose.push(line);
  }

  const chunks: string[] = [...firstFormatted];
  if (prose.length > 0) {
    if (chunks.at(-1) === "") chunks.pop();
    chunks.push("", joinProseLines(prose));
  }
  if (listish.length > 0) {
    if (chunks.length > 0 && chunks.at(-1) !== "") chunks.push("");
    chunks.push(listish.map(formatBulletLine).join("\n"));
  }
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

const mergeLoneNumberLines = (lines: string[]): string[] => {
  const merged: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lone = line.match(LONE_NUMBER_RE);
    if (lone !== null && i + 1 < lines.length) {
      merged.push(`${lone[1]}. ${lines[i + 1]!.trim()}`);
      i += 1;
      continue;
    }
    merged.push(line);
  }
  return merged;
};

/** 将纯文本正文格式化为可在 Markdown 预览中正确换行、列表与冒号标题的文本。 */
export const formatXContentBody = (text: string): string => {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return "";

  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of normalized.split("\n")) {
    if (line.trim().length === 0) {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);

  return mergeNumberedSubsectionBlocks(blocks)
    .map((block) => tryFormatNumberedSubsectionBlock(block) ?? formatLineGroup(mergeLoneNumberLines(block)))
    .filter((block) => block.length > 0)
    .join("\n\n");
};

/** 单条串推 tweet 行首使用「当前序号/总数」标记，不用 Markdown 列表。 */
export const formatXTweetMarkdownItem = (index: number, total: number, tweet: string): string => {
  const marker = `${index}/${total}`;
  const body = formatXContentBody(tweet.trim());
  if (body.length === 0) return marker;
  const lines = body.split("\n");
  lines[0] = `${marker} ${lines[0]}`;
  return reflowInlineBoldColonTitles(lines.join("\n"));
};

export const renderXThreadMarkdown = (thread: GeneratedThread): string => {
  const total = thread.tweets.length;
  const items = thread.tweets.map((tweet, index) => formatXTweetMarkdownItem(index + 1, total, tweet));
  return `${items.join("\n\n")}\n`;
};

export const renderXShortMarkdown = (shortPost: GeneratedShortPost): string =>
  `${formatXContentBody(shortPost.text.trim())}\n`;

/** 将已有 x-thread.md 的 thread 前缀规范为「序号/总数」，不改动 tweet 正文。 */
export const normalizeXThreadMarkdown = (raw: string): string => {
  const tweets = parseGeneratedThreadMarkdown(raw);
  if (tweets.length === 0) return raw.trimEnd() + (raw.endsWith("\n") ? "\n" : "");
  const total = tweets.length;
  const items = tweets.map((tweet, index) => {
    const marker = `${index + 1}/${total}`;
    const body = tweet.trim();
    if (body.length === 0) return marker;
    const lines = body.split("\n");
    lines[0] = `${marker} ${lines[0]}`;
    return reflowInlineBoldColonTitles(lines.join("\n"));
  });
  return `${items.join("\n\n")}\n`;
};

/** 读取 x-thread.md 时按行首「序号/总数」或兼容旧 1/ 标记切分 tweet。 */
export const parseGeneratedThreadMarkdown = (raw: string): string[] => {
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ") && current.length === 0) continue;

    if (THREAD_ITEM_START_RE.test(line)) {
      if (current.length > 0) blocks.push(current.join("\n").trim());
      current = [stripThreadPositionMarker(line).trimStart()];
      continue;
    }

    if (current.length > 0) current.push(line);
  }

  if (current.length > 0) blocks.push(current.join("\n").trim());
  if (blocks.length > 0) return blocks;

  return raw
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith("# "));
};
