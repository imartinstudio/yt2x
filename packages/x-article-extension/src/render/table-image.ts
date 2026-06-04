type TableLayoutCell = {
  text: string;
  lines: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  isHeader: boolean;
};

const FONT_FAMILY = "-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
const FONT_SIZE = 22;
const LINE_HEIGHT = 31;
const CELL_PADDING_X = 18;
const CELL_PADDING_Y = 14;
const BORDER_WIDTH = 2;
const MAX_TABLE_WIDTH = 1376;
const MIN_COLUMN_WIDTH = 140;
const MAX_COLUMN_WIDTH = 360;

const tableCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => cell.trim());

const parseTableRows = (markdown: string): string[][] =>
  markdown
    .split(/\r?\n/u)
    .map(tableCells)
    .filter((cells) => cells.length > 0 && !cells.every((cell) => /^:?-+:?$/u.test(cell)));

const measureTextWidth = (ctx: CanvasRenderingContext2D, text: string): number =>
  Math.ceil(ctx.measureText(text || " ").width);

const wrapText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] => {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return [""];

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  const pushLongToken = (token: string): void => {
    let fragment = "";
    for (const char of token) {
      const next = fragment + char;
      if (fragment.length > 0 && measureTextWidth(ctx, next) > maxWidth) {
        lines.push(fragment);
        fragment = char;
      } else {
        fragment = next;
      }
    }
    current = fragment;
  };

  for (const word of words) {
    const next = current.length > 0 ? `${current} ${word}` : word;
    if (measureTextWidth(ctx, next) <= maxWidth) {
      current = next;
      continue;
    }
    if (current.length > 0) lines.push(current);
    if (measureTextWidth(ctx, word) > maxWidth) {
      pushLongToken(word);
    } else {
      current = word;
    }
  }

  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
};

const normalizeRows = (rows: string[][]): string[][] => {
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  return rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ""));
};

const calculateColumnWidths = (
  ctx: CanvasRenderingContext2D,
  rows: string[][],
): number[] => {
  const columnCount = rows[0]?.length ?? 1;
  const naturalWidths = Array.from({ length: columnCount }, (_, columnIndex) => {
    const maxContentWidth = Math.max(
      ...rows.map((row) => measureTextWidth(ctx, row[columnIndex] ?? "")),
      MIN_COLUMN_WIDTH,
    );
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, maxContentWidth + CELL_PADDING_X * 2));
  });

  const totalWidth = naturalWidths.reduce((sum, width) => sum + width, 0);
  if (totalWidth <= MAX_TABLE_WIDTH) return naturalWidths;

  const scale = MAX_TABLE_WIDTH / totalWidth;
  return naturalWidths.map((width) => Math.max(MIN_COLUMN_WIDTH, Math.floor(width * scale)));
};

const createMeasureContext = (): CanvasRenderingContext2D => {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("Canvas 2D context was unavailable for table PNG export.");
  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  return ctx;
};

const createTableLayout = (ctx: CanvasRenderingContext2D, markdown: string): {
  cells: TableLayoutCell[];
  width: number;
  height: number;
} => {
  const parsedRows = normalizeRows(parseTableRows(markdown));
  const rows = parsedRows.length > 0 ? parsedRows : [[""]];
  const columnWidths = calculateColumnWidths(ctx, rows);
  const cells: TableLayoutCell[] = [];
  let y = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const wrapped = row.map((cell, columnIndex) =>
      wrapText(ctx, cell, columnWidths[columnIndex]! - CELL_PADDING_X * 2),
    );
    const rowHeight = Math.max(...wrapped.map((lines) => lines.length * LINE_HEIGHT + CELL_PADDING_Y * 2));
    let x = 0;
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      cells.push({
        text: row[columnIndex]!,
        lines: wrapped[columnIndex]!,
        x,
        y,
        width: columnWidths[columnIndex]!,
        height: rowHeight,
        isHeader: rowIndex === 0,
      });
      x += columnWidths[columnIndex]!;
    }
    y += rowHeight;
  }

  return {
    cells,
    width: columnWidths.reduce((sum, width) => sum + width, 0),
    height: y,
  };
};

const drawTable = (
  ctx: CanvasRenderingContext2D,
  layout: ReturnType<typeof createTableLayout>,
): void => {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.textBaseline = "top";
  ctx.lineWidth = BORDER_WIDTH;

  for (const cell of layout.cells) {
    ctx.fillStyle = cell.isHeader ? "#f3f4f6" : "#fff";
    ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
    ctx.strokeStyle = "#d0d7de";
    ctx.strokeRect(cell.x, cell.y, cell.width, cell.height);

    ctx.fillStyle = "#111";
    ctx.font = `${cell.isHeader ? "650 " : ""}${FONT_SIZE}px ${FONT_FAMILY}`;
    let lineY = cell.y + CELL_PADDING_Y;
    for (const line of cell.lines) {
      ctx.fillText(line, cell.x + CELL_PADDING_X, lineY);
      lineY += LINE_HEIGHT;
    }
  }
};

export const renderTableMarkdownToPngBlob = async (markdown: string): Promise<Blob> => {
  const measureCtx = createMeasureContext();
  const layout = createTableLayout(measureCtx, markdown);
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(layout.width * scale);
  canvas.height = Math.ceil(layout.height * scale);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("Canvas 2D context was unavailable for table PNG export.");
  ctx.scale(scale, scale);
  drawTable(ctx, layout);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result === null) reject(new Error("Table PNG conversion failed."));
      else resolve(result);
    }, "image/png");
  });
};
