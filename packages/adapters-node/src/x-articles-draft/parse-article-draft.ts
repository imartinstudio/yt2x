import { stat } from "node:fs/promises";
import path from "node:path";
import { ArticleDraftParseResultSchema, type ArticleDraftParseResult } from "@yt2x/core";

type DraftBlock = {
  kind: "markdown" | "image" | "divider";
  source: string;
};

const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)$/u;

export const parseArticleDraftMarkdown = (
  markdown: string,
  articleDir: string,
  fallbackCoverImage?: string | null,
): ArticleDraftParseResult => {
  const { title, body } = extractArticleTitle(markdown);
  const blocks = splitDraftBlocks(body);
  const contentBlocks: string[] = [];
  const images: ArticleDraftParseResult["contentImages"] = [];
  const dividers: ArticleDraftParseResult["dividers"] = [];

  for (const block of blocks) {
    if (block.kind === "divider") {
      dividers.push({
        blockIndex: contentBlocks.length,
        afterText: afterText(contentBlocks.at(-1)),
      });
      continue;
    }
    if (block.kind === "image") {
      const match = IMAGE_RE.exec(block.source.trim());
      if (match !== null) {
        images.push({
          path: resolveArticleImagePath(articleDir, match[2]!),
          alt: match[1]!,
          blockIndex: contentBlocks.length,
          afterText: afterText(contentBlocks.at(-1)),
        });
        continue;
      }
    }
    contentBlocks.push(block.source);
  }

  const [cover, ...contentImages] = images;
  return ArticleDraftParseResultSchema.parse({
    title,
    coverImage: cover?.path ?? fallbackCoverImage ?? null,
    contentImages,
    dividers,
    html: contentBlocks.map(renderMarkdownBlock).filter(Boolean).join(""),
    totalBlocks: contentBlocks.length,
  });
};

export const assertArticleDraftImagesExist = async (parsed: ArticleDraftParseResult): Promise<void> => {
  const images = [
    ...(parsed.coverImage === null ? [] : [{ role: "cover image", path: parsed.coverImage }]),
    ...parsed.contentImages.map((image) => ({ role: "content image", path: image.path })),
  ];
  for (const image of images) {
    try {
      await stat(image.path);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`X Article ${image.role} was not found: ${image.path}`);
      }
      throw err;
    }
  }
};

const extractArticleTitle = (markdown: string): { title: string; body: string } => {
  const lines = markdown.replaceAll("\r\n", "\n").trim().split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0 || line.startsWith("![")) continue;
    const h1 = /^#\s+(.+)$/u.exec(line);
    if (h1 !== null) {
      lines.splice(index, 1);
      return { title: stripInlineMarkdown(h1[1]!), body: lines.join("\n") };
    }
    const h2 = /^##\s+(.+)$/u.exec(line);
    return { title: stripInlineMarkdown(h2?.[1] ?? line).slice(0, 100), body: lines.join("\n") };
  }
  return { title: "Untitled", body: lines.join("\n") };
};

const splitDraftBlocks = (markdown: string): DraftBlock[] => {
  const blocks: DraftBlock[] = [];
  let current: string[] = [];
  let fenced: string[] | null = null;
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
        blocks.push({ kind: "markdown", source: fenced.join("\n") });
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
    if (IMAGE_RE.test(trimmed)) {
      flush();
      blocks.push({ kind: "image", source: trimmed });
      continue;
    }
    current.push(line);
  }
  if (fenced !== null) {
    blocks.push({ kind: "markdown", source: fenced.join("\n") });
  }
  flush();
  return blocks;
};

const classifyBlock = (source: string): DraftBlock["kind"] => (IMAGE_RE.test(source) ? "image" : "markdown");

const resolveArticleImagePath = (articleDir: string, source: string): string =>
  path.isAbsolute(source) ? source : path.resolve(articleDir, decodeURIComponent(source));

const afterText = (block: string | undefined): string =>
  block === undefined ? "" : stripInlineMarkdown(block.split("\n").filter(Boolean).at(-1) ?? "").slice(0, 80);

const renderMarkdownBlock = (block: string): string => {
  const trimmed = block.trim();
  if (trimmed.length === 0) return "";
  const heading = /^(#{2,6})\s+(.+)$/u.exec(trimmed);
  if (heading !== null) {
    const level = Math.min(heading[1]!.length, 6);
    return `<h${level}>${renderInline(heading[2]!)}</h${level}>`;
  }
  if (/^```/u.test(trimmed)) {
    const code = trimmed.replace(/^```[^\n]*\n?/u, "").replace(/\n?```$/u, "");
    return `<blockquote><pre>${escapeHtml(code)}</pre></blockquote>`;
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
