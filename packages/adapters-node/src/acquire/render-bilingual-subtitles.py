#!/usr/bin/env python3
"""Render bilingual subtitle cues as transparent PNG images for ffmpeg overlay.

Input: bilingual SRT file (Chinese line 1, English line 2 per cue)
Output: PNG frames in a directory + manifest.json

Style: Chinese yellow bold large on top, English white italic smaller on bottom.
No background box — uses black outline for readability on any background.
"""

import json
import re
import sys
import unicodedata
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# Base style parameters. The Chinese font auto-scales per cue between MIN and
# MAX (absolute px) to keep each cue on one line when possible; English keeps a
# fixed size scaled with resolution.
ZH_MIN_FONT_SIZE = 52
ZH_MAX_FONT_SIZE = 72
_BASE_EN_FONT_SIZE = 32
_BASE_ZH_OUTLINE_W = 4
_BASE_EN_OUTLINE_W = 2

ZH_FILL = (255, 227, 2, 255)  # warm golden yellow (#FFE302)
EN_FILL = (255, 255, 255, 255)  # pure white
OUTLINE_COLOR = (0, 0, 0, 255)  # pure black
MAX_WIDTH_FRAC = 0.98

# Runtime values — set by main() after parsing video dimensions
VIDEO_WIDTH = 1280
VIDEO_HEIGHT = 720
EN_FONT_SIZE = _BASE_EN_FONT_SIZE
ZH_OUTLINE_W = _BASE_ZH_OUTLINE_W
EN_OUTLINE_W = _BASE_EN_OUTLINE_W

# Font candidates (face index for bold weights):
#   PingFang.ttc: 0=Regular, 1=Medium, 2=Semibold
#   Hiragino Sans GB.ttc: 0=W3, 3=W6(bold)
BOLD_FONT_CANDIDATES = [
    ("/System/Library/Fonts/PingFang.ttc", 2),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 3),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
]

REGULAR_FONT_CANDIDATES = [
    ("/System/Library/Fonts/PingFang.ttc", 1),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 3),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
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
    candidates: list[tuple[str, int]], size: int
) -> ImageFont.FreeTypeFont:
    for path, face_index in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size, index=face_index)
            except Exception:
                continue
    return ImageFont.load_default()


@lru_cache(maxsize=None)
def _zh_font(size: int) -> ImageFont.FreeTypeFont:
    """Cached bold Chinese font at the given size."""
    return find_font(BOLD_FONT_CANDIDATES, size)


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
):
    """Draw text with outline by stamping in all 8 directions + corners."""
    x, y = xy
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


def _fit_zh_lines(
    text: str, draw: ImageDraw.ImageDraw, max_width: int
) -> tuple[ImageFont.FreeTypeFont, list[str]]:
    """Pick the largest Chinese font in [MIN, MAX] that fits on one line.

    Falls back to the min size + word-safe wrapping only when even the smallest
    size cannot fit the text on a single line.
    """
    if not text:
        return _zh_font(ZH_MAX_FONT_SIZE), [""]
    for size in range(ZH_MAX_FONT_SIZE, ZH_MIN_FONT_SIZE - 1, -1):
        font = _zh_font(size)
        if _line_width(text, font, draw) <= max_width:
            return font, [text]
    font = _zh_font(ZH_MIN_FONT_SIZE)
    return font, wrap_text(text, font, max_width, draw)


def render_cue(
    cue: dict,
    en_font: ImageFont.FreeTypeFont,
    out_dir: Path,
) -> dict:
    """Render one bilingual cue as a transparent PNG, return manifest entry."""
    max_text_width = int(VIDEO_WIDTH * MAX_WIDTH_FRAC)

    # Temporary draw for measurement
    temp = Image.new("RGBA", (1, 1))
    temp_draw = ImageDraw.Draw(temp)

    # Chinese: auto-scale to fit one line; English: fixed size, word-safe wrap.
    zh_font, zh_lines = _fit_zh_lines(cue["zh_text"], temp_draw, max_text_width)
    en_lines = wrap_text(cue["en_text"], en_font, max_text_width, temp_draw)

    # Measure wrapped lines (outline-aware spacing prevents double-layer ghosting)
    zh_max_w, zh_total_h, zh_bboxes = measure_lines(
        zh_lines, zh_font, temp_draw, outline_width=ZH_OUTLINE_W,
    )
    en_max_w, en_total_h, en_bboxes = measure_lines(
        en_lines, en_font, temp_draw, outline_width=EN_OUTLINE_W,
    )

    # Canvas dimensions
    zh_pad = ZH_OUTLINE_W * 2 + 4
    en_pad = EN_OUTLINE_W * 2 + 4
    line_gap = ZH_OUTLINE_W + EN_OUTLINE_W + 8  # gap between Chinese and English blocks

    content_w = max(zh_max_w, en_max_w)
    canvas_w = content_w + max(zh_pad, en_pad)
    # Clamp to max width — text is already wrapped, so canvas_w should fit
    canvas_w = min(canvas_w, max_text_width)

    canvas_h = zh_total_h + line_gap + en_total_h + zh_pad + en_pad

    img = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Draw Chinese (top)
    zh_y = ZH_OUTLINE_W + 2
    for line_text, (_, ly, lw, lh) in zip(zh_lines, zh_bboxes):
        lx = (canvas_w - lw) // 2
        draw_text_with_outline(
            draw, line_text, (lx, zh_y + ly), zh_font,
            ZH_FILL, OUTLINE_COLOR, ZH_OUTLINE_W,
        )

    # Draw English (bottom)
    en_y = zh_y + zh_total_h + line_gap + ZH_OUTLINE_W
    for line_text, (_, ly, lw, lh) in zip(en_lines, en_bboxes):
        ex = (canvas_w - lw) // 2
        draw_text_with_outline(
            draw, line_text, (ex, en_y + ly), en_font,
            EN_FILL, OUTLINE_COLOR, EN_OUTLINE_W,
        )

    filename = f"cue_{cue['index']:04d}.png"
    img.save(out_dir / filename)

    return {
        "index": cue["index"],
        "filename": filename,
        "start": cue["start_s"],
        "end": cue["end_s"],
        "width": canvas_w,
        "height": canvas_h,
    }


def main():
    global VIDEO_WIDTH, VIDEO_HEIGHT, EN_FONT_SIZE, ZH_OUTLINE_W, EN_OUTLINE_W
    # Parse args: <srt> <out_dir> [--video-width W] [--video-height H]
    args = sys.argv[1:]
    srt_path = None
    out_dir = None
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
        elif out_dir is None:
            out_dir = args[i]
            i += 1
        else:
            i += 1

    if srt_path is None or out_dir is None:
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
    # Chinese font auto-scales per cue in [ZH_MIN, ZH_MAX] (absolute px).
    EN_FONT_SIZE = round(_BASE_EN_FONT_SIZE * scale)
    ZH_OUTLINE_W = max(1, round(_BASE_ZH_OUTLINE_W * scale))
    EN_OUTLINE_W = max(1, round(_BASE_EN_OUTLINE_W * scale))

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(
        f"Video: {VIDEO_WIDTH}x{VIDEO_HEIGHT}",
        file=sys.stderr,
    )

    en_font = find_font(REGULAR_FONT_CANDIDATES, EN_FONT_SIZE)

    en_path = en_font.path if hasattr(en_font, "path") else "default"
    print(f"ZH font: auto {ZH_MIN_FONT_SIZE}-{ZH_MAX_FONT_SIZE}px", file=sys.stderr)
    print(f"EN font: {en_path} ({EN_FONT_SIZE}px)", file=sys.stderr)

    cues = parse_srt(srt_path)
    if not cues:
        print("ERROR: no cues found in SRT", file=sys.stderr)
        sys.exit(1)

    manifest_entries = []
    for i, cue in enumerate(cues):
        entry = render_cue(cue, en_font, out_dir)
        manifest_entries.append(entry)
        done = i + 1
        if done % 25 == 0 or done == len(cues):
            # Machine-readable progress for the Node caller (stdout, flushed).
            print(f"PROGRESS {done}/{len(cues)}", flush=True)

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
        "cues": manifest_entries,
        "video_width": VIDEO_WIDTH,
        "video_height": 0,
    }
    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f)

    print(f"Rendered {len(cues)} bilingual cues to {out_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
