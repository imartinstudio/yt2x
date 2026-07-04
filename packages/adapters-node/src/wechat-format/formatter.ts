import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWechatTheme, DEFAULT_WECHAT_THEME_ID, type WechatTheme } from "./themes.js";
import { renderWechatArticleHtml } from "./renderer.js";

export {
  type WechatTheme,
  DEFAULT_WECHAT_THEME_ID,
  BUILTIN_WECHAT_THEMES,
  getBuiltinWechatThemes,
  getWechatTheme,
} from "./themes.js";

/** @deprecated No longer needed — the formatter is self-contained. Kept for API compatibility. */
export const DEFAULT_WECHAT_FORMAT_THEME = "github";

/** @deprecated No longer needed — the formatter is self-contained. Kept for API compatibility. */
export const WECHAT_FORMATTER_DIR_ENV = "WECHAT_FORMATTER_DIR";

/** @deprecated No longer needed — the formatter is self-contained. Kept for API compatibility. */
export const DEFAULT_WECHAT_FORMAT_PYTHON = "python3";

export type FormatWechatArticleInput = {
  articleDir: string;
  sourceFile?: string;
  /** @deprecated Ignored — formatter is self-contained. */
  formatterDir?: string;
  /** @deprecated Ignored — formatter is self-contained. */
  pythonBin?: string;
  theme?: string;
  /** Optional output base directory (default: <articleDir>/wechat-format). */
  outputDir?: string;
  /** @deprecated Ignored — formatter is self-contained. */
  env?: NodeJS.ProcessEnv;
  /** @deprecated Ignored — formatter is self-contained. */
  runner?: unknown;
  /** @deprecated Ignored — formatter is self-contained. */
  signal?: AbortSignal;
};

export type FormatWechatArticleResult = {
  inputPath: string;
  outputBaseDir: string;
  formattedDir: string;
  articleHtmlPath: string;
  previewHtmlPath: string;
  theme: string;
  /** Always "builtin" — no external process. */
  command: string;
  /** Always empty. */
  args: readonly string[];
  /** Always empty. */
  stdout: string;
  /** Always empty. */
  stderr: string;
};

/** @deprecated Always succeeds — the formatter is self-contained. */
export type WechatFormatterCheckInput = {
  formatterDir?: string;
  pythonBin?: string;
  env?: NodeJS.ProcessEnv;
  runner?: unknown;
};

/** @deprecated Always returns ok — the formatter is self-contained. */
export type WechatFormatterCheckResult = {
  ok: boolean;
  formatterDir?: string;
  pythonBin: string;
  scriptPath?: string;
  configPath?: string;
  checks: {
    formatterDir: boolean;
    script: boolean;
    config: boolean;
    python: boolean;
    markdown: boolean;
    requests: boolean;
  };
  errors: string[];
  warnings: string[];
};

const exists = async (p: string): Promise<boolean> => {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
};

const resolveSourceFile = (sourceFile: string | undefined): string => {
  const file = sourceFile?.trim() || "article.md";
  if (file.length === 0 || file.includes("/") || file.includes("\\") || path.basename(file) !== file) {
    throw new Error(`Invalid WeChat source file: ${file}`);
  }
  if (path.extname(file) !== ".md") {
    throw new Error(`WeChat source file must be a Markdown file: ${file}`);
  }
  return file;
};

/** Always returns ok — the formatter is self-contained with no external dependencies. */
export const checkWechatFormatter = async (
  _input: WechatFormatterCheckInput = {},
): Promise<WechatFormatterCheckResult> => ({
  ok: true,
  pythonBin: "builtin",
  checks: {
    formatterDir: true,
    script: true,
    config: true,
    python: true,
    markdown: true,
    requests: true,
  },
  errors: [],
  warnings: [],
});

/**
 * Format a WeChat article markdown file into styled HTML.
 *
 * The formatter is now self-contained — no external Python script or
 * xiaohu-wechat-format checkout is needed.  It uses the same markdown
 * renderer (`renderMarkdownBlock`) that powers the X article pipeline.
 */
export const formatWechatArticle = async (
  input: FormatWechatArticleInput,
): Promise<FormatWechatArticleResult> => {
  const articleDir = path.resolve(input.articleDir);
  const sourceFile = resolveSourceFile(input.sourceFile);
  const inputPath = path.join(articleDir, sourceFile);

  if (!(await exists(inputPath))) {
    throw new Error(
      `Missing WeChat source article: ${inputPath}. Run \`pnpm yt2x article --video-id &lt;videoId&gt;\` first.`,
    );
  }

  const themeId = input.theme?.trim() || DEFAULT_WECHAT_THEME_ID;
  const theme: WechatTheme = getWechatTheme(themeId) ?? getWechatTheme(DEFAULT_WECHAT_THEME_ID)!;

  const markdown = await readFile(inputPath, "utf8");
  const { articleHtml, previewHtml } = renderWechatArticleHtml(markdown, theme);

  const outputBaseDir = path.resolve(input.outputDir ?? path.join(articleDir, "wechat-format"));
  const stem = path.basename(inputPath, path.extname(inputPath));
  const formattedDir = path.join(outputBaseDir, stem);

  await mkdir(formattedDir, { recursive: true });

  const articleHtmlPath = path.join(formattedDir, "article.html");
  const previewHtmlPath = path.join(formattedDir, "preview.html");

  await Promise.all([
    writeFile(articleHtmlPath, articleHtml, "utf8"),
    writeFile(previewHtmlPath, previewHtml, "utf8"),
  ]);

  return {
    inputPath,
    outputBaseDir,
    formattedDir,
    articleHtmlPath,
    previewHtmlPath,
    theme: theme.id,
    command: "builtin",
    args: [],
    stdout: "",
    stderr: "",
  };
};
