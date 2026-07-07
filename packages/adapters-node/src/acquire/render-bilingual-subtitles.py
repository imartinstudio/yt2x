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
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

VIDEO_WIDTH = 1280

# Font discovery — use fonts that cover BOTH CJK and Latin glyphs.
# Helvetica/Arial cannot render CJK; STHeiti/PingFang/Hiragino handle both.
UNIVERSAL_FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
]

# Style: based on 720p baseline, scaled for 1280x720
ZH_FONT_SIZE = 58
EN_FONT_SIZE = 34
ZH_FILL = (255, 244, 0, 255)  # bright yellow (#FFF400)
EN_FILL = (255, 255, 255, 255)  # pure white
OUTLINE_COLOR = (0, 0, 0, 255)  # black
ZH_OUTLINE_W = 4  # thicker outline for Chinese readability
EN_OUTLINE_W = 2  # thinner outline for English

MAX_WIDTH_FRAC = 0.90  # max text width as fraction of video width


def find_font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    for p in candidates:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def contains_cjk(text: str) -> bool:
    """Check if text contains any CJK characters."""
    for ch in text:
        cp = ord(ch)
        if (
            (0x4E00 <= cp <= 0x9FFF)  # CJK Unified
            or (0x3400 <= cp <= 0x4DBF)  # CJK Extension A
            or (0xF900 <= cp <= 0xFAFF)  # CJK Compatibility
            or (0x2E80 <= cp <= 0x2EFF)  # CJK Radicals
            or (0x3000 <= cp <= 0x303F)  # CJK Symbols
            or (0xFF00 <= cp <= 0xFFEF)  # Halfwidth/Fullwidth
        ):
            return True
    return False


def wrap_text(
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: int,
    draw: ImageDraw.ImageDraw,
) -> list[str]:
    """Wrap text into multiple lines to fit within max_width.

    For CJK text: break at any character boundary.
    For Latin text: break at word boundaries (spaces).
    """
    if not text:
        return [""]

    # Quick check: does it fit on one line?
    bbox = draw.textbbox((0, 0), text, font=font)
    if bbox[2] - bbox[0] <= max_width:
        return [text]

    has_cjk = contains_cjk(text)

    if has_cjk:
        # CJK wrapping: character-by-character, keep punctuation with preceding char
        lines: list[str] = []
        current = ""
        for ch in text:
            test = current + ch
            bbox = draw.textbbox((0, 0), test, font=font)
            if bbox[2] - bbox[0] > max_width and current:
                lines.append(current)
                current = ch
            else:
                current = test
        if current:
            lines.append(current)
        return lines
    else:
        # Latin wrapping: word-by-word
        words = text.split(" ")
        lines = []
        current = ""
        for word in words:
            sep = " " if current else ""
            test = current + sep + word
            bbox = draw.textbbox((0, 0), test, font=font)
            if bbox[2] - bbox[0] > max_width and current:
                lines.append(current)
                current = word
            else:
                current = test
        if current:
            lines.append(current)
        return lines


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
        zh_text = text_lines[0] if text_lines else ""
        en_text = " ".join(text_lines[1:]) if len(text_lines) > 1 else ""

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
    text_lines: list[str], font: ImageFont.FreeTypeFont, draw: ImageDraw.ImageDraw
) -> tuple[int, int, list[tuple[int, int, int, int]]]:
    """Measure wrapped text lines. Returns (max_width, total_height, line_bboxes)."""
    max_w = 0
    total_h = 0
    bboxes = []
    gap = 2  # pixels between wrapped lines
    for i, line_text in enumerate(text_lines):
        bbox = draw.textbbox((0, 0), line_text, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        max_w = max(max_w, w)
        bboxes.append((0, total_h, w, total_h + h))
        total_h += h + (gap if i < len(text_lines) - 1 else 0)
    return max_w, total_h, bboxes


def render_cue(
    cue: dict,
    zh_font: ImageFont.FreeTypeFont,
    en_font: ImageFont.FreeTypeFont,
    out_dir: Path,
) -> dict:
    """Render one bilingual cue as a transparent PNG, return manifest entry."""
    max_text_width = int(VIDEO_WIDTH * MAX_WIDTH_FRAC)

    # Temporary draw for measurement
    temp = Image.new("RGBA", (1, 1))
    temp_draw = ImageDraw.Draw(temp)

    # Wrap text
    zh_lines = wrap_text(cue["zh_text"], zh_font, max_text_width, temp_draw)
    en_lines = wrap_text(cue["en_text"], en_font, max_text_width, temp_draw)

    # Measure wrapped lines
    zh_max_w, zh_total_h, zh_bboxes = measure_lines(zh_lines, zh_font, temp_draw)
    en_max_w, en_total_h, en_bboxes = measure_lines(en_lines, en_font, temp_draw)

    # Canvas dimensions
    zh_pad = ZH_OUTLINE_W * 2 + 4
    en_pad = EN_OUTLINE_W * 2 + 4
    line_gap = 6  # vertical gap between Chinese and English blocks

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
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <bilingual.srt> <output_dir>", file=sys.stderr)
        sys.exit(1)

    srt_path = sys.argv[1]
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    # Use universal fonts that cover BOTH CJK and Latin glyphs.
    # The "English" line may contain CJK characters when the source
    # video has Chinese subtitles (source_language=zh-Hans).
    zh_font = find_font(UNIVERSAL_FONT_CANDIDATES, ZH_FONT_SIZE)
    en_font = find_font(UNIVERSAL_FONT_CANDIDATES, EN_FONT_SIZE)

    zh_path = zh_font.path if hasattr(zh_font, "path") else "default"
    en_path = en_font.path if hasattr(en_font, "path") else "default"
    print(f"ZH font: {zh_path} ({ZH_FONT_SIZE}px)", file=sys.stderr)
    print(f"EN font: {en_path} ({EN_FONT_SIZE}px)", file=sys.stderr)

    cues = parse_srt(srt_path)
    if not cues:
        print("ERROR: no cues found in SRT", file=sys.stderr)
        sys.exit(1)

    manifest_entries = []
    for cue in cues:
        entry = render_cue(cue, zh_font, en_font, out_dir)
        manifest_entries.append(entry)

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
