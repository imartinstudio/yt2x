import {
  renderMarkdownBlock,
  splitArticleDraftBlocks,
  extractArticleTitle,
  IMAGE_MARKDOWN_RE,
} from "@yt2x/core";
import type { WechatTheme } from "./themes.js";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const TAG_STYLE_KEYS: Record<string, keyof WechatTheme["styles"]> = {
  h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6",
  p: "p", blockquote: "blockquote", pre: "pre",
  table: "table", th: "th_td", td: "th_td",
  ul: "ul_ol", ol: "ul_ol", li: "li", hr: "hr",
  a: "a", strong: "strong", em: "em", code: "code",
};

/** Inject theme styles into rendered HTML tags via style="" attributes.
 *  Uses a single regex pass so that `<pre>` is never mis-matched by a
 *  `<p>` rule, and `<th>` never corrupts `<thead>`. */
const applyInlineStyles = (html: string, theme: WechatTheme): string => {
  const s = theme.styles;
  return html.replace(/<(\w+)([\s>])/g, (match, tag: string, next: string) => {
    const styleKey = TAG_STYLE_KEYS[tag];
    if (styleKey === undefined) return match;
    const style = s[styleKey];
    if (style === undefined || style.trim().length === 0) return match;
    return `<${tag} style="${style.trim()}"${next}`;
  });
};

/** Render a markdown image block as a styled `<img>` tag for WeChat. */
const renderImageBlock = (source: string, styles: Record<string, string>): string => {
  const m = IMAGE_MARKDOWN_RE.exec(source.trim());
  if (m === null) return "";
  const alt = escapeHtml(m[1] ?? "");
  const src = escapeHtml(m[2] ?? "");
  const style = styles.img !== undefined ? ` style="${styles.img}"` : "";
  return `<img src="${src}" alt="${alt}"${style}>`;
};

/** Build a full HTML document for an article (inline styles, for copying into WeChat editor). */
const buildArticleHtml = (title: string, bodyHtml: string, theme: WechatTheme): string => {
  const safeTitle = escapeHtml(title);
  const titleBlock = `<h1 style="${theme.styles.title}">${safeTitle}</h1>`;
  return [
    '<section style="' + theme.styles.article + '">',
    titleBlock,
    bodyHtml,
    "</section>",
  ].join("\n");
};

/** Build a full HTML page for local browser preview. */
const buildPreviewHtml = (
  title: string,
  bodyHtml: string,
  theme: WechatTheme,
): string => {
  const safeTitle = escapeHtml(title);
  const titleBlock = `<h1 style="${theme.styles.title}">${safeTitle}</h1>`;
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>" + safeTitle + "</title>",
    "<style>" + theme.previewCss + "</style>",
    "</head>",
    "<body>",
    '<div class="wx-article">',
    titleBlock,
    bodyHtml,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
};

export const renderWechatArticleHtml = (
  markdown: string,
  theme: WechatTheme,
): { articleHtml: string; previewHtml: string } => {
  const { title, body } = extractArticleTitle(markdown);
  const blocks = splitArticleDraftBlocks(body);

  const rendered: string[] = [];
  for (const block of blocks) {
    if (block.kind === "image") {
      rendered.push(renderImageBlock(block.source, theme.styles));
    } else if (block.kind === "divider") {
      const hrStyle = theme.styles.hr;
      const style = hrStyle !== undefined && hrStyle.trim().length > 0
        ? ` style="${hrStyle.trim()}"`
        : "";
      rendered.push(`<hr${style}>`);
    } else {
      // markdown, code, video blocks all go through renderMarkdownBlock
      const html = renderMarkdownBlock(block.source);
      if (html.length > 0) {
        rendered.push(applyInlineStyles(html, theme));
      }
    }
  }

  const bodyHtml = rendered.join("\n");
  return {
    articleHtml: buildArticleHtml(title, bodyHtml, theme),
    previewHtml: buildPreviewHtml(title, bodyHtml, theme),
  };
};
