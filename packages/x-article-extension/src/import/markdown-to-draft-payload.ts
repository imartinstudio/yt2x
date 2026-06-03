import {
  IMAGE_MARKDOWN_RE,
  VIDEO_MARKDOWN_RE,
  parseFencedCodeBlock,
  splitArticleDraftBlocks,
} from "@yt2x/core";
import type { PreparedArticleImport } from "../files/prepare-import.js";
import { resolveUploadFile } from "../files/prepare-import.js";

export type DraftInlineStyleRange = {
  offset: number;
  length: number;
  style: "Bold" | "Italic" | "Strikethrough" | "Code";
};

export type DraftLinkRange = {
  offset: number;
  length: number;
  url: string;
};

export type DraftTextBlock = {
  type: string;
  text: string;
  inlineStyleRanges: DraftInlineStyleRange[];
  links: DraftLinkRange[];
};

export type MainWorldAtomicOperation = {
  marker: string;
  op: {
    type: "atomic";
    entityType: string;
    data: Record<string, unknown>;
    mutability?: string;
  };
};

export type MainWorldImageOperation = {
  marker: string;
  op: {
    type: "image";
    file: { token: string };
    source: string;
    fallbackText: string;
  };
};

export type MainWorldPlanOperation = MainWorldAtomicOperation | MainWorldImageOperation;

export type MainWorldImageFile = {
  token: string;
  base64: string;
  mime: string;
  fileName: string;
};

export type MainWorldWritePayload = {
  title: string;
  blocks: DraftTextBlock[];
  plan: MainWorldPlanOperation[];
  html: string;
  plain: string;
  markerPrefix: string;
  imageFiles: MainWorldImageFile[];
};

const BLOCK_TAGS: Record<string, string> = {
  "header-one": "h1",
  "header-two": "h2",
  "header-three": "h3",
  "header-four": "h4",
  "header-five": "h5",
  "header-six": "h6",
  blockquote: "blockquote",
  unstyled: "p",
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const renderInlineHtml = (segment: DraftTextBlock): string => {
  const styleAt = (index: number): DraftInlineStyleRange["style"][] => {
    const styles: DraftInlineStyleRange["style"][] = [];
    for (const range of segment.inlineStyleRanges) {
      if (index >= range.offset && index < range.offset + range.length) styles.push(range.style);
    }
    return styles;
  };
  const linkAt = (index: number): string | null => {
    for (const link of segment.links) {
      if (index >= link.offset && index < link.offset + link.length) return link.url;
    }
    return null;
  };

  let html = "";
  let linkOpen: string | null = null;
  const openTags: string[] = [];

  const closeTags = (): void => {
    if (linkOpen !== null) {
      html += "</a>";
      linkOpen = null;
    }
    while (openTags.length > 0) {
      html += `</${openTags.pop()}>`;
    }
  };

  for (let index = 0; index < segment.text.length; index += 1) {
    const styles = styleAt(index);
    const link = linkAt(index);
    const styleTags = [
      styles.includes("Bold") ? "strong" : null,
      styles.includes("Italic") ? "em" : null,
      styles.includes("Strikethrough") ? "s" : null,
      styles.includes("Code") ? "code" : null,
    ].filter(Boolean) as string[];

    if (link !== linkOpen) {
      closeTags();
      if (link !== null) {
        html += `<a href="${escapeHtml(link)}">`;
        linkOpen = link;
      }
    }

    const currentTags = styleTags.join("|");
    const openKey = openTags.join("|");
    if (currentTags !== openKey) {
      closeTags();
      for (const tag of styleTags) {
        html += `<${tag}>`;
        openTags.push(tag);
      }
      if (link !== null && linkOpen === null) {
        html += `<a href="${escapeHtml(link)}">`;
        linkOpen = link;
      }
    }

    html += escapeHtml(segment.text[index] ?? "");
  }
  closeTags();
  return html;
};

const parseInline = (kind: string, source: string): DraftTextBlock => {
  const result: DraftTextBlock = {
    type: kind,
    text: "",
    inlineStyleRanges: [],
    links: [],
  };
  let cursor = 0;

  const appendStyled = (text: string, styles: DraftInlineStyleRange["style"][]): void => {
    const offset = result.text.length;
    result.text += text;
    for (const style of styles) {
      result.inlineStyleRanges.push({ offset, length: text.length, style });
    }
  };

  while (cursor < source.length) {
    const char = source[cursor]!;

    if (char === "[") {
      const link = /^\[([^\]]+)\]\(([^)]+)\)/u.exec(source.slice(cursor));
      if (link !== null) {
        const offset = result.text.length;
        result.text += link[1]!;
        result.links.push({ offset, length: link[1]!.length, url: link[2]! });
        cursor += link[0]!.length;
        continue;
      }
    }

    const inlineRules: Array<{ marker: string; styles: DraftInlineStyleRange["style"][] }> = [
      { marker: "***", styles: ["Bold", "Italic"] },
      { marker: "**", styles: ["Bold"] },
      { marker: "~~", styles: ["Strikethrough"] },
    ];
    let matched = false;
    for (const rule of inlineRules) {
      if (!source.startsWith(rule.marker, cursor)) continue;
      const end = source.indexOf(rule.marker, cursor + rule.marker.length);
      if (end <= cursor) continue;
      appendStyled(source.slice(cursor + rule.marker.length, end), rule.styles);
      cursor = end + rule.marker.length;
      matched = true;
      break;
    }
    if (matched) continue;

    if ((char === "*" || char === "_") && source[cursor + 1] !== char) {
      const end = source.indexOf(char, cursor + 1);
      if (end > cursor && source[end + 1] !== char) {
        appendStyled(source.slice(cursor + 1, end), ["Italic"]);
        cursor = end + 1;
        continue;
      }
    }

    if (char === "`") {
      const end = source.indexOf("`", cursor + 1);
      if (end > cursor) {
        appendStyled(source.slice(cursor + 1, end), ["Code"]);
        cursor = end + 1;
        continue;
      }
    }

    result.text += char;
    cursor += 1;
  }

  return result;
};

const parseTextBlocks = (text: string): DraftTextBlock[] => {
  const lines = text.split("\n");
  const segments: DraftTextBlock[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    const value = paragraph.join("\n").trim();
    if (value.length > 0) segments.push(parseInline("unstyled", value));
    paragraph = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(trimmed);
    if (heading !== null) {
      flush();
      const kinds = [
        "",
        "header-one",
        "header-two",
        "header-three",
        "header-four",
        "header-five",
        "header-six",
      ];
      segments.push(parseInline(kinds[heading[1]!.length] ?? "unstyled", heading[2]!.trim()));
      continue;
    }

    const quote = /^>\s?(.+)$/u.exec(trimmed);
    if (quote !== null) {
      flush();
      segments.push(parseInline("blockquote", quote[1]!.trim()));
      continue;
    }

    const unordered = /^[-*+]\s+(.+)$/u.exec(trimmed);
    if (unordered !== null) {
      flush();
      segments.push(parseInline("unordered-list-item", unordered[1]!.trim()));
      continue;
    }

    const ordered = /^\d+\.\s+(.+)$/u.exec(trimmed);
    if (ordered !== null) {
      flush();
      segments.push(parseInline("ordered-list-item", ordered[1]!.trim()));
      continue;
    }

    paragraph.push(trimmed);
  }

  flush();
  return segments;
};

const fileToBase64 = async (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`Failed to read ${file.name} for X Articles import.`));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}.`));
    reader.readAsDataURL(file);
  });

const blocksToPlainText = (blocks: DraftTextBlock[]): string =>
  blocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");

const renderSegmentHtml = (segment: DraftTextBlock): string => {
  const rendered = renderInlineHtml(segment) || " ";
  if (segment.type === "unordered-list-item" || segment.type === "ordered-list-item") {
    const tag = segment.type === "unordered-list-item" ? "ul" : "ol";
    return `<${tag}><li>${rendered}</li></${tag}>`;
  }
  const tag = BLOCK_TAGS[segment.type] ?? "p";
  return `<${tag}>${rendered}</${tag}>`;
};

export const buildMainWorldWritePayload = async (
  prepared: PreparedArticleImport,
): Promise<MainWorldWritePayload> => {
  const { adapted, parseResult, mediaRegistry } = prepared;
  const splitBlocks = splitArticleDraftBlocks(adapted.markdown, { preserveSourceContent: true });
  const prefix = `__YT2X_${Math.random().toString(36).slice(2, 7)}_`;
  let markerIndex = 0;
  const marker = (type: string): string => `${prefix}${type}_${markerIndex++}__`;

  const blocks: DraftTextBlock[] = [];
  const plan: MainWorldPlanOperation[] = [];
  const html: string[] = [];
  const imageFiles: MainWorldImageFile[] = [];

  const addBlock = (segment: DraftTextBlock): void => {
    blocks.push({
      type: segment.type,
      text: segment.text,
      inlineStyleRanges: segment.inlineStyleRanges.map((range) => ({ ...range })),
      links: segment.links.map((link) => ({ ...link })),
    });
    html.push(renderSegmentHtml(segment));
  };

  const addMarkerBlock = (id: string): void => {
    blocks.push({ type: "unstyled", text: id, inlineStyleRanges: [], links: [] });
    html.push(`<p>${escapeHtml(id)}</p>`);
  };

  for (const block of splitBlocks) {
    if (block.kind === "divider") {
      const id = marker("DIVIDER");
      addMarkerBlock(id);
      plan.push({
        marker: id,
        op: {
          type: "atomic",
          entityType: "DIVIDER",
          data: {},
          mutability: "IMMUTABLE",
        },
      });
      continue;
    }

    if (block.kind === "code") {
      const { code, language } = parseFencedCodeBlock(block.source);
      const id = marker("CODE");
      const markdown = `\`\`\`${language}\n${code}\n\`\`\``;
      addMarkerBlock(id);
      plan.push({
        marker: id,
        op: {
          type: "atomic",
          entityType: "MARKDOWN",
          data: { markdown },
          mutability: "MUTABLE",
        },
      });
      continue;
    }

    if (block.kind === "image") {
      const match = IMAGE_MARKDOWN_RE.exec(block.source.trim());
      if (match === null) continue;
      const resolvedPath = mediaRegistry.resolveMediaPath(match[2]!);
      if (resolvedPath === parseResult.coverImage) continue;

      const file = resolveUploadFile(prepared, resolvedPath);
      if (file === undefined) {
        addBlock(parseInline("unstyled", `![${match[1]!}](${match[2]!})`));
        continue;
      }

      const id = marker("IMAGE");
      const token = `img_${markerIndex}`;
      imageFiles.push({
        token,
        base64: await fileToBase64(file),
        mime: file.type || "image/png",
        fileName: file.name,
      });
      addMarkerBlock(id);
      plan.push({
        marker: id,
        op: {
          type: "image",
          file: { token },
          source: resolvedPath,
          fallbackText: `![${match[1]!}](${match[2]!})`,
        },
      });
      continue;
    }

    if (block.kind === "video") {
      const match = VIDEO_MARKDOWN_RE.exec(block.source.trim());
      if (match === null) continue;
      addBlock(parseInline("unstyled", `[video: ${match[1]!}]`));
      continue;
    }

    for (const segment of parseTextBlocks(block.source)) {
      addBlock(segment);
    }
  }

  return {
    title: parseResult.title,
    blocks,
    plan,
    html: html.join(""),
    plain: blocksToPlainText(blocks),
    markerPrefix: prefix,
    imageFiles,
  };
};
