#!/usr/bin/env python3
"""Render SRT subtitle cues as transparent PNG images for ffmpeg overlay.

Style: dark rounded background, white bold text. No stroke, no shadow.
Balanced 2-line CJK wrapping with semantic break points.
"""

import json
import re
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

VIDEO_WIDTH = 1280

FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
]
FONT_SIZE = 32

LINE_SPACING_RATIO = 0.55  # 行距 / 字体大小
BG_PAD_X_RATIO = 0.8       # 水平内边距 / 字体大小
BG_PAD_Y_RATIO = 0.45      # 垂直内边距 / 字体大小
BG_RADIUS_RATIO = 0.35     # 圆角 / 字体大小

TEXT_COLOR = (255, 255, 255, 255)
BG_COLOR = (0, 0, 0, 170)

# Width: 75%–85% of video
WIDTH_FRAC_DEFAULT = 0.80
WIDTH_FRAC_MAX = 0.85

# Semantic break scoring
BREAK_SCORE = {
    "。": 1.0, "！": 1.0, "？": 1.0, "!": 1.0, "?": 1.0, "\n": 1.0,
    "；": 0.9, "：": 0.9, ";": 0.9, ":": 0.9,
    "，": 0.8, ",": 0.7,
    "、": 0.6,
    " ": 0.5,
    # Conjunctions / weak breaks — score for the char BEFORE the conjunction
    # (we break AFTER these chars so the conjunction starts line 2)
}
# Characters that are good to break BEFORE (start line 2 with these)
BREAK_BEFORE = set("的但而和与也就又却所以因此然后不过然而但是并且而且")

# Characters that should NOT start a line (closing brackets, etc.)
NO_LINE_START = set("》」』】）)。，、；：,;:）！？!?.")


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


def _break_score(ch: str, next_ch: str) -> float:
    """Score a potential break AFTER ch (before next_ch)."""
    if ch in BREAK_SCORE:
        return BREAK_SCORE[ch]
    # Break before conjunctions: score the char before the conjunction higher
    # e.g., "浏览器，Claude" → break after "，" scored as 0.8
    # e.g., "浏览器位于" → break after "器" scored low
    # Check if next_ch starts a new semantic unit
    if ch == "的":
        return 0.4
    if ch in BREAK_BEFORE:
        return 0.35
    # Penalize breaks that leave bad start chars
    if next_ch in NO_LINE_START:
        return 0.0
    return 0.1


def _find_balanced_split(
    text: str,
    font: ImageFont.FreeTypeFont,
    draw: ImageDraw.Draw,
    max_text_w: int,
) -> int | None:
    """Find the best position to split text into 2 balanced lines.

    Searches for break positions with good semantic quality.
    Prefers filling the available width over forcing equal line lengths.
    Returns the split position (index where line 2 starts), or None.
    """
    full_w = _text_width(text, font, draw)

    # Find all candidate break positions
    candidates: list[tuple[int, float]] = []

    for i in range(1, len(text)):
        ch = text[i - 1]
        next_ch = text[i]

        # Measure width of first line if split here
        first_w = _text_width(text[:i], font, draw)
        second_w = _text_width(text[i:], font, draw)

        # Must fit within max_text_w
        if first_w > max_text_w or second_w > max_text_w:
            continue

        # Search range: 15%-85% of full width (wider range, less strict balance)
        first_ratio = first_w / full_w if full_w > 0 else 0
        if first_ratio < 0.15 or first_ratio > 0.85:
            continue

        sem_score = _break_score(ch, next_ch)
        if sem_score < 0.15:
            continue  # skip terrible break points only

        # Fill score: prefer filling the available width.
        # A split where line 1 fills 80% of max_w scores higher than 50%.
        fill = first_w / max_text_w if max_text_w > 0 else 0

        # Semantic quality is the primary factor. Fill is a tiebreaker.
        score = sem_score * 0.55 + fill * 0.3 + (1.0 - abs(0.5 - first_ratio)) * 0.15
        candidates.append((i, score))

    if not candidates:
        return None

    candidates.sort(key=lambda x: -x[1])
    return candidates[0][0]


def _find_break_for_line(
    text: str,
    font: ImageFont.FreeTypeFont,
    draw: ImageDraw.Draw,
    max_text_w: int,
) -> int:
    """Find where to break a single line that exceeds max_text_w.

    Never leaves punctuation at the start of the next line.
    """
    lo, hi = 1, len(text)
    best = 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if _text_width(text[:mid], font, draw) <= max_text_w:
            best = mid
            lo = mid + 1
        else:
            hi = mid - 1

    # Search backward from best for a semantic break
    for ch_set in [
        set("。！？!?"),
        set("；：;:"),
        set("，,、"),
    ]:
        for i in range(best, max(1, int(best * 0.65)), -1):
            if text[i - 1] in ch_set:
                # Found punctuation — break AFTER it so it ends line 1.
                # Check that the next char (if any) is NOT also punctuation.
                pos = i
                while pos < len(text) and text[pos] in NO_LINE_START:
                    pos += 1
                return pos

    # No semantic break found — use best, but never split before punctuation
    pos = best
    while pos < len(text) and text[pos] in NO_LINE_START:
        pos += 1
    return pos


def _wrap_cjk(
    text: str,
    font: ImageFont.FreeTypeFont,
    draw: ImageDraw.Draw,
    max_text_w: int,
) -> list[str]:
    """Wrap CJK text with balanced 2-line preference.

    Strategy:
    1. If text fits in 1 line → return as-is.
    2. Try balanced 2-line split at semantic break points.
    3. If 2 balanced lines won't fit → greedy multi-line fallback.
    """
    text = text.strip()
    if not text:
        return []

    full_w = _text_width(text, font, draw)

    # 1. Fits in 1 line
    if full_w <= max_text_w:
        return [text]

    # 2. Try balanced 2-line split
    split = _find_balanced_split(text, font, draw, max_text_w)
    if split is not None:
        first = text[:split].strip()
        second = text[split:].strip()
        if first and second and len(first) >= 2 and len(second) >= 2:
            return [first, second]

    # 3. Fallback: greedy wrapping (3+ lines)
    lines: list[str] = []
    remaining = text
    while remaining:
        if _text_width(remaining, font, draw) <= max_text_w:
            lines.append(remaining)
            break
        pos = _find_break_for_line(remaining, font, draw, max_text_w)
        if pos <= 0:
            pos = 1
        lines.append(remaining[:pos].strip())
        remaining = remaining[pos:].strip()
    return lines


def _load_font(font_size: int) -> ImageFont.FreeTypeFont | None:
    """Load a CJK font at the given size. Returns None if no font found."""
    for fp in FONT_CANDIDATES:
        try:
            for idx in (3, 2, 1, 0):
                try:
                    return ImageFont.truetype(fp, font_size, index=idx)
                except (OSError, TypeError):
                    continue
        except OSError:
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
    return "".join(result)


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
    """Render white text on dark rounded background. No stroke, no shadow.

    Consistent font size strategy (avoids size jitter across cues):
    1. Always use FONT_SIZE (32px) — never shrink individual cues.
    2. Try 80% width for 2 balanced lines.
    3. Expand to 85% width if needed.
    4. Only if text is extremely long: allow 3 lines at 32px.
    """
    dummy = Image.new("RGBA", (1, 1))
    dd = ImageDraw.Draw(dummy)

    font = _load_font(FONT_SIZE)
    if font is None:
        raise RuntimeError("No usable CJK font found")

    # Normalize: join source SRT's pre-wrapped lines into a single string
    # so our wrapper can re-break at the proper width (~30 CJK chars/line).
    text = _normalize_text(text)

    max_text_w_default = int(VIDEO_WIDTH * WIDTH_FRAC_DEFAULT) - int(FONT_SIZE * BG_PAD_X_RATIO) * 2
    max_text_w_wide = int(VIDEO_WIDTH * WIDTH_FRAC_MAX) - int(FONT_SIZE * BG_PAD_X_RATIO) * 2

    # Try default width, then wide width
    for max_w in (max_text_w_default, max_text_w_wide):
        lines = _wrap_cjk(text, font, dd, max_w)
        if len(lines) <= 2:
            break

    # Fallback: allow 3 lines for extreme cases (very long text)
    if len(lines) > 3:
        lines = _wrap_cjk(text, font, dd, max_text_w_wide)
    if len(lines) > 3:
        lines = lines[:3]  # clamp to 3 lines max

    wrapped_text = "\n".join(lines)
    ls, bg_pad_x, bg_pad_y, bg_radius = _line_params(FONT_SIZE)

    # Measure
    bbox = dd.multiline_textbbox((0, 0), wrapped_text, font=font, spacing=ls)
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
    )

    return img


def main():
    if len(sys.argv) < 3:
        print("Usage: render-subtitles.py <srt_path> <output_dir>", file=sys.stderr)
        sys.exit(1)

    srt_path = sys.argv[1]
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    cues = parse_srt(srt_path)
    if not cues:
        print("Error: no cues found in SRT file", file=sys.stderr)
        sys.exit(1)

    # Load default font
    main_font = None
    for fp in FONT_CANDIDATES:
        if main_font is not None:
            break
        try:
            for idx in (3, 2, 1, 0):
                try:
                    main_font = ImageFont.truetype(fp, FONT_SIZE, index=idx)
                    break
                except (OSError, TypeError):
                    continue
        except OSError:
            continue
    if main_font is None:
        print("Error: no usable CJK font. Tried: " + ", ".join(FONT_CANDIDATES), file=sys.stderr)
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

    manifest_path = out_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(
            {"cues": manifest, "video_width": VIDEO_WIDTH, "video_height": 720},
            f,
            indent=2,
        )

    print(f"Rendered {len(cues)} subtitle images to {out_dir}")


if __name__ == "__main__":
    main()
