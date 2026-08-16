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
  "subtitle_style.py",
);

const evalJson = async (expression: string): Promise<unknown> => {
  const { stdout } = await execFileAsync("python3", [
    "-c",
    [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location("subtitle_style", ${JSON.stringify(scriptPath)})`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      `print(json.dumps(${expression}))`,
    ].join("; "),
  ]);
  return JSON.parse(stdout.trim());
};

describe("subtitle_style.py: the two renderers agree on Chinese", () => {
  const acquireDir = path.dirname(scriptPath);

  /**
   * Render one Chinese cue through BOTH renderers and compare the opaque glyph
   * pixels. This is the claim the shared contract exists to make — single-
   * language delivery is the bilingual Chinese row with the English row
   * removed — and it is the one assertion that catches any drift the
   * constant-by-constant checks miss (outline method, centring arithmetic,
   * wrap measure, text treatment).
   */
  const glyphDiff = async (zh: string, en: string): Promise<[number, number]> => {
    const { stdout } = await execFileAsync("python3", [
      "-c",
      `
import importlib.util, json, os, sys, tempfile
from PIL import Image
sys.path.insert(0, ${JSON.stringify(acquireDir)})

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

mono = load("mono", ${JSON.stringify(path.join(acquireDir, "render-subtitles.py"))})
bi = load("bi", ${JSON.stringify(path.join(acquireDir, "render-bilingual-subtitles.py"))})

zh, en = ${JSON.stringify(zh)}, ${JSON.stringify(en)}

layouts = [mono.layout_subtitle(zh)]
row_h = mono.row_height(layouts, mono.zh_shadow(720))
mono_img = mono.render_subtitle(layouts[0], row_h)

# Go through the bilingual renderer's real Chinese-row path rather than a
# reimplementation of it — a hand-rolled copy here could hide the very drift
# this test exists to catch. It writes straight to disk, so give it a temp file.
zh_fs = bi.zh_font_set(bi.ZH_FONT_SIZE)
lines, baselines, block_h = bi.measure_text_block(
    bi.zh_caption_text(zh), zh_fs, bi.ZH_OUTLINE_PX, bi.zh_shadow(720)
)
with tempfile.TemporaryDirectory() as td:
    out = os.path.join(td, "zh.png")
    bi.render_text_row(lines, baselines, zh_fs, bi.ZH_OUTLINE_PX, bi.ZH_FILL,
                       bi.zh_shadow(720), block_h, True, out)
    bi_img = Image.open(out).convert("RGBA")

# Compare the FULLY OPAQUE glyph body: fill and outline pixels, which the soft
# drop shadow never shows through. The shadow's own tail is clipped differently
# by each path's canvas height — that is layout, not look, so it is excluded.
def opaque_box(im):
    return im.getchannel("A").point(lambda v: 255 if v == 255 else 0).getbbox()

ca = mono_img.crop(opaque_box(mono_img))
cb = bi_img.crop(opaque_box(bi_img))
if ca.size != cb.size:
    print(json.dumps([-1, -1])); raise SystemExit

pa, pb = ca.load(), cb.load()
worst = changed = 0
for y in range(ca.size[1]):
    for x in range(ca.size[0]):
        A, B = pa[x, y], pb[x, y]
        if A[3] == 255 or B[3] == 255:
            if A != B:
                changed += 1
                worst = max(worst, max(abs(A[i] - B[i]) for i in range(4)))
print(json.dumps([worst, changed]))
`,
    ]);
    return JSON.parse(stdout.trim()) as [number, number];
  };

  it("renders a one-line cue identically in both paths", async () => {
    const [worst, changed] = await glyphDiff(
      "我用 AI 做了整个解释器视频，全部手工。",
      "I made this entire AI explainer by hand",
    );
    expect(worst).toBe(0);
    expect(changed).toBe(0);
  });

  it("renders a wrapped cue identically in both paths", async () => {
    // Wrapping is where the two used to diverge hardest: this renderer wrapped
    // on the ink bounding box while the other wrapped on advance width, so the
    // same sentence could break at a different character.
    const [worst, changed] = await glyphDiff(
      "这不是 AI 生成的画面，全部手工完成，逐帧调整过时间轴和排版，还反复校对了所有术语。",
      "Not AI-generated footage; every frame adjusted by hand",
    );
    expect(worst).toBe(0);
    expect(changed).toBe(0);
  });
});

describe("subtitle_style.py: Chinese shadow", () => {
  it("puts the shadow straight down per the CSS `0 4px`", async () => {
    await expect(evalJson("[mod.zh_shadow(720).dx, mod.zh_shadow(720).dy]")).resolves.toEqual([
      0, 4,
    ]);
  });

  it("halves the CSS blur radius into a Pillow sigma", async () => {
    // CSS states blur as 2-sigma, Pillow's GaussianBlur radius IS sigma, so
    // the spec's 20px must reach Pillow as 10 or the shadow doubles in spread.
    await expect(evalJson("mod.ZH_SHADOW_CSS_BLUR_PX")).resolves.toBe(20);
    await expect(evalJson("mod.zh_shadow(720).blur")).resolves.toBe(10);
  });

  it("resolves to black at 50%", async () => {
    await expect(evalJson("mod.zh_shadow(720).color")).resolves.toEqual([0, 0, 0, 128]);
  });

  it("scales with resolution, not with type size", async () => {
    // This is the whole reason the Chinese shadow is absolute px rather than a
    // fraction of the font: the single-language renderer picks a different type
    // size per cue, so a font-relative shadow would change weight from one
    // caption to the next. One resolution means one shadow.
    await expect(
      evalJson("[mod.zh_shadow(1080).dx, mod.zh_shadow(1080).dy, mod.zh_shadow(1080).blur]"),
    ).resolves.toEqual([0, 6, 15]);
    await expect(
      evalJson("[mod.zh_shadow(2160).dx, mod.zh_shadow(2160).dy, mod.zh_shadow(2160).blur]"),
    ).resolves.toEqual([0, 12, 30]);
  });

  it("reserves vertical room for the offset plus the blur spread", async () => {
    await expect(evalJson("mod.zh_shadow(720).vertical_pad()")).resolves.toBe(4 + 10 * 2);
  });
});

describe("subtitle_style.py: English shadow", () => {
  it("stays down-right and lighter, relative to its own font size", async () => {
    const at16 = (await evalJson(
      "[mod.en_shadow(16).dx, mod.en_shadow(16).dy, mod.en_shadow(16).blur, mod.en_shadow(16).color]",
    )) as [number, number, number, number[]];
    expect(at16[0]).toBe(1);
    expect(at16[1]).toBe(1);
    expect(at16[2]).toBeCloseTo(1.6);
    expect(at16[3]).toEqual([64, 64, 64, 107]);
  });

  it("scales with the font size it is given", async () => {
    await expect(evalJson("mod.en_shadow(24).blur")).resolves.toBeCloseTo(2.4);
  });
});

describe("subtitle_style.py: fonts", () => {
  it("asks for weight 900 on the Chinese chain only", async () => {
    // The English row sits next to Inter Bold, not next to the Heavy
    // Chinese row above it, so its CJK slot must not inherit Black.
    await expect(evalJson("[c[3] for c in mod.ZH_FONT_CANDIDATES]")).resolves.toContain("Black");
    await expect(evalJson("[c[3] for c in mod.EN_CJK_FONT_CANDIDATES]")).resolves.not.toContain(
      "Black",
    );
    await expect(evalJson("[c[3] for c in mod.EN_CJK_FONT_CANDIDATES]")).resolves.toContain(
      "Bold",
    );
  });

  it("heads the English chain with the vendored Inter, not a host font", async () => {
    const head = (await evalJson("mod.EN_FONT_CANDIDATES[0][0]")) as string;
    expect(head).toContain("src/acquire/fonts/Inter-Bold.ttf");
    await expect(evalJson("mod.find_font(mod.EN_FONT_CANDIDATES, 16)[1]")).resolves.toBe(
      "Inter Bold",
    );
  });

  it("resolves the Chinese chain to a weight-900 face on this host", async () => {
    const family = (await evalJson("mod.find_font(mod.ZH_FONT_CANDIDATES, 30)[1]")) as string;
    expect(family).toMatch(/Black|Heavy/);
  });

  it("warns only when the resolved Chinese face is not weight 900", async () => {
    await expect(evalJson('mod.zh_weight_warning("Noto Sans SC Black")')).resolves.toBeNull();
    await expect(evalJson('mod.zh_weight_warning("Source Han Sans SC Heavy")')).resolves.toBeNull();
    const warning = (await evalJson('mod.zh_weight_warning("PingFang SC")')) as string;
    expect(warning).toContain("PingFang SC");
    expect(warning).toContain("weight-900");
  });
});

describe("subtitle_style.py: shared look", () => {
  it("keeps both rows white with the English accent on #FFD928", async () => {
    await expect(evalJson("mod.ZH_FILL")).resolves.toEqual([255, 255, 255, 255]);
    await expect(evalJson("mod.EN_FILL")).resolves.toEqual([255, 255, 255, 255]);
    await expect(evalJson("mod.EN_HIGHLIGHT_FILL")).resolves.toEqual([255, 217, 40, 255]);
    await expect(evalJson("mod.OUTLINE_COLOR")).resolves.toEqual([0, 0, 0, 255]);
  });

  it("accents the standalone word AI only", async () => {
    await expect(evalJson('[m.group(0) for m in mod.EN_HIGHLIGHT_RE.finditer("an AI video")]'))
      .resolves.toEqual(["AI"]);
    await expect(
      evalJson('[m.group(0) for m in mod.EN_HIGHLIGHT_RE.finditer("AIs and SAIL and Thai")]'),
    ).resolves.toEqual([]);
  });

  it("keeps the same hairline outline on both rows", async () => {
    await expect(evalJson("mod.ZH_OUTLINE_PX")).resolves.toBe(1);
    await expect(evalJson("mod.EN_OUTLINE_PX")).resolves.toBe(1);
  });

  it("tracks English at 0.02em and Chinese not at all", async () => {
    await expect(evalJson("mod.ZH_TRACKING_EM")).resolves.toBe(0);
    await expect(evalJson("mod.EN_TRACKING_EM")).resolves.toBe(0.02);
  });

  it("holds one horizontal safe area for both renderers", async () => {
    await expect(evalJson("mod.MAX_WIDTH_FRAC")).resolves.toBe(0.8);
  });

  it("holds one line pitch, applied to each row's own size", async () => {
    await expect(evalJson("mod.LINE_PITCH_EM")).resolves.toBe(1.65);
    // The gap is the remainder after the face's own line height, so a taller
    // face gets a smaller gap and the pitch stays put.
    await expect(evalJson("mod.line_gap(72, 105, 1)")).resolves.toBe(Math.round(72 * 1.65) - 105);
    await expect(evalJson("mod.line_gap(16, 20, 0)")).resolves.toBe(Math.round(16 * 1.65) - 20);
  });

  it("never lets the pitch squeeze below what the outline needs", async () => {
    // A face reporting an unusually tall line height must not push the gap
    // negative and let hairlines from adjacent lines collide.
    await expect(evalJson("mod.line_gap(30, 999, 1)")).resolves.toBe(2);
  });

  it("states its absolute pixel values at 720p", async () => {
    await expect(evalJson("mod.BASELINE_VIDEO_HEIGHT")).resolves.toBe(720);
    await expect(evalJson("mod.resolution_scale(1080)")).resolves.toBe(1.5);
    await expect(evalJson("mod.resolution_scale(720)")).resolves.toBe(1);
  });
});
