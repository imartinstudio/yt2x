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
  "forced-align.py",
);

const evalPython = async (expression: string): Promise<string> => {
  const { stdout } = await execFileAsync("python3", [
    "-c",
    [
      "import importlib.util",
      `spec = importlib.util.spec_from_file_location("forced_align", ${JSON.stringify(scriptPath)})`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      `print(${expression})`,
    ].join("; "),
  ]);
  return stdout.trim();
};

describe("forced-align.py: normalize_word_for_alignment", () => {
  it("lowercases and strips leading/trailing punctuation", async () => {
    await expect(evalPython("mod.normalize_word_for_alignment('Hello,')")).resolves.toBe("hello");
    await expect(evalPython("mod.normalize_word_for_alignment('\"World\"')")).resolves.toBe("world");
  });

  it("keeps an internal apostrophe", async () => {
    await expect(evalPython("mod.normalize_word_for_alignment(\"don't\")")).resolves.toBe("don't");
  });

  it("reduces a punctuation-only token to an empty string", async () => {
    await expect(evalPython("mod.normalize_word_for_alignment('--')")).resolves.toBe("");
  });
});

describe("forced-align.py: build_alignment_result", () => {
  it("builds one entry per word with a single span", async () => {
    const scriptWithJson = [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location("forced_align", ${JSON.stringify(scriptPath)})`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "print(json.dumps(mod.build_alignment_result(['hello', 'world'], [[(0.1, 0.2)], [(0.3, 0.4)]])))",
    ].join("; ");
    const { stdout } = await execFileAsync("python3", ["-c", scriptWithJson]);
    expect(JSON.parse(stdout)).toEqual([
      { word: "hello", start: 0.1, end: 0.2 },
      { word: "world", start: 0.3, end: 0.4 },
    ]);
  });

  it("skips a word with no aligned spans", async () => {
    const scriptWithJson = [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location("forced_align", ${JSON.stringify(scriptPath)})`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "print(json.dumps(mod.build_alignment_result(['a', 'b'], [[], [(1.0, 2.0)]])))",
    ].join("; ");
    const { stdout } = await execFileAsync("python3", ["-c", scriptWithJson]);
    expect(JSON.parse(stdout)).toEqual([{ word: "b", start: 1.0, end: 2.0 }]);
  });

  it("merges multiple spans for one word into a single min/max range", async () => {
    const scriptWithJson = [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location("forced_align", ${JSON.stringify(scriptPath)})`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "print(json.dumps(mod.build_alignment_result(['hello'], [[(0.3, 0.4), (0.1, 0.2), (0.5, 0.6)]])))",
    ].join("; ");
    const { stdout } = await execFileAsync("python3", ["-c", scriptWithJson]);
    expect(JSON.parse(stdout)).toEqual([{ word: "hello", start: 0.1, end: 0.6 }]);
  });
});
