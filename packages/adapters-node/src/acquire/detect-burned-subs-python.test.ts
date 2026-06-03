import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const scriptPath = path.join(
  process.cwd(),
  "packages",
  "adapters-node",
  "src",
  "acquire",
  "detect-burned-subs.py",
);

const evalPython = async (expression: string): Promise<string> => {
  const { stdout } = await execFileAsync("python3", [
    "-c",
    [
      "import importlib.util",
      `spec = importlib.util.spec_from_file_location("detect_burned_subs", ${JSON.stringify(scriptPath)})`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      `print(${expression})`,
    ].join("; "),
  ]);
  return stdout.trim();
};

describe("detect-burned-subs.py", () => {
  it("treats Simplified and Traditional Chinese text as Chinese subtitles", async () => {
    await expect(evalPython("mod.looks_like_chinese_subtitle('这是简体中文字幕')")).resolves.toBe("True");
    await expect(evalPython("mod.looks_like_chinese_subtitle('這是繁體中文字幕')")).resolves.toBe("True");
  });
});
