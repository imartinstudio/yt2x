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

export const renderTableMarkdownToPngBlob = async (markdown: string): Promise<Blob> => {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;left:-9999px;top:0;width:1440px;height:960px;border:0";
  document.body.appendChild(iframe);

  try {
    const doc = iframe.contentDocument;
    if (doc === null) throw new Error("Table render iframe document was unavailable.");
    doc.open();
    doc.write(renderTableDocument(markdown));
    doc.close();
    const table = doc.querySelector("table");
    if (table === null) throw new Error("Table element was not rendered for PNG export.");

    const scale = 2;
    const rect = table.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(rect.width * scale);
    canvas.height = Math.ceil(rect.height * scale);
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("Canvas 2D context was unavailable for table PNG export.");

    const svg = new XMLSerializer().serializeToString(
      new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}">
          <foreignObject width="100%" height="100%">${table.outerHTML}</foreignObject>
        </svg>`,
        "image/svg+xml",
      ).documentElement,
    );
    const url = URL.createObjectURL(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    );
    try {
      const image = await loadImage(url);
      ctx.scale(scale, scale);
      ctx.drawImage(image, 0, 0);
    } finally {
      URL.revokeObjectURL(url);
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result === null) reject(new Error("Table PNG conversion failed."));
        else resolve(result);
      }, "image/png");
    });
    return blob;
  } finally {
    iframe.remove();
  }
};

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load rendered table image."));
    image.src = url;
  });
