#!/usr/bin/env python3
"""Render bilingual subtitle cues as transparent PNG images for ffmpeg overlay.

Input: bilingual SRT file (Chinese line 1, English line 2 per cue)
Output: PNG frames in a directory + manifest.json

Style: BaoCut-inspired white bilingual subtitles. Simplified Chinese is bold
and outlined on top; the English source is smaller below it.
"""

import json
import math
import re
import sys
import unicodedata
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ── Style, expressed in BaoCut's own units ──
# BaoCut states outline as a 0-100 percentage and shadow distance/blur as 0-1
# fractions, both relative to the font size — so its "描边 8" and "距离 0.08"
# are the same 8%, just on different scales. Keeping them as fractions here
# means every derived pixel value scales with the font (and therefore with the
# video resolution) automatically, instead of needing its own scaled constant.
_BASE_ZH_FONT_SIZE = 30
_BASE_EN_FONT_SIZE = 16
# Deliberately NOT a BaoCut-style fraction: at 8% the outline scaled to 2-4px
# across our resolutions and read as too heavy. A hairline outline is a fixed
# visual weight regardless of font size, so it stays a constant pixel count.
ZH_OUTLINE_PX = 1          # was: ZH_OUTLINE_FRAC = 0.08 (BaoCut 描边 8)
EN_OUTLINE_PX = 0          # BaoCut 描边 无
SHADOW_ANGLE_DEG = 45        # BaoCut 阴影角度 45°

# Chinese follows BaoCut's shadow spec directly (距离 0.08 / 模糊 0.1) at a
# much lower opacity than its nominal 100%: the row's legibility on any
# background comes from its outline, so the shadow only has to hint at depth.
ZH_SHADOW_DISTANCE_FRAC = 0.08
ZH_SHADOW_BLUR_FRAC = 0.10
ZH_SHADOW_OPACITY = 0.28

# English follows the same BaoCut spec, lighter again than Chinese in relative
# terms. NOTE: with 描边 无 the shadow is the only thing separating white
# glyphs from the picture, so on a near-white background this row has very
# little contrast by construction — a displaced shadow darkens one side only.
# Raising the opacity to cover that case is what produced the "too heavy"
# look, so it stays light here; a near-white scene needs a thin edge instead.
EN_SHADOW_DISTANCE_FRAC = 0.08
EN_SHADOW_BLUR_FRAC = 0.10
EN_SHADOW_OPACITY = 0.42

ZH_FILL = (255, 255, 255, 255)
EN_FILL = (255, 255, 255, 255)  # pure white
OUTLINE_COLOR = (0, 0, 0, 255)  # pure black
SHADOW_RGB = (64, 64, 64)  # #404040
MAX_WIDTH_FRAC = 0.80

# Runtime values — set by main() after parsing video dimensions
VIDEO_WIDTH = 1280
VIDEO_HEIGHT = 720
EN_FONT_SIZE = _BASE_EN_FONT_SIZE
ZH_FONT_SIZE = _BASE_ZH_FONT_SIZE


def shadow_offset_px(font_size: int, distance_frac: float) -> tuple[int, int]:
    """Shadow displacement decomposed from BaoCut's distance + angle. 45° puts
    it down-right, the conventional direction for a caption drop shadow; a
    distance of 0 yields a centred halo instead."""
    distance = font_size * distance_frac
    rad = math.radians(SHADOW_ANGLE_DEG)
    return round(distance * math.cos(rad)), round(distance * math.sin(rad))


def shadow_rgba(opacity: float) -> tuple[int, int, int, int]:
    return (*SHADOW_RGB, round(255 * opacity))


def shadow_blur_px(font_size: int, blur_frac: float) -> float:
    """Gaussian blur radius. BaoCut's 模糊 is a real blur, not the stamped
    offset trail this renderer used to fake it with."""
    return font_size * blur_frac


# Lexend Deca is the requested face for BOTH rows, but it carries no CJK
# glyphs (Chinese renders as .notdef tofu), so it can only be the head of a
# fallback chain: Latin/digits in Lexend Deca, CJK in a Chinese face. The app
# bundle is checked first since that is where Lexend Deca actually ships —
# it is not installed system-wide.
LATIN_FONT_CANDIDATES = [
    ("/Applications/BaoCut.app/Contents/Resources/fonts/LexendDeca.ttf", 0, "Lexend Deca"),
    (str(Path.home() / "Library/Fonts/LexendDeca.ttf"), 0, "Lexend Deca"),
    ("/Library/Fonts/LexendDeca.ttf", 0, "Lexend Deca"),
    ("/System/Library/Fonts/PingFang.ttc", 2, "PingFang SC"),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 3, "Hiragino Sans GB"),
]

# Face index picks the bold weight:
#   PingFang.ttc: 0=Regular, 1=Medium, 2=Semibold
#   Hiragino Sans GB.ttc: 0=W3, 3=W6(bold)
CJK_FONT_CANDIDATES = [
    ("/System/Library/Fonts/PingFang.ttc", 2, "PingFang SC"),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 3, "Hiragino Sans GB"),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0, "STHeiti"),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0, "Arial Unicode"),
]

def clean_subtitle_text(text: str) -> str:
    """Remove punctuation from Chinese text: in-sentence marks become a single
    space, trailing marks are dropped, and decimal points between digits
    (e.g. 4.5, v0.1) are kept."""
    collapsed = " ".join(text.replace("\n", " ").split())
    n = len(collapsed)
    out = []
    for i, ch in enumerate(collapsed):
        if unicodedata.category(ch).startswith("P"):
            is_decimal = (
                ch == "."
                and 0 < i < n - 1
                and collapsed[i - 1].isdigit()
                and collapsed[i + 1].isdigit()
            )
            out.append(ch if is_decimal else " ")
        else:
            out.append(ch)
    return " ".join("".join(out).split())


_CJK_CLASS = r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]"
_CJK_THEN_LATIN = re.compile(f"({_CJK_CLASS})([A-Za-z0-9])")
_LATIN_THEN_CJK = re.compile(f"([A-Za-z0-9])({_CJK_CLASS})")


def space_cjk_latin(text: str) -> str:
    """Insert a space at every CJK↔Latin boundary, the standard CJK
    typesetting convention: "我的Grill Me和..." reads as
    "我的 Grill Me 和...". Without it the embedded product names run straight
    into the surrounding Chinese with no visual separation."""
    spaced = _CJK_THEN_LATIN.sub(r"\1 \2", text)
    spaced = _LATIN_THEN_CJK.sub(r"\1 \2", spaced)
    return spaced


def find_font(
    candidates: list[tuple[str, int, str]], size: int
) -> tuple[ImageFont.FreeTypeFont, str]:
    """Load the first available candidate, requesting its Bold named instance
    when the file is a variable font (Lexend Deca ships as one, so 'style
    \u52a0\u7c97' means selecting that instance rather than faking weight)."""
    for path, face_index, family_name in candidates:
        if Path(path).exists():
            try:
                font = ImageFont.truetype(path, size, index=face_index)
            except Exception:
                continue
            try:
                if b"Bold" in font.get_variation_names():
                    font.set_variation_by_name("Bold")
            except Exception:
                pass  # static face \u2014 its index already selects the weight
            return font, family_name
    return ImageFont.load_default(), "Pillow default"


class ShadowStyle:
    """One row's resolved shadow: pixel offset, blur radius and RGBA."""

    def __init__(self, font_size: int, distance_frac: float, blur_frac: float, opacity: float):
        self.dx, self.dy = shadow_offset_px(font_size, distance_frac)
        self.blur = shadow_blur_px(font_size, blur_frac)
        self.color = shadow_rgba(opacity)

    def vertical_pad(self) -> int:
        return self.dy + math.ceil(self.blur) * 2


class FontSet:
    """Latin + CJK face pair standing in for one font-fallback chain, since
    Pillow resolves no fallbacks itself: each draw call uses exactly the font
    it is handed, so mixed-script text has to be split into runs."""

    def __init__(self, size: int):
        self.size = size
        self.latin, self.latin_name = find_font(LATIN_FONT_CANDIDATES, size)
        self.cjk, self.cjk_name = find_font(CJK_FONT_CANDIDATES, size)

    def font_for(self, kind: str) -> ImageFont.FreeTypeFont:
        return self.latin if kind == "latin" else self.cjk

    def metrics(self) -> tuple[int, int]:
        """Shared (ascent, descent) so both faces sit on one baseline."""
        la, ld = self.latin.getmetrics()
        ca, cd = self.cjk.getmetrics()
        return max(la, ca), max(ld, cd)


@lru_cache(maxsize=None)
def font_set(size: int) -> FontSet:
    return FontSet(size)


# Tokenizer: a Latin/number word (with inner . ' - kept, e.g. 4.5, v0.1,
# don't), OR a run of whitespace, OR any single other char (e.g. one CJK char).
_TOKEN_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z.'\u2019\-]*|\s+|.", re.S)

LATIN_ALNUM_PATTERN = re.compile(r"[A-Za-z0-9]")


def _token_kind(tok: str) -> str:
    return "latin" if LATIN_ALNUM_PATTERN.match(tok[0]) else "cjk"


def font_runs(text: str) -> list[tuple[str, str]]:
    """Split text into consecutive (run_text, kind) pairs that each render in
    a single face. Whitespace and punctuation inherit the preceding run's face
    so spacing stays consistent with the words around it."""
    runs: list[list[str]] = []
    kinds: list[str] = []
    for tok in _TOKEN_RE.findall(text):
        kind = kinds[-1] if (tok.isspace() or not tok.strip()) and kinds else None
        if kind is None:
            kind = _token_kind(tok) if tok.strip() else "latin"
        if kinds and kinds[-1] == kind:
            runs[-1].append(tok)
        else:
            runs.append([tok])
            kinds.append(kind)
    return [("".join(parts), kind) for parts, kind in zip(runs, kinds)]


def _line_width(text: str, fs: FontSet, draw: ImageDraw.ImageDraw) -> int:
    """Advance width of mixed-script text, summed per font run (each run is
    measured whole so intra-run kerning is preserved)."""
    return round(sum(draw.textlength(run, font=fs.font_for(kind)) for run, kind in font_runs(text)))


def wrap_text(
    text: str,
    fs: FontSet,
    max_width: int,
    draw: ImageDraw.ImageDraw,
) -> list[str]:
    """Wrap text to fit max_width without ever splitting a Latin/number word.

    Breaks prefer space boundaries; CJK characters may break between characters
    since they have no word boundaries. Cleaned punctuation is already spaces,
    so breaks naturally land where punctuation used to be.
    """
    if not text:
        return [""]

    if _line_width(text, fs, draw) <= max_width:
        return [text]

    lines: list[str] = []
    current = ""
    for tok in _TOKEN_RE.findall(text):
        if tok.isspace():
            if current:
                current += " "  # collapse any whitespace run to a single space
            continue
        cand = current + tok
        if current.strip() and _line_width(cand, fs, draw) > max_width:
            lines.append(current.strip())
            current = tok
        else:
            current = cand
    if current.strip():
        lines.append(current.strip())
    return lines or [""]


def parse_srt(srt_path: str) -> list[dict]:
    """Parse bilingual SRT file, return list of cues."""
    cues = []
    with open(srt_path, encoding="utf-8") as f:
        content = f.read()

    for block in content.strip().split("\n\n"):
        lines = [l.strip() for l in block.split("\n") if l.strip()]
        if len(lines) < 3:
            continue

        timing_match = re.match(
            r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*"
            r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})",
            lines[1],
        )
        if not timing_match:
            continue

        start_s = (
            int(timing_match.group(1)) * 3600
            + int(timing_match.group(2)) * 60
            + int(timing_match.group(3))
            + int(timing_match.group(4)) / 1000
        )
        end_s = (
            int(timing_match.group(5)) * 3600
            + int(timing_match.group(6)) * 60
            + int(timing_match.group(7))
            + int(timing_match.group(8)) / 1000
        )

        text_lines = lines[2:]
        # First line = Chinese (top), rest = English (bottom)
        zh_text = space_cjk_latin(clean_subtitle_text(text_lines[0])) if text_lines else ""
        en_text = " ".join(text_lines[1:]).strip() if len(text_lines) > 1 else ""

        cues.append(
            {
                "index": int(lines[0]),
                "start_s": start_s,
                "end_s": end_s,
                "zh_text": zh_text,
                "en_text": en_text,
            }
        )
    return cues


def draw_mixed_line(
    draw: ImageDraw.ImageDraw,
    text: str,
    x: int,
    baseline_y: int,
    fs: FontSet,
    fill: tuple[int, int, int, int],
    outline_width: int,
    outline_color: tuple[int, int, int, int] = OUTLINE_COLOR,
):
    """Draw one line of possibly mixed-script text on a shared baseline,
    switching faces per run (Latin in Lexend Deca, CJK in the Chinese face).
    Anchored "ls" (left-baseline) so the two faces' differing ascents cannot
    make their glyphs sit at different heights."""
    cursor = float(x)
    for run, kind in font_runs(text):
        font = fs.font_for(kind)
        if outline_width > 0:
            for dx in range(-outline_width, outline_width + 1):
                for dy in range(-outline_width, outline_width + 1):
                    if dx == 0 and dy == 0:
                        continue
                    draw.text(
                        (cursor + dx, baseline_y + dy), run,
                        font=font, fill=outline_color, anchor="ls",
                    )
        draw.text((cursor, baseline_y), run, font=font, fill=fill, anchor="ls")
        cursor += draw.textlength(run, font=font)


def measure_lines(
    text_lines: list[str],
    fs: FontSet,
    draw: ImageDraw.ImageDraw,
    *,
    outline_width: int = 0,
) -> tuple[int, int, list[int]]:
    """Measure wrapped lines on a uniform baseline grid.

    Returns (max_width, total_height, baseline_offsets) where each baseline
    offset is relative to the top of the block. Line height comes from font
    metrics rather than per-line ink bounds, so lines never shift vertically
    just because their particular characters happen to have no descender.
    """
    ascent, descent = fs.metrics()
    gap = max(2, outline_width * 2)
    line_h = ascent + descent
    max_w = 0
    baselines = []
    for i, line_text in enumerate(text_lines):
        max_w = max(max_w, _line_width(line_text, fs, draw))
        baselines.append(i * (line_h + gap) + ascent)
    total_h = len(text_lines) * line_h + max(0, len(text_lines) - 1) * gap
    return max_w, total_h, baselines


def group_zh_runs(cues: list[dict]) -> list[dict]:
    """Collapse consecutive cues sharing identical zh_text into one run.

    A translated piece that spans several English sub-cues shows the SAME
    Chinese text on each of them (see semantic-bilingual-subtitles.ts's
    mergeShortPieces/mergeBriefBlocks) — that's the intended "one static
    Chinese caption over several short English captions" shape, not a
    rendering duplicate. Collapsing the run here means the whole span reuses
    ONE rendered image, so the Chinese layer never re-selects or resizes
    while only the English underneath is changing.
    """
    runs: list[dict] = []
    for cue in cues:
        if runs and runs[-1]["zh_text"] == cue["zh_text"]:
            runs[-1]["end_s"] = cue["end_s"]
        else:
            runs.append({
                "zh_text": cue["zh_text"],
                "start_s": cue["start_s"],
                "end_s": cue["end_s"],
            })
    return runs


def measure_text_block(
    text: str,
    fs: FontSet,
    outline_width: int,
    shadow: "ShadowStyle",
) -> tuple[list[str], list[int], int]:
    """Wrap + measure one language's text. Returns (lines, baselines, block_h),
    where block_h includes the vertical room the outline and drop shadow need."""
    max_text_width = int(VIDEO_WIDTH * MAX_WIDTH_FRAC)
    temp_draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    lines = wrap_text(text, fs, max_text_width, temp_draw)
    _, total_h, baselines = measure_lines(lines, fs, temp_draw, outline_width=outline_width)
    pad_v = outline_width * 2 + shadow.vertical_pad() + 4
    return lines, baselines, total_h + pad_v


def render_text_row(
    lines: list[str],
    baselines: list[int],
    fs: FontSet,
    outline_width: int,
    fill: tuple[int, int, int, int],
    shadow: "ShadowStyle",
    row_h: int,
    align_bottom: bool,
    out_path: Path,
) -> tuple[int, int]:
    """Render one language's text horizontally centered on a FIXED-SIZE
    canvas: the full video width by this layer's constant row height.

    Every PNG in a layer therefore has identical dimensions. That matters for
    two reasons: ffmpeg's image2 sequence never has to reconfigure its filter
    graph mid-stream (a size change there momentarily disturbs the whole
    overlay chain — the real cause of the Chinese row flickering exactly when
    the English row switched cues), and centering is exact by construction
    rather than depending on `overlay=(W-w)/2` re-deriving it from a
    per-frame image width.

    The drop shadow is drawn on its own layer, offset per BaoCut's
    distance/angle and then Gaussian-blurred by its blur radius, so "模糊" is
    a real blur instead of the stamped offset trail that used to fake it.

    `align_bottom` pins content to the bottom of its row (used for the
    Chinese row, so its last line stays a constant distance above the English
    row regardless of how many lines it wrapped to); otherwise content is
    pinned to the top (used for English, directly under Chinese)."""
    temp_draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    ascent, descent = fs.metrics()
    gap = max(2, outline_width * 2)
    content_h = len(lines) * (ascent + descent) + max(0, len(lines) - 1) * gap
    blur = shadow.blur
    pad_top = outline_width + math.ceil(blur)
    y0 = (row_h - content_h - pad_top - math.ceil(blur)) if align_bottom else pad_top

    line_x = [(VIDEO_WIDTH - _line_width(t, fs, temp_draw)) // 2 for t in lines]

    shadow_dx, shadow_dy = shadow.dx, shadow.dy
    shadow_layer = Image.new("RGBA", (VIDEO_WIDTH, row_h), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_layer)
    for line_text, base, lx in zip(lines, baselines, line_x):
        draw_mixed_line(
            shadow_draw, line_text, lx + shadow_dx, y0 + base + shadow_dy,
            fs, shadow.color, outline_width, outline_color=shadow.color,
        )
    if blur > 0:
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=blur))

    text_layer = Image.new("RGBA", (VIDEO_WIDTH, row_h), (0, 0, 0, 0))
    text_draw = ImageDraw.Draw(text_layer)
    for line_text, base, lx in zip(lines, baselines, line_x):
        draw_mixed_line(text_draw, line_text, lx, y0 + base, fs, fill, outline_width)

    img = Image.alpha_composite(shadow_layer, text_layer)
    img.save(out_path)
    return VIDEO_WIDTH, row_h


def main():
    global VIDEO_WIDTH, VIDEO_HEIGHT, EN_FONT_SIZE, ZH_FONT_SIZE
    # Parse args: <srt> <out_dir> [--video-width W] [--video-height H]
    args = sys.argv[1:]
    srt_path = None
    out_dir = None
    measure_path = None
    output_path = None
    video_w = 1280
    video_h = 720

    i = 0
    while i < len(args):
        if args[i] == "--measure" and i + 1 < len(args):
            measure_path = args[i + 1]
            i += 2
        elif args[i] == "--output" and i + 1 < len(args):
            output_path = args[i + 1]
            i += 2
        elif args[i] == "--video-width" and i + 1 < len(args):
            video_w = int(args[i + 1])
            i += 2
        elif args[i] == "--video-height" and i + 1 < len(args):
            video_h = int(args[i + 1])
            i += 2
        elif srt_path is None:
            srt_path = args[i]
            i += 1
        elif out_dir is None:
            out_dir = args[i]
            i += 1
        else:
            i += 1

    if measure_path is None and (srt_path is None or out_dir is None):
        print(
            f"Usage: {sys.argv[0]} <bilingual.srt> <output_dir> "
            f"[--video-width W] [--video-height H]",
            file=sys.stderr,
        )
        sys.exit(1)

    # Scale fonts/outlines with resolution so wrapping density stays constant.
    # max_text_width already scales with VIDEO_WIDTH, so fonts must match it;
    # otherwise high-res video keeps a small font against a wide wrap limit,
    # producing over-long unwrapped lines. Baseline is 720p (height 720).
    VIDEO_WIDTH = video_w
    VIDEO_HEIGHT = video_h
    scale = VIDEO_HEIGHT / 720
    ZH_FONT_SIZE = round(_BASE_ZH_FONT_SIZE * scale)
    EN_FONT_SIZE = round(_BASE_EN_FONT_SIZE * scale)
    zh_fs = font_set(ZH_FONT_SIZE)
    en_fs = font_set(EN_FONT_SIZE)
    zh_outline = ZH_OUTLINE_PX
    en_outline = EN_OUTLINE_PX
    zh_shadow = ShadowStyle(
        ZH_FONT_SIZE, ZH_SHADOW_DISTANCE_FRAC, ZH_SHADOW_BLUR_FRAC, ZH_SHADOW_OPACITY
    )
    en_shadow = ShadowStyle(
        EN_FONT_SIZE, EN_SHADOW_DISTANCE_FRAC, EN_SHADOW_BLUR_FRAC, EN_SHADOW_OPACITY
    )
    cues = parse_srt(measure_path or srt_path)
    if not cues:
        print("ERROR: no cues found in SRT", file=sys.stderr)
        sys.exit(1)

    if measure_path is not None:
        if output_path is None:
            print("ERROR: --measure requires --output", file=sys.stderr)
            sys.exit(1)
        draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
        fit_width = int(VIDEO_WIDTH * MAX_WIDTH_FRAC)
        metrics = []
        for cue in cues:
            raw_width = _line_width(cue["zh_text"], zh_fs, draw)
            zh_lines = wrap_text(cue["zh_text"], zh_fs, fit_width, draw)
            en_lines = wrap_text(cue["en_text"], en_fs, fit_width, draw)
            line_count = max(len(zh_lines), len(en_lines))
            severity = "fit" if raw_width <= fit_width and line_count == 1 else (
                "aim" if line_count <= 2 else "hard"
            )
            metrics.append({
                "cueIndex": cue["index"],
                "zhWidth": raw_width,
                "fitWidth": fit_width,
                "lineCount": line_count,
                "severity": severity,
                "resolvedFonts": {
                    "zh": f"{zh_fs.latin_name} + {zh_fs.cjk_name}",
                    "en": en_fs.latin_name,
                },
            })
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(metrics, f, ensure_ascii=False)
        return

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Video: {VIDEO_WIDTH}x{VIDEO_HEIGHT}", file=sys.stderr)
    print(
        f"ZH font: {zh_fs.latin_name} (latin) + {zh_fs.cjk_name} (cjk) "
        f"{ZH_FONT_SIZE}px outline={zh_outline}px",
        file=sys.stderr,
    )
    print(
        f"EN font: {en_fs.latin_name} (latin) + {en_fs.cjk_name} (cjk) "
        f"{EN_FONT_SIZE}px outline={en_outline}px",
        file=sys.stderr,
    )
    for label, sh in (("zh", zh_shadow), ("en", en_shadow)):
        print(
            f"Shadow[{label}]: offset=({sh.dx},{sh.dy}) blur={sh.blur:.2f} alpha={sh.color[3]}",
            file=sys.stderr,
        )

    # Two independent layers: a ZH run only re-renders (and only re-selects a
    # different frame) when the Chinese text itself actually changes, never
    # because the English cue underneath moved on to its next fragment.
    #
    # Pass 1 measures every block so each layer can pick ONE constant row
    # height; pass 2 renders every block onto that fixed-size canvas.
    zh_runs = group_zh_runs(cues)

    zh_layouts = [
        measure_text_block(run["zh_text"], zh_fs, zh_outline, zh_shadow) for run in zh_runs
    ]
    en_layouts = [
        measure_text_block(cue["en_text"], en_fs, en_outline, en_shadow) for cue in cues
    ]
    zh_row_h = max((h for _, _, h in zh_layouts), default=0) or 1
    en_row_h = max((h for _, _, h in en_layouts), default=0) or 1

    total_units = len(zh_runs) + len(cues)
    done = 0

    zh_entries = []
    for i, (run, (lines, baselines, _)) in enumerate(zip(zh_runs, zh_layouts)):
        filename = f"zh_{i:04d}.png"
        w, h = render_text_row(
            lines, baselines, zh_fs, zh_outline, ZH_FILL, zh_shadow, zh_row_h,
            True, out_dir / filename,
        )
        zh_entries.append({
            "index": i, "filename": filename,
            "start": run["start_s"], "end": run["end_s"],
            "width": w, "height": h,
        })
        done += 1
        if done % 25 == 0 or done == total_units:
            print(f"PROGRESS {done}/{total_units}", flush=True)

    en_entries = []
    for cue, (lines, baselines, _) in zip(cues, en_layouts):
        filename = f"en_{cue['index']:04d}.png"
        w, h = render_text_row(
            lines, baselines, en_fs, en_outline, EN_FILL, en_shadow, en_row_h,
            False, out_dir / filename,
        )
        en_entries.append({
            "index": cue["index"], "filename": filename,
            "start": cue["start_s"], "end": cue["end_s"],
            "width": w, "height": h,
        })
        done += 1
        if done % 25 == 0 or done == total_units:
            print(f"PROGRESS {done}/{total_units}", flush=True)

    # Log a sample for debugging
    if cues:
        sample = cues[len(cues) // 2]
        print(
            f"Sample cue #{sample['index']}: "
            f"ZH='{sample['zh_text'][:50]}...' "
            f"EN='{sample['en_text'][:50]}...'",
            file=sys.stderr,
        )

    manifest = {
        "zh_cues": zh_entries,
        "en_cues": en_entries,
        "video_width": VIDEO_WIDTH,
        "video_height": 0,
    }
    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f)

    print(
        f"Rendered {len(zh_runs)} ZH runs + {len(cues)} EN cues to {out_dir}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
