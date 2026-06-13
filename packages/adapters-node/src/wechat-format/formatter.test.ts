import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../process/index.js";
import { checkWechatFormatter, formatWechatArticle, WECHAT_FORMATTER_DIR_ENV } from "./formatter.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "yt2x-wechat-format-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const makeFormatterDir = async (): Promise<string> => {
  const formatterDir = path.join(root, "xiaohu-wechat-format");
  await mkdir(path.join(formatterDir, "scripts"), { recursive: true });
  await writeFile(path.join(formatterDir, "scripts", "format.py"), "#!/usr/bin/env python3\n");
  await writeFile(path.join(formatterDir, "config.json"), JSON.stringify({ output_dir: "/tmp/wechat-format" }));
  return formatterDir;
};

const okRunner = (): ProcessRunner => ({
  run: vi.fn(async (spec) => ({
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    command: spec.command,
    args: spec.args ?? [],
  })),
});

describe("checkWechatFormatter", () => {
  it("accepts formatter dir from env and checks script/config/python deps", async () => {
    const formatterDir = await makeFormatterDir();
    const runner = okRunner();

    const result = await checkWechatFormatter({
      env: { [WECHAT_FORMATTER_DIR_ENV]: formatterDir },
      runner,
    });

    expect(result.ok).toBe(true);
    expect(result.formatterDir).toBe(formatterDir);
    expect(result.checks.script).toBe(true);
    expect(result.checks.config).toBe(true);
    expect(result.checks.markdown).toBe(true);
    expect(result.checks.requests).toBe(true);
  });

  it("reports missing formatter dir", async () => {
    const result = await checkWechatFormatter({ env: {}, runner: okRunner() });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(WECHAT_FORMATTER_DIR_ENV);
  });
});

describe("formatWechatArticle", () => {
  it("runs format.py against article.md with deterministic output dir by default", async () => {
    const formatterDir = await makeFormatterDir();
    const articleDir = path.join(root, "articles", "video123");
    await mkdir(articleDir, { recursive: true });
    await writeFile(path.join(articleDir, "article.md"), "# 主稿\n\n正文");
    const runner = okRunner();

    const result = await formatWechatArticle({
      articleDir,
      formatterDir,
      theme: "newspaper",
      runner,
    });

    expect(result.outputBaseDir).toBe(path.join(articleDir, "wechat-format"));
    expect(result.formattedDir).toBe(path.join(articleDir, "wechat-format", "article"));
    expect(result.articleHtmlPath).toBe(path.join(result.formattedDir, "article.html"));
    expect(result.previewHtmlPath).toBe(path.join(result.formattedDir, "preview.html"));
    expect(runner.run).toHaveBeenLastCalledWith(expect.objectContaining({
      command: "python3",
      cwd: formatterDir,
      args: [
        path.join(formatterDir, "scripts", "format.py"),
        "--input",
        path.join(articleDir, "article.md"),
        "--theme",
        "newspaper",
        "--output",
        path.join(articleDir, "wechat-format"),
        "--format",
        "wechat",
        "--no-open",
      ],
    }));
  });

  it("can format an explicit legacy wechat-article.md source", async () => {
    const formatterDir = await makeFormatterDir();
    const articleDir = path.join(root, "articles", "video456");
    await mkdir(articleDir, { recursive: true });
    await writeFile(path.join(articleDir, "wechat-article.md"), "# 微信稿\n\n正文");

    const result = await formatWechatArticle({
      articleDir,
      sourceFile: "wechat-article.md",
      formatterDir,
      runner: okRunner(),
    });

    expect(result.inputPath).toBe(path.join(articleDir, "wechat-article.md"));
    expect(result.formattedDir).toBe(path.join(articleDir, "wechat-format", "wechat-article"));
  });

  it("fails clearly when article.md is missing", async () => {
    const formatterDir = await makeFormatterDir();
    const articleDir = path.join(root, "articles", "video123");
    await mkdir(articleDir, { recursive: true });

    await expect(formatWechatArticle({
      articleDir,
      formatterDir,
      runner: okRunner(),
    })).rejects.toThrow(/Missing WeChat source article/);
  });
});
