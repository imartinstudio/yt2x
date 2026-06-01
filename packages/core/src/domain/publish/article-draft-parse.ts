import {
  ArticleDraftParseResultSchema,
  type ArticleDraftParseResult,
} from "./article-draft.js";

export const IMAGE_MARKDOWN_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)$/u;
export const VIDEO_MARKDOWN_RE =
  /^<video\b[^>]*\bsrc=["']([^"']+)["'][^>]*>(?:<\/video>)?$/iu;

export type ArticleDraftSplitBlock = {
  kind: "markdown" | "image" | "video" | "code" | "divider";
  source: string;
};

type DraftBlock = ArticleDraftSplitBlock;

export type ParseArticleDraftOptions = {
  resolveMediaPath: (source: string) => string;
  fallbackCoverImage?: string | null;
  /** Keep author-provided blocks intact for interactive Markdown imports. */
  preserveSourceContent?: boolean;
  /** Render dividers and fenced code through native X editor actions while keeping author text. */
  useNativeEditorBlocks?: boolean;
  /** Omit Markdown divider blocks when the destination editor should not render them. */
  omitDividers?: boolean;
};

export const parseArticleDraftFromMarkdown = (
  markdown: string,
  options: ParseArticleDraftOptions,
): ArticleDraftParseResult => {
  const preserveSourceContent = options.preserveSourceContent === true;
  const useNativeEditorBlocks = options.useNativeEditorBlocks === true;
  const { title, body } = extractArticleTitle(markdown, { preserveSourceContent });
  const splitBlocks = splitDraftBlocks(body);
  const blocks =
    preserveSourceContent && !useNativeEditorBlocks
      ? splitBlocks
      : ensureHeadingDividers(splitBlocks);
  const contentBlocks: string[] = [];
  const images: ArticleDraftParseResult["contentImages"] = [];
  const contentVideos: ArticleDraftParseResult["contentVideos"] = [];
  const contentCodeBlocks: ArticleDraftParseResult["contentCodeBlocks"] = [];
  const dividers: ArticleDraftParseResult["dividers"] = [];
  let lastAnchorText = "";

  for (const block of blocks) {
    if (block.kind === "divider") {
      if (options.omitDividers === true) continue;
      if (preserveSourceContent && !useNativeEditorBlocks) {
        contentBlocks.push(block.source);
        lastAnchorText = "---";
        continue;
      }
      dividers.push({
        blockIndex: contentBlocks.length,
        afterText: lastAnchorText,
      });
      continue;
    }
    if (block.kind === "image") {
      const match = IMAGE_MARKDOWN_RE.exec(block.source.trim());
      if (match !== null) {
        images.push({
          path: options.resolveMediaPath(match[2]!),
          alt: match[1]!,
          blockIndex: contentBlocks.length,
          afterText: lastAnchorText,
        });
        continue;
      }
    }
    if (block.kind === "video") {
      const match = VIDEO_MARKDOWN_RE.exec(block.source.trim());
      if (match !== null) {
        contentVideos.push({
          path: options.resolveMediaPath(match[1]!),
          alt: "",
          blockIndex: contentBlocks.length,
          afterText: lastAnchorText,
        });
        continue;
      }
    }
    if (block.kind === "code") {
      const codeBlock = parseCodeBlock(block.source);
      if (preserveSourceContent && !useNativeEditorBlocks) {
        contentBlocks.push(block.source);
        lastAnchorText = codeAnchorText(codeBlock.code);
        continue;
      }
      if (!preserveSourceContent && isPromptArtifactCode(codeBlock.code)) continue;
      contentCodeBlocks.push({
        ...codeBlock,
        blockIndex: contentBlocks.length,
        afterText: lastAnchorText,
      });
      lastAnchorText = codeAnchorText(codeBlock.code);
      continue;
    }
    if (block.kind === "markdown") {
      if (!preserveSourceContent && isDuplicateFooterMarkdown(block.source)) {
        if (contentBlocks.some((existing) => isDuplicateFooterMarkdown(existing))) continue;
      }
      const trimmed = preserveSourceContent ? block.source.trim() : trimEnglishLeadFromMarkdownBlock(block.source);
      if (trimmed.length === 0 || (!preserveSourceContent && isEnglishOnlyMarkdownBlock(trimmed))) continue;
      contentBlocks.push(trimmed);
      lastAnchorText = afterText(trimmed);
      continue;
    }
    contentBlocks.push(block.source);
    lastAnchorText = afterText(block.source);
  }

  const [cover, ...contentImages] = images;
  const coverPath = cover?.path ?? options.fallbackCoverImage ?? null;
  const dedupedMedia = dedupeContentMedia(contentImages, contentVideos, coverPath);
  const htmlBlocks = contentBlocks.map(renderMarkdownBlock).filter(Boolean);
  return ArticleDraftParseResultSchema.parse({
    title,
    coverImage: coverPath,
    contentImages: dedupedMedia.images,
    contentVideos: dedupedMedia.videos,
    contentCodeBlocks,
    dividers,
    html: htmlBlocks.join(""),
    htmlBlocks,
    totalBlocks: contentBlocks.length,
  });
};

export const isLocalMediaReference = (source: string): boolean => {
  const trimmed = source.trim();
  if (trimmed.length === 0) return false;
  if (/^(?:https?:|data:|blob:)/iu.test(trimmed)) return false;
  if (/^\/\//u.test(trimmed)) return false;
  return true;
};

export const collectLocalMediaReferences = (markdown: string): string[] => {
  const refs = new Set<string>();
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const trimmed = line.trim();
    const image = IMAGE_MARKDOWN_RE.exec(trimmed);
    if (image !== null && isLocalMediaReference(image[2]!)) {
      refs.add(image[2]!);
      continue;
    }
    const video = VIDEO_MARKDOWN_RE.exec(trimmed);
    if (video !== null && isLocalMediaReference(video[1]!)) refs.add(video[1]!);
  }
  return [...refs];
};

const cjkCharRatio = (text: string): number => {
  const chars = [...text.replace(/\s/gu, "")];
  if (chars.length === 0) return 0;
  const cjk = chars.filter((char) => /\p{Script=Han}/u.test(char)).length;
  return cjk / chars.length;
};

const PROMPT_ARTIFACT_RE =
  /(?:GitHub repository|Summarize everything|Is there anything else|Create a new|Create a playable|Create a mobile responsive|standard move of the cube|Rubik's Cube with Tic|Check if I have Git|Git installed|install it for me|install it for me\.Check|Run a security check)/iu;

const isUnusableTitleLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("![")) return true;
  if (trimmed.startsWith("```")) return true;
  if (trimmed.startsWith("<video")) return true;
  if (PROMPT_ARTIFACT_RE.test(trimmed)) return true;
  if (cjkCharRatio(trimmed) < 0.04 && trimmed.length >= 12) return true;
  return false;
};

export const extractArticleTitle = (
  markdown: string,
  options: { preserveSourceContent?: boolean } = {},
): { title: string; body: string } => {
  const lines = markdown.replaceAll("\r\n", "\n").trim().split("\n");
  const prepareBody = (body: string): string =>
    options.preserveSourceContent === true ? body : stripLeadingArticleBoilerplate(body);

  for (let index = 0; index < lines.length; index += 1) {
    const h1 = /^#\s+(.+)$/u.exec(lines[index]!.trim());
    if (h1 === null) continue;
    const bodyLines = [...lines];
    bodyLines.splice(index, 1);
    return {
      title: stripInlineMarkdown(h1[1]!),
      body: prepareBody(bodyLines.join("\n")),
    };
  }

  for (let index = 0; index < lines.length; index += 1) {
    const h2 = /^##\s+(.+)$/u.exec(lines[index]!.trim());
    if (h2 === null) continue;
    const candidate = stripInlineMarkdown(h2[1]!);
    if (isUnusableTitleLine(candidate)) continue;
    return {
      title: candidate.slice(0, 100),
      body: prepareBody(lines.join("\n")),
    };
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (isUnusableTitleLine(line)) continue;
    return {
      title: stripInlineMarkdown(line).slice(0, 100),
      body: prepareBody(lines.join("\n")),
    };
  }

  return { title: "Untitled", body: prepareBody(lines.join("\n")) };
};

export const isEnglishOnlyMarkdownBlock = (source: string): boolean => {
  const trimmed = source.trim();
  if (trimmed.length < 12) return false;
  if (cjkCharRatio(trimmed) >= 0.04) return false;
  if (/^#{1,6}\s+/u.test(trimmed)) return false;
  if (IMAGE_MARKDOWN_RE.test(trimmed) || VIDEO_MARKDOWN_RE.test(trimmed)) return false;
  return PROMPT_ARTIFACT_RE.test(trimmed);
};

const trimEnglishLeadFromMarkdownBlock = (source: string): string => {
  const trimmed = source.trim();
  if (/^#{1,6}\s+/u.test(trimmed)) return source;
  const match = /\p{Script=Han}/u.exec(source);
  if (match === null || match.index === undefined || match.index === 0) return source;
  const lead = source.slice(0, match.index);
  if (cjkCharRatio(lead) >= 0.03) return source;
  return source.slice(match.index).trimStart();
};

export const dedupeContentMedia = (
  contentImages: ArticleDraftParseResult["contentImages"],
  contentVideos: ArticleDraftParseResult["contentVideos"],
  coverImage: string | null,
): {
  images: ArticleDraftParseResult["contentImages"];
  videos: ArticleDraftParseResult["contentVideos"];
} => {
  const images: ArticleDraftParseResult["contentImages"] = [];
  const videos: ArticleDraftParseResult["contentVideos"] = [];
  const seen = new Map<
    string,
    { item: ArticleDraftParseResult["contentImages"][number]; kind: "image" | "video" }
  >();

  const remember = (
    item: ArticleDraftParseResult["contentImages"][number],
    kind: "image" | "video",
  ): void => {
    if (coverImage !== null && item.path === coverImage) return;
    const existing = seen.get(item.path);
    if (existing === undefined || item.blockIndex < existing.item.blockIndex) {
      seen.set(item.path, { item, kind });
    }
  };

  for (const item of contentImages) remember(item, "image");
  for (const item of contentVideos) remember(item, "video");

  for (const entry of seen.values()) {
    if (entry.kind === "video") videos.push(entry.item);
    else images.push(entry.item);
  }

  return { images, videos };
};

const isDuplicateFooterMarkdown = (source: string): boolean =>
  /可复制提示词|👇\s*完整视频|完整视频：/iu.test(source.trim());

export const isPromptArtifactCode = (code: string): boolean => {
  const trimmed = code.trim();
  if (trimmed.length < 12) return false;
  if (cjkCharRatio(trimmed) >= 0.04) return false;
  return PROMPT_ARTIFACT_RE.test(trimmed);
};

const stripLeadingLowCjkCodeFences = (body: string): string => {
  let output = body.trimStart();
  while (output.startsWith("```")) {
    const closeIndex = output.indexOf("\n```");
    if (closeIndex < 0) break;
    const inner = output.slice(output.indexOf("\n") + 1, closeIndex);
    if (cjkCharRatio(inner) >= 0.04 && !PROMPT_ARTIFACT_RE.test(inner)) break;
    output = output.slice(closeIndex + 4).trimStart();
  }
  return output;
};

/** Drop English prompt leftovers before the first Chinese paragraph (keeps cover images and H2 sections). */
export const stripLeadingArticleBoilerplate = (body: string): string => {
  let result = body.replaceAll("\r\n", "\n");
  result = stripLeadingLowCjkCodeFences(result);

  const lines = result.split("\n");
  let start = 0;
  while (start < lines.length) {
    const trimmed = lines[start]!.trim();
    if (
      trimmed.length === 0 ||
      IMAGE_MARKDOWN_RE.test(trimmed) ||
      VIDEO_MARKDOWN_RE.test(trimmed) ||
      (trimmed.startsWith(">") && /mermaid diagram requires/i.test(trimmed))
    ) {
      start += 1;
      continue;
    }
    break;
  }

  let firstCjkIndex = -1;
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith(">") && /mermaid diagram requires/i.test(trimmed)) continue;
    if (/^##\s+/u.test(trimmed)) break;
    if (firstCjkIndex < 0 && cjkCharRatio(trimmed) >= 0.06 && trimmed.length >= 8) {
      firstCjkIndex = index;
      break;
    }
  }

  if (firstCjkIndex > start) {
    const between = lines.slice(start, firstCjkIndex).map((line) => line.trim()).filter(Boolean);
    const removable = between.every(
      (line) =>
        !/^##\s+/u.test(line) &&
        !IMAGE_MARKDOWN_RE.test(line) &&
        !VIDEO_MARKDOWN_RE.test(line) &&
        (line.startsWith(">") || cjkCharRatio(line) < 0.03),
    );
    if (removable && between.length > 0) {
      result = [...lines.slice(0, start), ...lines.slice(firstCjkIndex)].join("\n").trim();
    }
  }

  return result;
};

const splitDraftBlocks = (markdown: string): DraftBlock[] => {
  const blocks: DraftBlock[] = [];
  let current: string[] = [];
  let fenced: string[] | null = null;
  const isListLine = (line: string): boolean => /^(?:[-*]\s+|\d+\.\s+)/u.test(line.trim());
  const flush = (): void => {
    if (current.length === 0) return;
    const source = current.join("\n").trim();
    if (source.length > 0) blocks.push({ kind: classifyBlock(source), source });
    current = [];
  };

  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flush();
      if (fenced === null) {
        fenced = [line];
      } else {
        fenced.push(line);
        blocks.push({ kind: "code", source: fenced.join("\n") });
        fenced = null;
      }
      continue;
    }
    if (fenced !== null) {
      fenced.push(line);
      continue;
    }
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    if (/^---+$/u.test(trimmed)) {
      flush();
      blocks.push({ kind: "divider", source: line });
      continue;
    }
    if (/^#{1,6}\s+/u.test(trimmed) || trimmed.startsWith(">")) {
      flush();
      blocks.push({ kind: classifyBlock(trimmed), source: trimmed });
      continue;
    }
    if (IMAGE_MARKDOWN_RE.test(trimmed)) {
      flush();
      blocks.push({ kind: "image", source: trimmed });
      continue;
    }
    if (VIDEO_MARKDOWN_RE.test(trimmed)) {
      flush();
      blocks.push({ kind: "video", source: trimmed });
      continue;
    }
    if (current.length > 0 && isListLine(trimmed) !== current.every((item) => isListLine(item))) {
      flush();
    }
    current.push(line);
  }
  if (fenced !== null) {
    blocks.push({ kind: "code", source: fenced.join("\n") });
  }
  flush();
  return blocks;
};

const classifyBlock = (source: string): DraftBlock["kind"] => {
  if (/^```/u.test(source)) return "code";
  if (IMAGE_MARKDOWN_RE.test(source)) return "image";
  if (VIDEO_MARKDOWN_RE.test(source)) return "video";
  return "markdown";
};

export const splitArticleDraftBlocks = (
  markdown: string,
  options: { preserveSourceContent?: boolean } = {},
): ArticleDraftSplitBlock[] => {
  const { body } = extractArticleTitle(markdown, {
    preserveSourceContent: options.preserveSourceContent === true,
  });
  return splitDraftBlocks(body);
};

export const parseFencedCodeBlock = (source: string): { code: string; language: string } =>
  parseCodeBlock(source);

const parseCodeBlock = (source: string): { code: string; language: string } => {
  const opener = /^```([^\n]*)\n?/u.exec(source);
  const language = opener?.[1]?.trim() ?? "";
  const withoutOpening = source.replace(/^```[^\n]*\n?/u, "");
  return {
    code: withoutOpening.replace(/\n?```$/u, ""),
    language,
  };
};

const codeAnchorText = (code: string): string =>
  code
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 80) ?? "";

const ensureHeadingDividers = (blocks: DraftBlock[]): DraftBlock[] => {
  const withDividers: DraftBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    withDividers.push(block);
    if (block.kind !== "markdown" || !/^##\s+/u.test(block.source.trim())) continue;
    if (blocks[index + 1]?.kind === "divider") continue;
    withDividers.push({ kind: "divider", source: "---" });
  }
  return withDividers;
};

const afterText = (block: string | undefined): string =>
  block === undefined
    ? ""
    : stripInlineMarkdown(
        block
          .split("\n")
          .filter((line) => line.trim().length > 0 && !line.trim().startsWith("```"))
          .at(-1) ?? "",
      ).slice(0, 80);

export const renderMarkdownBlock = (block: string): string => {
  const trimmed = block.trim();
  if (trimmed.length === 0) return "";
  if (/^---+$/u.test(trimmed)) return "<hr>";
  if (/^```/u.test(trimmed)) {
    const codeBlock = parseCodeBlock(trimmed);
    return `<pre><code>${escapeHtml(codeBlock.code)}</code></pre>`;
  }
  const heading = /^(#{2,6})\s+(.+)$/u.exec(trimmed);
  if (heading !== null) {
    const level = Math.min(heading[1]!.length, 6);
    return `<h${level}>${renderInline(heading[2]!)}</h${level}>`;
  }
  if (trimmed.split("\n").every((line) => line.trim().startsWith(">"))) {
    const quote = trimmed
      .split("\n")
      .map((line) => line.trim().replace(/^>\s?/u, ""))
      .join("<br>");
    return `<blockquote>${renderInline(quote)}</blockquote>`;
  }
  if (isTableBlock(trimmed)) return renderTable(trimmed);
  if (trimmed.split("\n").every((line) => /^\s*[-*]\s+/u.test(line))) {
    return `<ul>${trimmed
      .split("\n")
      .map((line) => `<li>${renderInline(line.replace(/^\s*[-*]\s+/u, ""))}</li>`)
      .join("")}</ul>`;
  }
  if (trimmed.split("\n").every((line) => /^\s*\d+\.\s+/u.test(line))) {
    return `<ol>${trimmed
      .split("\n")
      .map((line) => `<li>${renderInline(line.replace(/^\s*\d+\.\s+/u, ""))}</li>`)
      .join("")}</ol>`;
  }
  return `<p>${trimmed
    .split("\n")
    .map((line) => renderInline(line.trim()))
    .join("<br>")}</p>`;
};

const isTableBlock = (block: string): boolean => {
  const lines = block.split("\n").map((line) => line.trim());
  return lines.length >= 2 && lines.every((line) => line.startsWith("|") && line.endsWith("|"));
};

const renderTable = (block: string): string => {
  const rows = block
    .split("\n")
    .map((line) => tableCells(line))
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/u.test(cell)));
  if (rows.length === 0) return "";
  const [head, ...body] = rows;
  return `<table><thead><tr>${head!.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${body
    .map((cells) => `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
};

const tableCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => cell.trim());

const renderInline = (value: string): string =>
  escapeHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gu, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/__([^_]+)__/gu, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/gu, "$1<em>$2</em>")
    .replace(/`([^`]+)`/gu, "<code>$1</code>");

const stripInlineMarkdown = (value: string): string =>
  value
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[*_`>#]/gu, "")
    .trim();

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
