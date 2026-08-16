import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  "render-bilingual-subtitles.py",
);

/** Load the renderer as a module and evaluate one expression against it. */
const evalPython = async (expression: string): Promise<string> => {
  const { stdout } = await execFileAsync("python3", [
    "-c",
    [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location("render_bilingual", ${JSON.stringify(scriptPath)})`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      `print(json.dumps(${expression}))`,
    ].join("; "),
  ]);
  return stdout.trim();
};

const evalJson = async (expression: string): Promise<unknown> =>
  JSON.parse(await evalPython(expression));

describe("render-bilingual-subtitles.py: styled_runs", () => {
  const WHITE = "(255, 255, 255, 255)";
  const YELLOW = "(255, 217, 40, 255)";
  const highlighted = (text: string) =>
    evalJson(
      `mod.styled_runs(${JSON.stringify(text)}, ${WHITE}, mod.EN_HIGHLIGHT_RE, ${YELLOW})`,
    );

  it("accents the standalone word AI and leaves the rest white", async () => {
    await expect(highlighted("an AI video")).resolves.toEqual([
      ["an ", "latin", [255, 255, 255, 255]],
      ["AI", "latin", [255, 217, 40, 255]],
      [" video", "latin", [255, 255, 255, 255]],
    ]);
  });

  it("accents every occurrence in one line", async () => {
    const runs = (await highlighted("AI beats AI")) as [string, string, number[]][];
    expect(runs.filter((r) => r[2][0] === 255 && r[2][1] === 217).map((r) => r[0])).toEqual([
      "AI",
      "AI",
    ]);
  });

  it("does not accent AI inside a longer word", async () => {
    // \b is what keeps this to the token: AIs and SAIL must stay white, or
    // every plural and place name in the subtitles lights up yellow.
    for (const text of ["AIs did not help", "we SAIL onward", "Thai food"]) {
      const runs = (await highlighted(text)) as [string, string, number[]][];
      expect(runs.every((r) => r[2][1] === 255)).toBe(true);
    }
  });

  it("accents the AI in a hyphenated compound", async () => {
    const runs = (await highlighted("AI-generated footage")) as [string, string, number[]][];
    expect(runs[0]).toEqual(["AI", "latin", [255, 217, 40, 255]]);
  });

  it("returns plain font runs when no highlight is configured", async () => {
    // The Chinese row and EVERY shadow layer take this path — a highlighted
    // word must cast the same shadow as the rest of the line, not a yellow one.
    await expect(evalJson(`mod.styled_runs("an AI video", ${WHITE}, None, None)`)).resolves.toEqual([
      ["an AI video", "latin", [255, 255, 255, 255]],
    ]);
  });

  it("keeps the accent on the matched characters across a face boundary", async () => {
    const runs = (await highlighted("用 AI 做")) as [string, string, number[]][];
    const yellow = runs.filter((r) => r[2][1] === 217).map((r) => r[0]);
    expect(yellow).toEqual(["AI"]);
  });

  it("returns nothing for empty text", async () => {
    await expect(highlighted("")).resolves.toEqual([]);
  });
});

describe("render-bilingual-subtitles.py: tracking", () => {
  const lineWidth = (text: string, row: "zh" | "en") =>
    evalJson(
      [
        "(lambda d: mod._line_width(",
        JSON.stringify(text),
        `, mod.${row}_font_set(mod._BASE_${row.toUpperCase()}_FONT_SIZE), d))`,
        "(__import__('PIL.ImageDraw', fromlist=['ImageDraw']).Draw(",
        "__import__('PIL.Image', fromlist=['Image']).new('RGBA', (1, 1))))",
      ].join(""),
    );

  it("gives the English row 0.02em of tracking and the Chinese row none", async () => {
    await expect(evalJson("mod.ZH_TRACKING_EM")).resolves.toBe(0);
    await expect(evalJson("mod.EN_TRACKING_EM")).resolves.toBe(0.02);
    await expect(evalJson("mod.zh_font_set(mod.ZH_FONT_SIZE_BASE).tracking")).resolves.toBe(0);
    await expect(evalJson("mod.en_font_set(mod._BASE_EN_FONT_SIZE).tracking")).resolves.toBeCloseTo(
      0.32,
    );
  });

  it("counts tracking between glyphs but not after the last one", async () => {
    // The measured width is what centring is derived from, so a trailing gap
    // would push every English line half a tracking step left of centre. A
    // single glyph must therefore measure its bare advance, and each further
    // glyph must add exactly one tracking step on top of its own advance.
    const [bare, one, two] = (await Promise.all([
      evalJson(
        [
          "(lambda d: d.textlength('i',",
          " font=mod.en_font_set(mod._BASE_EN_FONT_SIZE).latin))",
          "(__import__('PIL.ImageDraw', fromlist=['ImageDraw']).Draw(",
          "__import__('PIL.Image', fromlist=['Image']).new('RGBA', (1, 1))))",
        ].join(""),
      ),
      lineWidth("i", "en"),
      lineWidth("ii", "en"),
    ])) as [number, number, number];
    expect(one).toBe(Math.round(bare));
    expect(two - one).toBeCloseTo(bare + 0.02 * 16, 0);
  });

  it("makes a tracked line wider than the same line untracked", async () => {
    const tracked = (await lineWidth("banana", "en")) as number;
    const untracked = (await evalJson(
      [
        "(lambda d: mod._run_advance('banana',",
        " mod.en_font_set(mod._BASE_EN_FONT_SIZE).latin, d, 0))",
        "(__import__('PIL.ImageDraw', fromlist=['ImageDraw']).Draw(",
        "__import__('PIL.Image', fromlist=['Image']).new('RGBA', (1, 1))))",
      ].join(""),
    )) as number;
    // 6 glyphs -> 5 inter-glyph gaps of 0.32px.
    expect(tracked - untracked).toBeCloseTo(5 * 0.32, 0);
  });
});

// The shadow values and font chains themselves live in the shared visual
// contract and are asserted in subtitle-style-python.test.ts. What matters here
// is only that this renderer wires each row to the right one.
describe("render-bilingual-subtitles.py: per-row font sets", () => {
  it("uses one face for both scripts of the Chinese row", async () => {
    // A product name inside a Chinese caption has to keep that row's Heavy
    // weight rather than dropping to the English face mid-line.
    const fs = (await evalJson(
      "[mod.zh_font_set(mod.ZH_FONT_SIZE_BASE).latin_name, mod.zh_font_set(mod.ZH_FONT_SIZE_BASE).cjk_name]",
    )) as string[];
    expect(fs[0]).toBe(fs[1]);
    expect(fs[0]).toMatch(/Black|Heavy/);
  });

  it("gives the English row Inter for Latin and a lighter CJK fallback", async () => {
    await expect(evalJson("mod.en_font_set(mod._BASE_EN_FONT_SIZE).latin_name")).resolves.toBe(
      "Inter Bold",
    );
    const cjk = (await evalJson("mod.en_font_set(mod._BASE_EN_FONT_SIZE).cjk_name")) as string;
    expect(cjk).not.toMatch(/Black|Heavy/);
  });

  it("takes the Chinese size from the contract and keeps English its own", async () => {
    // Chinese size is shared now: single-language delivery is this same row
    // with the English one removed, so the two must set type identically.
    // English has no counterpart to match, so it stays local.
    await expect(evalJson("mod.ZH_FONT_SIZE_BASE")).resolves.toBe(30);
    await expect(evalJson("mod._BASE_EN_FONT_SIZE")).resolves.toBe(16);
    const renderer = await readFile(scriptPath, "utf8");
    expect(renderer).not.toContain("_BASE_ZH_FONT_SIZE =");
  });
});
