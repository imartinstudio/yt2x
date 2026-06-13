import { access, stat } from "node:fs/promises";
import path from "node:path";
import { createProcessRunner, type ProcessResult, type ProcessRunner } from "../process/index.js";

export const WECHAT_FORMATTER_DIR_ENV = "WECHAT_FORMATTER_DIR";
export const DEFAULT_WECHAT_FORMAT_THEME = "github";
export const DEFAULT_WECHAT_FORMAT_PYTHON = "python3";

export type WechatFormatterCheckInput = {
  formatterDir?: string;
  pythonBin?: string;
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
};

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

export type FormatWechatArticleInput = {
  articleDir: string;
  sourceFile?: string;
  formatterDir?: string;
  pythonBin?: string;
  theme?: string;
  outputDir?: string;
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
  signal?: AbortSignal;
};

export type FormatWechatArticleResult = {
  inputPath: string;
  outputBaseDir: string;
  formattedDir: string;
  articleHtmlPath: string;
  previewHtmlPath: string;
  theme: string;
  command: string;
  args: readonly string[];
  stdout: string;
  stderr: string;
};

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const resolveFormatterDir = (input: WechatFormatterCheckInput): string | undefined => {
  const raw = input.formatterDir ?? input.env?.[WECHAT_FORMATTER_DIR_ENV];
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? path.resolve(trimmed) : undefined;
};

const buildPaths = (formatterDir: string): { scriptPath: string; configPath: string } => ({
  scriptPath: path.join(formatterDir, "scripts", "format.py"),
  configPath: path.join(formatterDir, "config.json"),
});

const checkPythonImport = async (
  runner: ProcessRunner,
  pythonBin: string,
  moduleName: string,
): Promise<boolean> => {
  try {
    await runner.run({
      command: pythonBin,
      args: ["-c", `import ${moduleName}`],
      timeoutMs: 15_000,
      stdoutLimit: { head: 4096, tail: 4096 },
      stderrLimit: { head: 4096, tail: 4096 },
    });
    return true;
  } catch {
    return false;
  }
};

export const checkWechatFormatter = async (
  input: WechatFormatterCheckInput = {},
): Promise<WechatFormatterCheckResult> => {
  const pythonBin = input.pythonBin?.trim() || DEFAULT_WECHAT_FORMAT_PYTHON;
  const runner = input.runner ?? createProcessRunner();
  const formatterDir = resolveFormatterDir(input);
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: WechatFormatterCheckResult["checks"] = {
    formatterDir: false,
    script: false,
    config: false,
    python: false,
    markdown: false,
    requests: false,
  };

  let scriptPath: string | undefined;
  let configPath: string | undefined;

  if (formatterDir === undefined) {
    errors.push(`Missing formatter dir. Set ${WECHAT_FORMATTER_DIR_ENV} or pass --formatter-dir.`);
  } else {
    const info = await stat(formatterDir).catch(() => undefined);
    checks.formatterDir = info?.isDirectory() === true;
    if (!checks.formatterDir) {
      errors.push(`Formatter dir does not exist or is not a directory: ${formatterDir}`);
    }
    const paths = buildPaths(formatterDir);
    scriptPath = paths.scriptPath;
    configPath = paths.configPath;
    checks.script = await exists(scriptPath);
    checks.config = await exists(configPath);
    if (!checks.script) errors.push(`Missing formatter script: ${scriptPath}`);
    if (!checks.config) errors.push(`Missing formatter config: ${configPath}`);
  }

  try {
    await runner.run({
      command: pythonBin,
      args: ["--version"],
      timeoutMs: 15_000,
      stdoutLimit: { head: 4096, tail: 4096 },
      stderrLimit: { head: 4096, tail: 4096 },
    });
    checks.python = true;
  } catch {
    errors.push(`Python command is not available: ${pythonBin}`);
  }

  if (checks.python) {
    checks.markdown = await checkPythonImport(runner, pythonBin, "markdown");
    checks.requests = await checkPythonImport(runner, pythonBin, "requests");
    if (!checks.markdown) errors.push(`Missing Python package: markdown. Install with: pip3 install markdown`);
    if (!checks.requests) warnings.push(`Missing Python package: requests. Pure formatting can run without publishing, but the upstream setup recommends it.`);
  }

  return {
    ok: errors.length === 0,
    ...(formatterDir !== undefined ? { formatterDir } : {}),
    pythonBin,
    ...(scriptPath !== undefined ? { scriptPath } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
    checks,
    errors,
    warnings,
  };
};

const requireWechatFormatter = async (
  input: WechatFormatterCheckInput,
): Promise<Required<Pick<WechatFormatterCheckResult, "formatterDir" | "scriptPath">> & { pythonBin: string }> => {
  const check = await checkWechatFormatter(input);
  if (!check.ok || check.formatterDir === undefined || check.scriptPath === undefined) {
    throw new Error([
      "Wechat formatter is not ready.",
      ...check.errors.map((err) => `- ${err}`),
      ...check.warnings.map((warning) => `- Warning: ${warning}`),
    ].join("\n"));
  }
  return {
    formatterDir: check.formatterDir,
    scriptPath: check.scriptPath,
    pythonBin: check.pythonBin,
  };
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

export const formatWechatArticle = async (
  input: FormatWechatArticleInput,
): Promise<FormatWechatArticleResult> => {
  const articleDir = path.resolve(input.articleDir);
  const sourceFile = resolveSourceFile(input.sourceFile);
  const inputPath = path.join(articleDir, sourceFile);
  if (!(await exists(inputPath))) {
    throw new Error(`Missing WeChat source article: ${inputPath}. Run \`pnpm yt2x article --video-id <videoId>\` first, or pass a source file that exists.`);
  }

  const formatter = await requireWechatFormatter(input);
  const runner = input.runner ?? createProcessRunner();
  const outputBaseDir = path.resolve(input.outputDir ?? path.join(articleDir, "wechat-format"));
  const stem = path.basename(inputPath, path.extname(inputPath));
  const formattedDir = path.join(outputBaseDir, stem);
  const theme = input.theme?.trim() || DEFAULT_WECHAT_FORMAT_THEME;
  const args = [
    formatter.scriptPath,
    "--input",
    inputPath,
    "--theme",
    theme,
    "--output",
    outputBaseDir,
    "--format",
    "wechat",
    "--no-open",
  ] as const;

  const result: ProcessResult = await runner.run({
    command: formatter.pythonBin,
    args,
    cwd: formatter.formatterDir,
    timeoutMs: 5 * 60_000,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  return {
    inputPath,
    outputBaseDir,
    formattedDir,
    articleHtmlPath: path.join(formattedDir, "article.html"),
    previewHtmlPath: path.join(formattedDir, "preview.html"),
    theme,
    command: result.command,
    args: result.args,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};
