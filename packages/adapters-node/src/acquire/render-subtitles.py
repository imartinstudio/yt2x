#!/usr/bin/env python3
"""Render SRT subtitle cues as transparent PNG images for ffmpeg overlay.

Style: white Heavy-weight Chinese, hairline-outlined over a soft drop shadow —
the same visual contract as the Chinese row of `render-bilingual-subtitles.py`,
imported from `subtitle_style` so the two cannot drift apart. There is no
subtitle background box: the outline and shadow carry legibility instead.

Balanced 2-line CJK wrapping with semantic break points.
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
    MAX_WIDTH_FRAC,
    OUTLINE_COLOR,
    ZH_FILL,
    ZH_FONT_CANDIDATES,
    ZH_FONT_SIZE_BASE,
    ZH_OUTLINE_PX,
    draw_outlined_runs,
    find_font,
    line_gap,
    resolution_scale,
    zh_caption_text,
    zh_shadow,
    zh_weight_warning,
)

VIDEO_WIDTH = 1280
VIDEO_HEIGHT = 720

# One fixed size, from the shared contract — single-language delivery is the
# bilingual Chinese row with the English row removed, not a larger variant.
#
# This renderer used to run its own 52-72px adaptive search, picking the
# largest size that kept each cue on one line. Two things were wrong with that:
# the captions did not match the bilingual row, and shrinking type to dodge a
# wrap meant the size changed from cue to cue. Cues now arrive from
# `projectSemanticBilingualSubtitles` already split to the 16/14/20 CJK budget,
# so a well-formed cue fits one line at this size, and anything longer wraps.
ZH_FONT_SIZE = ZH_FONT_SIZE_BASE


def parse_srt(srt_path: str) -> list[dict]:
    """Parse SRT file, return list of {start_s, end_s, text}."""
    cues = []
    with open(srt_path, encoding="utf-8") as f:
        content = f.read()

    for block in content.strip().split("\n\n"):
        lines = [l.strip() for l in block.split("\n") if l.strip()]
        if len(lines) < 3:
            continue
        timing_line = ""
        text_start = 0
        for i, line in enumerate(lines):
            if re.match(r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})", line):
                timing_line = line
                text_start = i + 1
                break
        if not timing_line:
            continue
        m = re.match(
            r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})",
            timing_line,
        )
        assert m is not None
        start = m.group(1).replace(",", ".")
        end = m.group(2).replace(",", ".")
        text = "\n".join(lines[text_start:])

        def _to_sec(ts: str) -> float:
            h, m, rest = ts.split(":")
            s, ms = rest.split(".")
            return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000

        cues.append({"start": _to_sec(start), "end": _to_sec(end), "text": text})
    return cues


def _text_width(text: str, font: ImageFont.FreeTypeFont, draw: ImageDraw.Draw) -> int:
    """Advance width, rounded — the same measure the bilingual renderer wraps
    and centres on. It used to be the ink bounding box, which is narrower by
    the glyphs' side bearings and so broke lines at a different character than
    the bilingual row would for the same text."""
    return round(draw.textlength(text, font=font))


def _centred_x(text: str, font: ImageFont.FreeTypeFont, draw: ImageDraw.Draw) -> int:
    """Left edge that centres `text` in the frame.

    Deliberately not Pillow's "ms" (middle-baseline) anchor: that centres on
    the exact float advance, while the bilingual renderer floors
    `(width - advance) / 2` to an int. The two land a pixel apart on some
    lines, which is visible when the same cue is rendered by both paths.
    """
    return (VIDEO_WIDTH - _text_width(text, font, draw)) // 2


def _line_spacing(font: ImageFont.FreeTypeFont, font_size: int) -> int:
    """Pillow's `spacing`: the gap between lines on top of the face's own line
    height, taken from the shared pitch so wrapped captions look the same here
    as in the bilingual renderer."""
    ascent, descent = font.getmetrics()
    return line_gap(font_size, ascent + descent, ZH_OUTLINE_PX)


def _canvas_padding(shadow) -> tuple[int, int]:
    """Vertical room the outline and drop shadow need, as (top, bottom).

    Both are constants for a given resolution — the outline is a fixed hairline
    and the shadow is absolute 720p px — so the text baseline sits the same
    distance above the PNG's bottom edge in every cue. That matters because
    `burn-subtitles.ts` overlays each PNG at `H-h-margin`, pinning its BOTTOM
    edge to the frame: a padding that varied with type size (as the old
    background box's did) moved the captions up and down between cues.
    """
    blur_room = math.ceil(shadow.blur)
    return ZH_OUTLINE_PX + blur_room, ZH_OUTLINE_PX + shadow.vertical_pad()


# Tokenizer: a Latin/number word (with inner . ' - kept, e.g. 4.5, v0.1,
# don't), OR a run of whitespace, OR any single other char (e.g. one CJK char).
_TOKEN_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z.'\u2019\-]*|\s+|.", re.S)


def _wrap_cjk(
    text: str,
    font: ImageFont.FreeTypeFont,
    draw: ImageDraw.Draw,
    max_text_w: int,
) -> list[str]:
    """Wrap text to fit max_text_w without ever splitting a Latin/number word.

    Breaks prefer space boundaries; CJK characters may break between characters
    since they have no word boundaries. Matches the bilingual renderer.
    """
    text = text.strip()
    if not text:
        return []

    if _text_width(text, font, draw) <= max_text_w:
        return [text]

    lines: list[str] = []
    current = ""
    for tok in _TOKEN_RE.findall(text):
        if tok.isspace():
            if current:
                current += " "  # collapse any whitespace run to a single space
            continue
        cand = current + tok
        if current.strip() and _text_width(cand, font, draw) > max_text_w:
            lines.append(current.strip())
            current = tok
        else:
            current = cand
    if current.strip():
        lines.append(current.strip())
    return lines


@lru_cache(maxsize=None)
def _load_font_named(font_size: int) -> tuple[ImageFont.FreeTypeFont, str]:
    """Resolve the shared Chinese face at the given size, with its family name.

    One face covers both scripts here: Source Han Sans / Noto Sans SC carries
    Latin glyphs too, so a product name inside a Chinese caption keeps this
    row's Heavy weight and needs no per-run face switching.
    """
    return find_font(ZH_FONT_CANDIDATES, font_size)


def _load_font(font_size: int) -> ImageFont.FreeTypeFont | None:
    """The face alone, or None when no real CJK face was found (Pillow's
    built-in default cannot render Chinese, so it counts as unavailable)."""
    font, family = _load_font_named(font_size)
    return None if family == "Pillow default" else font


class CueLayout:
    """One cue's resolved type: its wrapped lines, the size chosen for them, and
    the baseline grid they sit on.

    Vertical metrics come from the face (ascent/descent/pitch), never from
    per-line ink bounds, so a line never shifts just because its particular
    characters happen to have no descender — the same rule the bilingual
    renderer follows.
    """

    def __init__(self, lines: list[str], size: int, ascent: int, descent: int, gap: int):
        self.lines = lines
        self.size = size
        self.ascent = ascent
        self.descent = descent
        self.gap = gap

    @property
    def line_height(self) -> int:
        return self.ascent + self.descent

    @property
    def above_last_baseline(self) -> int:
        """Height needed above the LAST baseline: this cue's earlier lines plus
        the ascender of the top one.

        Layout is anchored to the last baseline rather than to the block's top
        or its ink bottom, because that is the line the eye tracks between
        cues. Anchoring on the descender bottom instead would drop a cue that
        wrapped (and so picked a smaller size, and so has a shallower descent)
        a few pixels below its neighbours.
        """
        n = len(self.lines)
        return self.ascent + max(0, n - 1) * (self.line_height + self.gap)


def layout_subtitle(text: str) -> CueLayout:
    """Break one cue into lines at the contract's fixed type size, and measure.

    A cue that does not fit the safe area WRAPS; it never shrinks to stay on one
    line. Long sentences are already cut into cues upstream by
    `projectSemanticBilingualSubtitles` (16 CJK triggers a split, 14 is the
    per-part target, 20 is the hard ceiling, 2 lines max), and that split
    reallocates timing across the pieces — something a renderer cannot do. Its
    job here is only to lay out what it is handed.

    Single-language only — this renderer has no notion of a Chinese/English
    pair. Dubbed bilingual delivery burns through `render-bilingual-subtitles.py`
    / `burn-bilingual-subtitles.ts` instead (see docs/DUB-TASK.md「统一交付」);
    this module only ever sees `full.zh.srt`, one language per cue.
    """
    dd = ImageDraw.Draw(Image.new("RGBA", (1, 1)))

    font = _load_font(ZH_FONT_SIZE)
    if font is None:
        raise RuntimeError("No usable CJK font found")

    # The wrap limit no longer depends on type size: with the background box
    # gone there is no box padding to subtract, so it is simply the shared
    # horizontal safe area.
    avail = int(VIDEO_WIDTH * MAX_WIDTH_FRAC)

    base_line = zh_caption_text(text)
    if not base_line:
        lines = [""]
    elif _text_width(base_line, font, dd) <= avail:
        lines = [base_line]
    else:
        lines = [ln.strip() for ln in _wrap_cjk(base_line, font, dd, avail) if ln.strip()]
        if not lines:
            lines = [base_line]

    ascent, descent = font.getmetrics()
    return CueLayout(lines, ZH_FONT_SIZE, ascent, descent, _line_spacing(font, ZH_FONT_SIZE))


def _baseline_from_bottom(shadow) -> int:
    """Distance from the row's bottom edge up to the LAST baseline.

    Constant for a resolution: the descender plus the outline and shadow room
    below it, so every cue's last baseline lands on the same line.
    """
    _, pad_bottom = _canvas_padding(shadow)
    font = _load_font(ZH_FONT_SIZE)
    descent = font.getmetrics()[1] if font is not None else 0
    return pad_bottom + descent


def row_height(layouts: list[CueLayout], shadow) -> int:
    """One constant canvas height for every cue in the video.

    Every PNG in the sequence must have identical dimensions. ffmpeg's image2
    input reconfigures its filter graph when a frame changes size, and that
    momentarily disturbs the whole overlay chain — it is exactly why the
    bilingual renderer was restructured onto fixed-size rows. This renderer
    used to emit a different height per cue (the box grew with type size and
    line count), so the sequence changed size at almost every cue boundary.
    """
    pad_top, _ = _canvas_padding(shadow)
    tallest = max((layout.above_last_baseline for layout in layouts), default=0)
    return (pad_top + tallest + _baseline_from_bottom(shadow)) or 1


def render_subtitle(layout: CueLayout, row_h: int) -> Image.Image:
    """Render one cue onto a fixed-size transparent canvas: full video width by
    the constant row height. No background box.

    Content is pinned to the BOTTOM of the row, because `burn-subtitles.ts`
    overlays the PNG at `H-h-margin` — its bottom edge against the frame. A cue
    that wraps to two lines therefore grows upward, leaving its last baseline
    exactly where a one-line cue's sits.
    """
    font = _load_font(layout.size)
    if font is None:
        raise RuntimeError("No usable CJK font found")

    shadow = zh_shadow(VIDEO_HEIGHT)

    # Baselines are laid out upward from the row's BOTTOM, so the last one
    # lands on the same line whatever the cue's type size or line count.
    last_baseline = row_h - _baseline_from_bottom(shadow)
    pitch = layout.line_height + layout.gap
    baselines = [
        last_baseline - (len(layout.lines) - 1 - i) * pitch for i in range(len(layout.lines))
    ]

    def stamp(target: Image.Image, dx: int, dy: int, fill, outline_color) -> None:
        draw = ImageDraw.Draw(target)
        for line, baseline in zip(layout.lines, baselines):
            # Outlining comes from the shared primitive, so this row's hairline
            # is geometrically identical to the bilingual Chinese row's —
            # Pillow's own stroke_width strokes the true contour and lands a
            # pixel or two away from that 3x3 dilation.
            draw_outlined_runs(
                draw,
                [(_centred_x(line, font, draw) + dx, line, font, fill)],
                baseline + dy,
                ZH_OUTLINE_PX,
                outline_color,
            )

    # The shadow gets its own layer so its blur is a real Gaussian rather than
    # a stamped offset trail, and its silhouette — outline included — is drawn
    # entirely in the shadow colour: stroking it in opaque black instead would
    # make the "shadow" an opaque slab as thick as the outline, whatever alpha
    # it was given.
    shadow_layer = Image.new("RGBA", (VIDEO_WIDTH, row_h), (0, 0, 0, 0))
    stamp(shadow_layer, shadow.dx, shadow.dy, shadow.color, shadow.color)
    if shadow.blur > 0:
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=shadow.blur))

    text_layer = Image.new("RGBA", (VIDEO_WIDTH, row_h), (0, 0, 0, 0))
    stamp(text_layer, 0, 0, ZH_FILL, OUTLINE_COLOR)

    return Image.alpha_composite(shadow_layer, text_layer)


def main():
    global VIDEO_WIDTH, VIDEO_HEIGHT, ZH_FONT_SIZE

    args = sys.argv[1:]
    srt_path: str | None = None
    out_dir_arg: str | None = None
    video_w = 1280
    video_h = 720
    i = 0
    while i < len(args):
        if args[i] == "--video-width" and i + 1 < len(args):
            video_w = int(args[i + 1])
            i += 2
        elif args[i] == "--video-height" and i + 1 < len(args):
            video_h = int(args[i + 1])
            i += 2
        elif srt_path is None:
            srt_path = args[i]
            i += 1
        elif out_dir_arg is None:
            out_dir_arg = args[i]
            i += 1
        else:
            i += 1

    if srt_path is None or out_dir_arg is None:
        print(
            "Usage: render-subtitles.py <srt_path> <output_dir> "
            "[--video-width W] [--video-height H]",
            file=sys.stderr,
        )
        sys.exit(1)

    VIDEO_WIDTH = video_w
    VIDEO_HEIGHT = video_h

    # Stated at 720p; scale it so captions keep the same relative size (and the
    # same wrapping density) at any resolution, exactly as the bilingual row does.
    ZH_FONT_SIZE = round(ZH_FONT_SIZE_BASE * resolution_scale(VIDEO_HEIGHT))

    out_dir = Path(out_dir_arg)
    out_dir.mkdir(parents=True, exist_ok=True)

    cues = parse_srt(srt_path)
    if not cues:
        print("Error: no cues found in SRT file", file=sys.stderr)
        sys.exit(1)

    _, family = _load_font_named(ZH_FONT_SIZE)
    if family == "Pillow default":
        print("Error: no usable CJK font found", file=sys.stderr)
        sys.exit(1)

    shadow = zh_shadow(VIDEO_HEIGHT)
    print(f"Video: {VIDEO_WIDTH}x{VIDEO_HEIGHT}", file=sys.stderr)
    print(
        f"ZH font: {family} {ZH_FONT_SIZE}px "
        f"outline={ZH_OUTLINE_PX}px",
        file=sys.stderr,
    )
    print(
        f"Shadow[zh]: offset=({shadow.dx},{shadow.dy}) "
        f"blur={shadow.blur:.2f} alpha={shadow.color[3]}",
        file=sys.stderr,
    )
    zh_warning = zh_weight_warning(family)
    if zh_warning:
        print(f"WARNING: {zh_warning}", file=sys.stderr)

    # Pass 1 lays out every cue so the sequence can pick ONE canvas height;
    # pass 2 renders each cue onto that fixed-size canvas.
    layouts = [layout_subtitle(cue["text"]) for cue in cues]
    row_h = row_height(layouts, shadow)
    print(f"Row: {VIDEO_WIDTH}x{row_h} (constant for all cues)", file=sys.stderr)

    manifest = []
    for i, (cue, layout) in enumerate(zip(cues, layouts)):
        img = render_subtitle(layout, row_h)
        fname = f"sub_{i:04d}.png"
        img.save(out_dir / fname, "PNG")
        manifest.append({
            "index": i,
            "filename": fname,
            "start": cue["start"],
            "end": cue["end"],
            "width": img.width,
            "height": img.height,
        })
        done = i + 1
        if done % 25 == 0 or done == len(cues):
            # Machine-readable progress for the Node caller (stdout, flushed).
            print(f"PROGRESS {done}/{len(cues)}", flush=True)

    manifest_path = out_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(
            {"cues": manifest, "video_width": VIDEO_WIDTH, "video_height": VIDEO_HEIGHT},
            f,
            indent=2,
        )

    print(f"Rendered {len(cues)} subtitle images to {out_dir}")


if __name__ == "__main__":
    main()
