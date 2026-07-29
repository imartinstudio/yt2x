#!/usr/bin/env python3
"""Render bilingual subtitle cues as transparent PNG images for ffmpeg overlay.

Input: bilingual SRT file (Chinese line 1, English line 2 per cue)
Output: PNG frames in a directory + manifest.json

Style: BaoCut-inspired white bilingual subtitles. Simplified Chinese is bold
and outlined on top; the English source is smaller below it.
"""

import json
import re
import sys
import unicodedata
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# 720p reference values, scaled proportionally for other heights.
_BASE_ZH_FONT_SIZE = 30
_BASE_EN_FONT_SIZE = 16
_BASE_ZH_OUTLINE_W = 2
_BASE_EN_OUTLINE_W = 0
# Chinese carries a real outline, so its drop shadow only needs to lift the
# text off the picture — a long offset reads as a smear at caption size.
_BASE_ZH_SHADOW_DISTANCE = 1
_BASE_ZH_SHADOW_BLUR = 1
# English has no outline and sits at half the Chinese size; it needs a tight,
# close shadow for legibility, not an offset one that trails behind the glyphs.
_BASE_EN_SHADOW_DISTANCE = 1
_BASE_EN_SHADOW_BLUR = 0

ZH_FILL = (255, 255, 255, 255)
EN_FILL = (255, 255, 255, 255)  # pure white
OUTLINE_COLOR = (0, 0, 0, 255)  # pure black
SHADOW_COLOR = (64, 64, 64, 255)
MAX_WIDTH_FRAC = 0.80

# Runtime values — set by main() after parsing video dimensions
VIDEO_WIDTH = 1280
VIDEO_HEIGHT = 720
EN_FONT_SIZE = _BASE_EN_FONT_SIZE
ZH_FONT_SIZE = _BASE_ZH_FONT_SIZE
ZH_OUTLINE_W = _BASE_ZH_OUTLINE_W
EN_OUTLINE_W = _BASE_EN_OUTLINE_W
ZH_SHADOW_DISTANCE = _BASE_ZH_SHADOW_DISTANCE
ZH_SHADOW_BLUR = _BASE_ZH_SHADOW_BLUR
EN_SHADOW_DISTANCE = _BASE_EN_SHADOW_DISTANCE
EN_SHADOW_BLUR = _BASE_EN_SHADOW_BLUR

# Font candidates (face index for bold weights):
#   PingFang.ttc: 0=Regular, 1=Medium, 2=Semibold
#   Hiragino Sans GB.ttc: 0=W3, 3=W6(bold)
ZH_FONT_CANDIDATES = [
    ("/System/Library/Fonts/PingFang.ttc", 2, "PingFang SC"),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 3, "Hiragino Sans GB"),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0, "STHeiti"),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0, "Arial Unicode"),
]

EN_FONT_CANDIDATES = [
    (str(Path.home() / "Library/Fonts/LexendDeca.ttf"), 0, "Lexend Deca"),
    ("/Library/Fonts/LexendDeca.ttf", 0, "Lexend Deca"),
    ("/System/Library/Fonts/PingFang.ttc", 1, "PingFang SC"),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 3, "Hiragino Sans GB"),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0, "STHeiti"),
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


def find_font(
    candidates: list[tuple[str, int, str]], size: int
) -> tuple[ImageFont.FreeTypeFont, str]:
    for path, face_index, family_name in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size, index=face_index), family_name
            except Exception:
                continue
    return ImageFont.load_default(), "Pillow default"


@lru_cache(maxsize=None)
def _zh_font(size: int) -> ImageFont.FreeTypeFont:
    """Cached bold Chinese font at the given size."""
    return find_font(ZH_FONT_CANDIDATES, size)[0]


# Tokenizer: a Latin/number word (with inner . ' - kept, e.g. 4.5, v0.1,
# don't), OR a run of whitespace, OR any single other char (e.g. one CJK char).
_TOKEN_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z.'\u2019\-]*|\s+|.", re.S)


def _line_width(text: str, font: ImageFont.FreeTypeFont, draw: ImageDraw.ImageDraw) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0]


def wrap_text(
    text: str,
    font: ImageFont.FreeTypeFont,
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

    if _line_width(text, font, draw) <= max_width:
        return [text]

    lines: list[str] = []
    current = ""
    for tok in _TOKEN_RE.findall(text):
        if tok.isspace():
            if current:
                current += " "  # collapse any whitespace run to a single space
            continue
        cand = current + tok
        if current.strip() and _line_width(cand, font, draw) > max_width:
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
        zh_text = clean_subtitle_text(text_lines[0]) if text_lines else ""
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


def draw_text_with_outline(
    draw: ImageDraw.ImageDraw,
    text: str,
    xy: tuple[int, int],
    font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int, int],
    outline_color: tuple[int, int, int, int],
    outline_width: int,
    shadow_distance: int,
    shadow_blur: int,
):
    """Draw text with outline by stamping in all 8 directions + corners."""
    x, y = xy
    for spread in range(shadow_blur + 1):
        draw.text(
            (x + shadow_distance + spread, y + shadow_distance + spread),
            text,
            font=font,
            fill=SHADOW_COLOR,
        )
    for dx in range(-outline_width, outline_width + 1):
        for dy in range(-outline_width, outline_width + 1):
            if dx == 0 and dy == 0:
                continue
            draw.text((x + dx, y + dy), text, font=font, fill=outline_color)
    draw.text((x, y), text, font=font, fill=fill)


def measure_lines(
    text_lines: list[str],
    font: ImageFont.FreeTypeFont,
    draw: ImageDraw.ImageDraw,
    *,
    outline_width: int = 0,
) -> tuple[int, int, list[tuple[int, int, int, int]]]:
    """Measure wrapped text lines. Returns (max_width, total_height, line_bboxes)."""
    max_w = 0
    total_h = 0
    bboxes = []
    # Leave room for outline strokes so wrapped lines do not overlap visually.
    gap = max(4, outline_width * 2 + 4)
    for i, line_text in enumerate(text_lines):
        bbox = draw.textbbox((0, 0), line_text, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        max_w = max(max_w, w)
        bboxes.append((0, total_h, w, total_h + h))
        total_h += h + (gap if i < len(text_lines) - 1 else 0)
    return max_w, total_h, bboxes


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
    font: ImageFont.FreeTypeFont,
    outline_width: int,
    shadow_distance: int,
    shadow_blur: int,
) -> tuple[list[str], list[tuple[int, int, int, int]], int]:
    """Wrap + measure one language's text. Returns (lines, bboxes, block_h),
    where block_h includes the vertical room the outline and drop shadow need."""
    max_text_width = int(VIDEO_WIDTH * MAX_WIDTH_FRAC)
    temp_draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    lines = wrap_text(text, font, max_text_width, temp_draw)
    _, total_h, bboxes = measure_lines(lines, font, temp_draw, outline_width=outline_width)
    pad_v = outline_width * 2 + shadow_distance + shadow_blur + 4
    return lines, bboxes, total_h + pad_v


def render_text_row(
    lines: list[str],
    bboxes: list[tuple[int, int, int, int]],
    font: ImageFont.FreeTypeFont,
    outline_width: int,
    fill: tuple[int, int, int, int],
    shadow_distance: int,
    shadow_blur: int,
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

    `align_bottom` pins content to the bottom of its row (used for the
    Chinese row, so its last line stays a constant distance above the English
    row regardless of how many lines it wrapped to); otherwise content is
    pinned to the top (used for English, directly under Chinese)."""
    img = Image.new("RGBA", (VIDEO_WIDTH, row_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    content_h = (bboxes[-1][3] if bboxes else 0) + outline_width * 2 + shadow_distance + shadow_blur + 4
    y0 = (row_h - content_h) if align_bottom else 0
    y0 += outline_width + 2

    for line_text, (_, ly, lw, _lh) in zip(lines, bboxes):
        lx = (VIDEO_WIDTH - lw) // 2
        draw_text_with_outline(
            draw, line_text, (lx, y0 + ly), font, fill, OUTLINE_COLOR,
            outline_width, shadow_distance, shadow_blur,
        )

    img.save(out_path)
    return VIDEO_WIDTH, row_h


def main():
    global VIDEO_WIDTH, VIDEO_HEIGHT, EN_FONT_SIZE, ZH_FONT_SIZE
    global ZH_OUTLINE_W, EN_OUTLINE_W
    global ZH_SHADOW_DISTANCE, ZH_SHADOW_BLUR, EN_SHADOW_DISTANCE, EN_SHADOW_BLUR
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
    ZH_OUTLINE_W = max(1, round(_BASE_ZH_OUTLINE_W * scale))
    EN_OUTLINE_W = max(0, round(_BASE_EN_OUTLINE_W * scale))
    ZH_SHADOW_DISTANCE = max(1, round(_BASE_ZH_SHADOW_DISTANCE * scale))
    ZH_SHADOW_BLUR = max(0, round(_BASE_ZH_SHADOW_BLUR * scale))
    EN_SHADOW_DISTANCE = max(1, round(_BASE_EN_SHADOW_DISTANCE * scale))
    EN_SHADOW_BLUR = max(0, round(_BASE_EN_SHADOW_BLUR * scale))

    en_font, en_font_name = find_font(EN_FONT_CANDIDATES, EN_FONT_SIZE)
    _, zh_font_name = find_font(ZH_FONT_CANDIDATES, ZH_FONT_SIZE)
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
        zh_font = _zh_font(ZH_FONT_SIZE)
        metrics = []
        for cue in cues:
            raw_width = _line_width(cue["zh_text"], zh_font, draw)
            zh_lines = wrap_text(cue["zh_text"], zh_font, fit_width, draw)
            en_lines = wrap_text(cue["en_text"], en_font, fit_width, draw)
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
                "resolvedFonts": {"zh": zh_font_name, "en": en_font_name},
            })
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(metrics, f, ensure_ascii=False)
        return

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Video: {VIDEO_WIDTH}x{VIDEO_HEIGHT}", file=sys.stderr)
    print(f"ZH font: {zh_font_name} ({ZH_FONT_SIZE}px)", file=sys.stderr)
    print(f"EN font: {en_font_name} ({EN_FONT_SIZE}px)", file=sys.stderr)

    # Two independent layers: a ZH run only re-renders (and only re-selects a
    # different frame) when the Chinese text itself actually changes, never
    # because the English cue underneath moved on to its next fragment.
    #
    # Pass 1 measures every block so each layer can pick ONE constant row
    # height; pass 2 renders every block onto that fixed-size canvas.
    zh_font = _zh_font(ZH_FONT_SIZE)
    zh_runs = group_zh_runs(cues)

    zh_layouts = [
        measure_text_block(run["zh_text"], zh_font, ZH_OUTLINE_W, ZH_SHADOW_DISTANCE, ZH_SHADOW_BLUR)
        for run in zh_runs
    ]
    en_layouts = [
        measure_text_block(cue["en_text"], en_font, EN_OUTLINE_W, EN_SHADOW_DISTANCE, EN_SHADOW_BLUR)
        for cue in cues
    ]
    zh_row_h = max((h for _, _, h in zh_layouts), default=0) or 1
    en_row_h = max((h for _, _, h in en_layouts), default=0) or 1

    total_units = len(zh_runs) + len(cues)
    done = 0

    zh_entries = []
    for i, (run, (lines, bboxes, _)) in enumerate(zip(zh_runs, zh_layouts)):
        filename = f"zh_{i:04d}.png"
        w, h = render_text_row(
            lines, bboxes, zh_font, ZH_OUTLINE_W, ZH_FILL,
            ZH_SHADOW_DISTANCE, ZH_SHADOW_BLUR, zh_row_h,
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
    for cue, (lines, bboxes, _) in zip(cues, en_layouts):
        filename = f"en_{cue['index']:04d}.png"
        w, h = render_text_row(
            lines, bboxes, en_font, EN_OUTLINE_W, EN_FILL,
            EN_SHADOW_DISTANCE, EN_SHADOW_BLUR, en_row_h,
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
