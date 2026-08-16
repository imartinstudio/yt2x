#!/usr/bin/env python3
"""Render bilingual subtitle cues as transparent PNG images for ffmpeg overlay.

Input: bilingual SRT file (Chinese line 1, English line 2 per cue)
Output: PNG frames in a directory + manifest.json

Style: white bilingual subtitles. Simplified Chinese is Heavy-weight and
hairline-outlined on top; the English source is smaller below it.
"""

import json
import math
import re
import sys
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# The shared visual contract lives next to this script. It has to be added to
# the import path explicitly: this file is run as `python3 <path>` and is also
# loaded by tests via importlib.spec_from_file_location, and neither reliably
# puts its own directory on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from subtitle_style import (  # noqa: E402
    EN_CJK_FONT_CANDIDATES,
    EN_FILL,
    EN_FONT_CANDIDATES,
    EN_HIGHLIGHT_FILL,
    EN_HIGHLIGHT_RE,
    EN_OUTLINE_PX,
    EN_TRACKING_EM,
    MAX_WIDTH_FRAC,
    OUTLINE_COLOR,
    ZH_FILL,
    ZH_FONT_CANDIDATES,
    ZH_FONT_SIZE_BASE,
    ZH_OUTLINE_PX,
    ZH_TRACKING_EM,
    ShadowStyle,
    draw_outlined_runs,
    en_shadow,
    find_font,
    line_gap,
    resolution_scale,
    zh_caption_text,
    zh_shadow,
    zh_weight_warning,
)

# ── Layout ──
# The English row's size is this renderer's own concern; the Chinese row takes
# ZH_FONT_SIZE_BASE from the shared contract, because single-language delivery
# is the same Chinese row with the English one removed.
_BASE_EN_FONT_SIZE = 16

# Runtime values — set by main() after parsing video dimensions
VIDEO_WIDTH = 1280
VIDEO_HEIGHT = 720
EN_FONT_SIZE = _BASE_EN_FONT_SIZE
ZH_FONT_SIZE = ZH_FONT_SIZE_BASE


class FontSet:
    """Latin + CJK face pair standing in for one row's font-fallback chain,
    since Pillow resolves no fallbacks itself: each draw call uses exactly the
    font it is handed, so mixed-script text has to be split into runs.

    The pair is per row, not global: Chinese wants one Heavy face across both
    scripts so a product name inside a Chinese caption keeps that row's
    weight, while English wants Inter for Latin and a lighter CJK face."""

    def __init__(
        self,
        size: int,
        latin_candidates: list[tuple[str, int, str, "str | None"]],
        cjk_candidates: list[tuple[str, int, str, "str | None"]],
        tracking_em: float,
    ):
        self.size = size
        self.latin, self.latin_name = find_font(latin_candidates, size)
        self.cjk, self.cjk_name = find_font(cjk_candidates, size)
        # Tracking stays a float: rounding it per character would accumulate a
        # visible drift across a long line and break centring.
        self.tracking = size * tracking_em

    def font_for(self, kind: str) -> ImageFont.FreeTypeFont:
        return self.latin if kind == "latin" else self.cjk

    def metrics(self) -> tuple[int, int]:
        """Shared (ascent, descent) so both faces sit on one baseline."""
        la, ld = self.latin.getmetrics()
        ca, cd = self.cjk.getmetrics()
        return max(la, ca), max(ld, cd)


@lru_cache(maxsize=None)
def zh_font_set(size: int) -> FontSet:
    return FontSet(size, ZH_FONT_CANDIDATES, ZH_FONT_CANDIDATES, ZH_TRACKING_EM)


@lru_cache(maxsize=None)
def en_font_set(size: int) -> FontSet:
    return FontSet(size, EN_FONT_CANDIDATES, EN_CJK_FONT_CANDIDATES, EN_TRACKING_EM)


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


def styled_runs(
    text: str,
    fill: tuple[int, int, int, int],
    highlight_re: re.Pattern[str] | None,
    highlight_fill: tuple[int, int, int, int] | None,
) -> list[tuple[str, str, tuple[int, int, int, int]]]:
    """font_runs() subdivided again wherever the accent colour changes, giving
    (run_text, face_kind, fill) triples.

    Colour is resolved per character before splitting so a highlight that
    straddles a face boundary still lands on exactly the matched characters.
    Rows with no accent (Chinese, and every shadow layer) pass highlight_re
    None and get font_runs() back unchanged."""
    if highlight_re is None or highlight_fill is None:
        return [(run, kind, fill) for run, kind in font_runs(text)]

    fills = [fill] * len(text)
    for match in highlight_re.finditer(text):
        for i in range(*match.span()):
            fills[i] = highlight_fill

    out: list[tuple[str, str, tuple[int, int, int, int]]] = []
    pos = 0
    for run, kind in font_runs(text):
        start, pos = pos, pos + len(run)
        seg_start = start
        for i in range(start + 1, pos + 1):
            if i == pos or fills[i] != fills[seg_start]:
                out.append((text[seg_start:i], kind, fills[seg_start]))
                seg_start = i
    return out


def _run_advance(
    run: str, font: ImageFont.FreeTypeFont, draw: ImageDraw.ImageDraw, tracking: float
) -> float:
    """Advance width of one single-face run. Untracked runs are measured whole
    so intra-run kerning is preserved; a tracked run is measured glyph by
    glyph because that is also how it gets drawn."""
    if tracking <= 0:
        return draw.textlength(run, font=font)
    return sum(draw.textlength(ch, font=font) + tracking for ch in run)


def _line_width(text: str, fs: FontSet, draw: ImageDraw.ImageDraw) -> int:
    """Advance width of mixed-script text, summed per font run."""
    total = sum(
        _run_advance(run, fs.font_for(kind), draw, fs.tracking) for run, kind in font_runs(text)
    )
    # Letter-spacing follows every glyph, including the last one. That trailing
    # gap is real advance but not ink, so it is dropped here: the measured
    # width is what centring is derived from, and keeping it would push every
    # line half a tracking step left of centre.
    if fs.tracking > 0 and text:
        total -= fs.tracking
    return round(total)


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
        zh_text = zh_caption_text(text_lines[0]) if text_lines else ""
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
    highlight_re: re.Pattern[str] | None = None,
    highlight_fill: tuple[int, int, int, int] | None = None,
):
    """Draw one line of possibly mixed-script text on a shared baseline,
    switching faces per run (Latin in this row's Latin face, CJK in its
    Chinese face) and colours per accent span. Anchored "ls" (left-baseline)
    so the two faces' differing ascents cannot make their glyphs sit at
    different heights.

    Outlining and the two-pass draw order come from the shared contract's
    draw_outlined_runs(), so this row's hairline is geometrically the same one
    the single-language renderer draws.
    """
    tracking = fs.tracking

    # A tracked row has to advance glyph by glyph to insert the spacing, which
    # gives up kerning inside the run; untracked rows still draw the run whole
    # and keep theirs. Either way the advance matches exactly what
    # _run_advance() measured, so centring stays correct.
    placed: list[tuple[float, str, ImageFont.FreeTypeFont, tuple[int, int, int, int]]] = []
    cursor = float(x)
    for run, kind, run_fill in styled_runs(text, fill, highlight_re, highlight_fill):
        font = fs.font_for(kind)
        for piece in (list(run) if tracking > 0 else [run]):
            placed.append((cursor, piece, font, run_fill))
            cursor += draw.textlength(piece, font=font) + tracking

    draw_outlined_runs(draw, placed, baseline_y, outline_width, outline_color)


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
    line_h = ascent + descent
    gap = line_gap(fs.size, line_h, outline_width)
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
    highlight_re: re.Pattern[str] | None = None,
    highlight_fill: tuple[int, int, int, int] | None = None,
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

    The drop shadow is drawn on its own layer, offset per the row's
    distance/angle and then Gaussian-blurred by its blur radius, so the blur
    is real instead of the stamped offset trail that used to fake it. It is
    drawn without the accent colour: a highlighted word casts the same shadow
    as the rest of the line, not a coloured one.

    `align_bottom` pins content to the bottom of its row (used for the
    Chinese row, so its last line stays a constant distance above the English
    row regardless of how many lines it wrapped to); otherwise content is
    pinned to the top (used for English, directly under Chinese)."""
    temp_draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    ascent, descent = fs.metrics()
    gap = line_gap(fs.size, ascent + descent, outline_width)
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
        draw_mixed_line(
            text_draw, line_text, lx, y0 + base, fs, fill, outline_width,
            highlight_re=highlight_re, highlight_fill=highlight_fill,
        )

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
    scale = resolution_scale(VIDEO_HEIGHT)
    ZH_FONT_SIZE = round(ZH_FONT_SIZE_BASE * scale)
    EN_FONT_SIZE = round(_BASE_EN_FONT_SIZE * scale)
    zh_fs = zh_font_set(ZH_FONT_SIZE)
    en_fs = en_font_set(EN_FONT_SIZE)
    zh_outline = ZH_OUTLINE_PX
    en_outline = EN_OUTLINE_PX
    zh_sh = zh_shadow(VIDEO_HEIGHT)
    en_sh = en_shadow(EN_FONT_SIZE)
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
        f"{ZH_FONT_SIZE}px outline={zh_outline}px tracking={zh_fs.tracking:.2f}px",
        file=sys.stderr,
    )
    print(
        f"EN font: {en_fs.latin_name} (latin) + {en_fs.cjk_name} (cjk) "
        f"{EN_FONT_SIZE}px outline={en_outline}px tracking={en_fs.tracking:.2f}px",
        file=sys.stderr,
    )
    zh_warning = zh_weight_warning(zh_fs.cjk_name)
    if zh_warning:
        print(f"WARNING: {zh_warning}", file=sys.stderr)
    if en_fs.latin_name != "Inter Bold":
        print(
            f"WARNING: vendored Inter Bold not loadable; English row fell "
            f"back to {en_fs.latin_name}.",
            file=sys.stderr,
        )
    for label, sh in (("zh", zh_sh), ("en", en_sh)):
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
        measure_text_block(run["zh_text"], zh_fs, zh_outline, zh_sh) for run in zh_runs
    ]
    en_layouts = [
        measure_text_block(cue["en_text"], en_fs, en_outline, en_sh) for cue in cues
    ]
    zh_row_h = max((h for _, _, h in zh_layouts), default=0) or 1
    en_row_h = max((h for _, _, h in en_layouts), default=0) or 1

    total_units = len(zh_runs) + len(cues)
    done = 0

    zh_entries = []
    for i, (run, (lines, baselines, _)) in enumerate(zip(zh_runs, zh_layouts)):
        filename = f"zh_{i:04d}.png"
        w, h = render_text_row(
            lines, baselines, zh_fs, zh_outline, ZH_FILL, zh_sh, zh_row_h,
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
            lines, baselines, en_fs, en_outline, EN_FILL, en_sh, en_row_h,
            False, out_dir / filename,
            highlight_re=EN_HIGHLIGHT_RE, highlight_fill=EN_HIGHLIGHT_FILL,
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
