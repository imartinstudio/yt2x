import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import type { AdaptArticleForXResult, ArticleForXAdaptation } from "@yt2x/core";

export const materializeArticleDraftAdaptations = async (input: {
  adapted: AdaptArticleForXResult;
  articleDir: string;
}): Promise<AdaptArticleForXResult> => {
  const tables = input.adapted.adaptations.filter(isTableImageAdaptation);
  if (tables.length === 0) return input.adapted;

  const imagesDir = path.join(input.articleDir, "x-format", "images");
  await mkdir(imagesDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    let markdown = input.adapted.markdown;
    for (const [index, table] of tables.entries()) {
      const filename = `x-table-${index + 1}.png`;
      await page.setContent(renderTableDocument(table.sourceMarkdown));
      await page.locator("table").screenshot({ path: path.join(imagesDir, filename) });
      markdown = markdown.replace(`(${table.placeholder})`, `(x-format/images/${filename})`);
    }
    return { ...input.adapted, markdown };
  } finally {
    await browser.close();
  }
};

const isTableImageAdaptation = (
  adaptation: ArticleForXAdaptation,
): adaptation is ArticleForXAdaptation & { placeholder: string; sourceMarkdown: string } =>
  adaptation.kind === "premium-table" &&
  adaptation.placeholder !== undefined &&
  adaptation.sourceMarkdown !== undefined;

const renderTableDocument = (markdown: string): string => {
  const rows = markdown
    .split(/\r?\n/u)
    .map(tableCells)
    .filter((cells) => cells.length > 0 && !cells.every((cell) => /^:?-+:?$/u.test(cell)));
  const [head = [], ...body] = rows;
  return [
    "<!doctype html>",
    "<style>",
    "body{margin:0;padding:32px;background:#fff;color:#111;font:22px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}",
    "table{border-collapse:collapse;max-width:1376px;background:#fff}",
    "th,td{border:2px solid #d0d7de;padding:14px 18px;text-align:left;vertical-align:top;white-space:pre-wrap}",
    "th{background:#f3f4f6;font-weight:650}",
    "</style>",
    "<table><thead><tr>",
    ...head.map((cell) => `<th>${escapeHtml(cell)}</th>`),
    "</tr></thead><tbody>",
    ...body.map((cells) => `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`),
    "</tbody></table>",
  ].join("");
};

const tableCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => cell.trim());

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
