#!/usr/bin/env python3
"""Render SRT subtitle cues as transparent PNG images for ffmpeg overlay.

Style: dark rounded background, white bold text. No stroke, no shadow.
Balanced 2-line CJK wrapping with semantic break points.
"""

import json
import re
import sys
import unicodedata
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

VIDEO_WIDTH = 1280
VIDEO_HEIGHT = 720

# Bold CJK font candidates (path, face index), aligned with the bilingual
# renderer: PingFang.ttc index 2 = Semibold, Hiragino Sans GB index 3 = W6.
FONT_CANDIDATES = [
    ("/System/Library/Fonts/PingFang.ttc", 2),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 3),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
]
# Chinese font auto-scales per cue between MIN and MAX (absolute px) to keep
# each cue on one line when possible (matches the bilingual renderer).
ZH_MIN_FONT_SIZE = 52
ZH_MAX_FONT_SIZE = 72

LINE_SPACING_RATIO = 0.55  # 行距 / 字体大小
BG_PAD_X_RATIO = 0.8       # 水平内边距 / 字体大小
BG_PAD_Y_RATIO = 0.45      # 垂直内边距 / 字体大小
BG_RADIUS_RATIO = 0.35     # 圆角 / 字体大小

TEXT_COLOR = (255, 255, 255, 255)
BG_COLOR = (0, 0, 0, 170)

# Width: 75%–85% of video
WIDTH_FRAC_DEFAULT = 0.80
WIDTH_FRAC_MAX = 0.85


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


def _text_width(text: str, font: ImageFont.FreeTypeFont, draw: ImageDraw.Draw) -> float:
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0]


def _line_params(font_size: int):
    """Return (line_spacing, bg_pad_x, bg_pad_y, bg_radius) for a font size."""
    return (
        int(font_size * LINE_SPACING_RATIO),
        int(font_size * BG_PAD_X_RATIO),
        int(font_size * BG_PAD_Y_RATIO),
        int(font_size * BG_RADIUS_RATIO),
    )


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
def _load_font(font_size: int) -> ImageFont.FreeTypeFont | None:
    """Load the bold CJK font at the given size. Returns None if unavailable."""
    for fp, idx in FONT_CANDIDATES:
        if not Path(fp).exists():
            continue
        try:
            return ImageFont.truetype(fp, font_size, index=idx)
        except (OSError, TypeError):
            continue
    return None


def _normalize_text(text: str) -> str:
    """Normalize subtitle text for re-wrapping.

    Source SRT files often contain pre-wrapped line breaks (~15-20 chars/line
    from Whisper/YouTube). These narrow breaks are artifacts of the original
    transcription, not semantic breaks. Join all text and let our wrapper
    determine the optimal line breaks at the target width (~30 CJK chars/line).

    Also removes spaces between CJK characters (artifacts of Whisper wrapping)
    while preserving spaces around Latin/English words.

    Punctuation is stripped: marks inside a sentence become spaces (a visual
    pause) and trailing marks are dropped, so no punctuation is ever rendered.
    """
    # Replace newlines with spaces, then collapse
    collapsed = " ".join(text.replace("\n", " ").split())
    # Remove spaces between two CJK characters: "一。 如果" → "一。如果"
    result = []
    for i, ch in enumerate(collapsed):
        if ch == " " and i > 0 and i < len(collapsed) - 1:
            prev_ok = _is_cjk(collapsed[i - 1])
            next_ok = _is_cjk(collapsed[i + 1])
            # Keep space only if one side is non-CJK (Latin/num)
            if not (prev_ok and next_ok):
                result.append(ch)
            # else: drop the space between two CJK characters
        else:
            result.append(ch)

    # Drop punctuation: in-sentence marks become a single space and trailing
    # marks disappear. Decimal points between digits (e.g. 4.5, v0.1) are kept.
    chars = "".join(result)
    n = len(chars)
    out = []
    for i, ch in enumerate(chars):
        if unicodedata.category(ch).startswith("P"):
            is_decimal = (
                ch == "."
                and 0 < i < n - 1
                and chars[i - 1].isdigit()
                and chars[i + 1].isdigit()
            )
            out.append(ch if is_decimal else " ")
        else:
            out.append(ch)
    return " ".join("".join(out).split())


def _is_cjk(ch: str) -> bool:
    """Check if a character is CJK (Chinese/Japanese/Korean) or CJK punctuation."""
    cp = ord(ch)
    return (
        0x4E00 <= cp <= 0x9FFF  # CJK Unified
        or 0x3400 <= cp <= 0x4DBF  # CJK Extension A
        or 0x3000 <= cp <= 0x303F  # CJK punctuation (。、， etc.)
        or 0xFF00 <= cp <= 0xFFEF  # Fullwidth forms
        or 0x2000 <= cp <= 0x206F  # General punctuation
    )


def render_subtitle(text: str, _font: ImageFont.FreeTypeFont) -> Image.Image:
    """Render white text on a dark rounded background. No stroke, no shadow.

    Single-line strategy: pick the largest font in [ZH_MIN, ZH_MAX] (absolute
    px) that fits the cue on one line. Only cues too long even at ZH_MIN wrap
    onto extra lines (without splitting words). Text is always centered.
    """
    dummy = Image.new("RGBA", (1, 1))
    dd = ImageDraw.Draw(dummy)

    text = _normalize_text(text)

    frac = WIDTH_FRAC_MAX

    def avail_width(size: int) -> int:
        return int(VIDEO_WIDTH * frac) - int(size * BG_PAD_X_RATIO) * 2

    # Pick the largest size in [ZH_MIN, ZH_MAX] that fits on one line.
    size = ZH_MAX_FONT_SIZE
    font = _load_font(size)
    if font is None:
        raise RuntimeError("No usable CJK font found")

    if text and _text_width(text, font, dd) > avail_width(size):
        size = ZH_MIN_FONT_SIZE
        for candidate in range(ZH_MAX_FONT_SIZE, ZH_MIN_FONT_SIZE - 1, -1):
            f = _load_font(candidate)
            if _text_width(text, f, dd) <= avail_width(candidate):
                size = candidate
                break
        font = _load_font(size)

    # One line when it fits; otherwise wrap at the min size (word-safe, rare).
    if not text:
        lines = [""]
    elif _text_width(text, font, dd) <= avail_width(size):
        lines = [text]
    else:
        lines = [ln.strip() for ln in _wrap_cjk(text, font, dd, avail_width(size)) if ln.strip()]
        if not lines:
            lines = [text]

    wrapped_text = "\n".join(lines)
    ls, bg_pad_x, bg_pad_y, bg_radius = _line_params(size)

    # Measure
    bbox = dd.multiline_textbbox((0, 0), wrapped_text, font=font, spacing=ls, align="center")
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]

    # Clamp width: if text is very short, bg is centered at text width
    bg_w = max(tw + bg_pad_x * 2, 0)
    bg_h = th + bg_pad_y * 2

    # Canvas
    img = Image.new("RGBA", (VIDEO_WIDTH, bg_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Dark rounded background (centered)
    bg_x = (VIDEO_WIDTH - bg_w) // 2
    draw.rounded_rectangle(
        (bg_x, 0, bg_x + bg_w, bg_h),
        radius=bg_radius,
        fill=BG_COLOR,
    )

    # White text (centered)
    tx = (VIDEO_WIDTH - tw) // 2
    ty = bg_pad_y
    draw.multiline_text(
        (tx, ty),
        wrapped_text,
        font=font,
        fill=TEXT_COLOR,
        spacing=ls,
        align="center",
    )

    return img


def main():
    global VIDEO_WIDTH, VIDEO_HEIGHT

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

    # Font auto-scales per cue in [ZH_MIN, ZH_MAX] (absolute px) in render.
    VIDEO_WIDTH = video_w
    VIDEO_HEIGHT = video_h

    out_dir = Path(out_dir_arg)
    out_dir.mkdir(parents=True, exist_ok=True)

    cues = parse_srt(srt_path)
    if not cues:
        print("Error: no cues found in SRT file", file=sys.stderr)
        sys.exit(1)

    main_font = _load_font(ZH_MAX_FONT_SIZE)
    if main_font is None:
        print("Error: no usable CJK font found", file=sys.stderr)
        sys.exit(1)

    manifest = []
    for i, cue in enumerate(cues):
        img = render_subtitle(cue["text"], main_font)
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
