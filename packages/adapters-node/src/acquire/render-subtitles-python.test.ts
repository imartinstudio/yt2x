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
  "render-subtitles.py",
);

/** Load the renderer as a module and evaluate one expression against it. */
const evalJson = async (expression: string, preamble = ""): Promise<unknown> => {
  const { stdout } = await execFileAsync("python3", [
    "-c",
    [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location("render_subtitles", ${JSON.stringify(scriptPath)})`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      ...(preamble ? [preamble] : []),
      `print(json.dumps(${expression}))`,
    ].join("; "),
  ]);
  return JSON.parse(stdout.trim());
};

describe("render-subtitles.py: shared visual contract", () => {
  it("takes its look from subtitle_style rather than its own constants", async () => {
    const renderer = await readFile(scriptPath, "utf8");
    expect(renderer).toContain("from subtitle_style import");
    // These were this renderer's own competing style; the dark rounded box is
    // gone and the fill/outline/shadow/safe-area now come from the shared
    // contract, so redefining them locally would reintroduce the drift.
    expect(renderer).not.toContain("BG_COLOR");
    expect(renderer).not.toContain("rounded_rectangle");
    expect(renderer).not.toContain("BG_PAD_X_RATIO");
    expect(renderer).not.toContain("TEXT_COLOR =");
    expect(renderer).not.toContain("WIDTH_FRAC_MAX");
    // Line pitch also comes from the contract now, not a local ratio.
    expect(renderer).not.toContain("LINE_SPACING_RATIO");
  });

  it("resolves the same weight-900 Chinese face as the bilingual renderer", async () => {
    const family = (await evalJson("mod._load_font_named(72)[1]")) as string;
    expect(family).toMatch(/Black|Heavy/);
  });

  it("treats Pillow's fallback face as no font at all", async () => {
    // The built-in default cannot render Chinese, so main() must exit rather
    // than emit a page of tofu.
    await expect(
      evalJson('mod._load_font(72) is None', 'mod.ZH_FONT_CANDIDATES.clear(); mod._load_font_named.cache_clear()'),
    ).resolves.toBe(true);
  });
});

describe("render-subtitles.py: type size", () => {
  it("takes one fixed size from the shared contract", async () => {
    await expect(evalJson("mod.ZH_FONT_SIZE")).resolves.toBe(30);
  });

  it("has no adaptive size search left", async () => {
    // It used to pick the largest size in 52-72px that kept a cue on one line.
    // That made captions differ from the bilingual row AND change size cue to
    // cue; long cues wrap now instead of shrinking.
    const renderer = await readFile(scriptPath, "utf8");
    expect(renderer).not.toContain("ZH_MIN_FONT_SIZE");
    expect(renderer).not.toContain("ZH_MAX_FONT_SIZE");
    expect(renderer).not.toContain("_fits_all");
  });
});

describe("render-subtitles.py: canvas padding", () => {
  const padding = (videoHeight: number) =>
    evalJson(`list(mod._canvas_padding(mod.zh_shadow(${videoHeight})))`);

  it("reserves room for the hairline outline and the blurred shadow", async () => {
    // 720p: outline 1 + blur sigma 10 above; outline 1 + (offset 4 + 2*10) below.
    await expect(padding(720)).resolves.toEqual([11, 25]);
  });

  it("is constant per resolution, so captions never shift between cues", async () => {
    // burn-subtitles.ts overlays each PNG at `H-h-margin`, pinning its BOTTOM
    // edge to the frame. The old background box padded by 0.45 * font size, so
    // a cue that picked a smaller font sat several px lower than its neighbour.
    // Both padding values must now depend only on resolution.
    const at720 = (await padding(720)) as number[];
    const alsoAt720 = (await padding(720)) as number[];
    expect(at720).toEqual(alsoAt720);
    // 1080p: outline 1 + sigma 15 above; outline 1 + (offset 6 + 2*15) below.
    await expect(padding(1080)).resolves.toEqual([16, 37]);
  });
});

describe("render-subtitles.py: rendering", () => {
  /** Set up the module at a resolution, lay out cues, and pick the row height. */
  const setup = (texts: string[], videoHeight = 720) =>
    [
      `mod.VIDEO_WIDTH = ${Math.round((videoHeight / 720) * 1280)}`,
      `mod.VIDEO_HEIGHT = ${videoHeight}`,
      `mod.ZH_FONT_SIZE = round(30 * ${videoHeight} / 720)`,
      `layouts = [mod.layout_subtitle(t) for t in ${JSON.stringify(texts)}]`,
      `row_h = mod.row_height(layouts, mod.zh_shadow(${videoHeight}))`,
      "imgs = [mod.render_subtitle(l, row_h) for l in layouts]",
    ].join("; ");

  const ONE_LINE = "我用 AI 做了整个视频";
  const TWO_LINE = "这不是 AI 生成的画面 全部手工完成 逐帧调整过时间轴和排版 还反复校对了术语";

  it("renders white glyphs on a fully transparent canvas — no background box", async () => {
    const [width, cornerAlpha, maxAlpha, whitePixels] = (await evalJson(
      [
        "[imgs[0].width, imgs[0].getpixel((0, 0))[3], max(px[3] for px in imgs[0].getdata()),",
        " sum(1 for px in imgs[0].getdata() if px[:3] == (255, 255, 255) and px[3] == 255)]",
      ].join(""),
      setup([ONE_LINE]),
    )) as [number, number, number, number];
    expect(width).toBe(1280);
    // A background box would have made the corner opaque; it must be clear.
    expect(cornerAlpha).toBe(0);
    expect(maxAlpha).toBe(255);
    // And there must actually be opaque white text on it.
    expect(whitePixels).toBeGreaterThan(1000);
  });

  it("gives every cue in a video identical PNG dimensions", async () => {
    // ffmpeg's image2 input reconfigures its filter graph when a frame changes
    // size, which disturbs the whole overlay chain. The renderer used to emit a
    // different height per cue, so that happened at nearly every cue boundary.
    await expect(
      evalJson("sorted({(i.width, i.height) for i in imgs})", setup([ONE_LINE, TWO_LINE, "短句"])),
    ).resolves.toHaveLength(1);
  });

  it("puts every cue's last baseline on the same line", async () => {
    // The overlay pins each PNG's BOTTOM edge to the frame, so a cue that wraps
    // (and therefore picks a smaller type size) must still land its final line
    // where its neighbours land theirs — otherwise captions bob between cues.
    const lastInkRows = (await evalJson(
      [
        "[max((y for y in range(i.height)",
        "      for x in range(0, i.width, 2) if i.getpixel((x, y))[3] > 200), default=-1)",
        " for i in imgs]",
      ].join(""),
      setup([ONE_LINE, TWO_LINE, "短句"]),
    )) as number[];
    // Ink bottoms differ by at most a pixel of glyph variation, not by the
    // several-pixel descent gap that size-dependent anchoring produced.
    expect(Math.max(...lastInkRows) - Math.min(...lastInkRows)).toBeLessThanOrEqual(1);
  });

  it("grows a wrapped cue upward, not downward", async () => {
    const [oneLineTop, twoLineTop] = (await evalJson(
      [
        "[min((y for y in range(i.height)",
        "      for x in range(0, i.width, 2) if i.getpixel((x, y))[3] > 200), default=i.height)",
        " for i in imgs]",
      ].join(""),
      setup([ONE_LINE, TWO_LINE]),
    )) as number[];
    expect(twoLineTop).toBeLessThan(oneLineTop!);
  });

  it("scales with resolution instead of pinning type to absolute px", async () => {
    // The old renderer kept its px range at every resolution while the wrap
    // width scaled with the frame, so 1080p captions came out relatively
    // smaller and wrapped differently.
    const at720 = (await evalJson("layouts[0].size", setup([ONE_LINE], 720))) as number;
    const at1080 = (await evalJson("layouts[0].size", setup([ONE_LINE], 1080))) as number;
    expect(at720).toBe(30);
    expect(at1080).toBe(45);
  });

  it("keeps every cue at the same size, wrapping the long one", async () => {
    const sizes = (await evalJson(
      "[l.size for l in layouts]",
      setup([ONE_LINE, TWO_LINE, "短句"]),
    )) as number[];
    expect(new Set(sizes).size).toBe(1);
  });

  it("wraps a long cue rather than overflowing the safe area", async () => {
    await expect(evalJson("len(layouts[0].lines)", setup([ONE_LINE]))).resolves.toBe(1);
    const wrapped = (await evalJson("len(layouts[0].lines)", setup([TWO_LINE]))) as number;
    expect(wrapped).toBeGreaterThan(1);
  });

  it("spaces wrapped lines on the shared pitch, not its own ratio", async () => {
    // 1.65em, the same value the bilingual renderer uses; this row used to add
    // 0.55em on top of the face's line height for a 2.00em pitch.
    const [size, lineHeight, gap] = (await evalJson(
      "[layouts[0].size, layouts[0].line_height, layouts[0].gap]",
      setup([TWO_LINE]),
    )) as [number, number, number];
    expect(lineHeight + gap).toBe(Math.round(size * 1.65));
  });
});
