#!/usr/bin/env python3
"""Render bilingual subtitle cues as transparent PNG images for ffmpeg overlay.

Input: bilingual SRT file (Chinese line 1, English line 2 per cue)
Output: PNG frames in a directory + manifest.json

Style: Chinese yellow bold large on top, English white italic smaller on bottom.
No background box — uses black outline for readability.
"""

import json
import re
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

VIDEO_WIDTH = 1280

# Font discovery
CJK_FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
]
LATIN_FONT_CANDIDATES = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
]

# Style: based on 720p baseline, scaled for 1280x720
ZH_FONT_SIZE = 58
EN_FONT_SIZE = 34
ZH_FILL = (255, 244, 0, 255)  # bright yellow
EN_FILL = (255, 255, 255, 255)  # white
OUTLINE_COLOR = (0, 0, 0, 255)
ZH_OUTLINE_W = 3
EN_OUTLINE_W = 2

# Margins from bottom (pixels)
ZH_MARGIN_BOTTOM = 120
EN_MARGIN_BOTTOM = 68


def find_font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def parse_srt(srt_path: str) -> list[dict]:
    """Parse SRT file, return list of {index, start_s, end_s, zh_text, en_text}."""
    cues = []
    with open(srt_path, encoding="utf-8") as f:
        content = f.read()

    for block in content.strip().split("\n\n"):
        lines = [l.strip() for l in block.split("\n") if l.strip()]
        if len(lines) < 3:
            continue
        # lines[0] = index, lines[1] = timestamp, lines[2:] = text lines
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
        # First line = Chinese, rest = English (joined)
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
    position: tuple[int, int],
    font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int, int],
    outline_color: tuple[int, int, int, int],
    outline_width: int,
):
    """Draw text with a black outline by stamping the text in all directions."""
    x, y = position
    # Draw outline
    for dx in range(-outline_width, outline_width + 1):
        for dy in range(-outline_width, outline_width + 1):
            if dx == 0 and dy == 0:
                continue
            draw.text((x + dx, y + dy), text, font=font, fill=outline_color)
    # Draw fill text on top
    draw.text((x, y), text, font=font, fill=fill)


def render_cue(cue: dict, zh_font, en_font, out_dir: Path) -> dict:
    """Render one bilingual cue, return manifest entry."""
    # Calculate text sizes
    zh_bbox = draw_text_with_outline.__code__  # placeholder
    # Create temporary image to measure text
    temp = Image.new("RGBA", (1, 1))
    temp_draw = ImageDraw.Draw(temp)
    zh_bbox = temp_draw.textbbox((0, 0), cue["zh_text"], font=zh_font)
    en_bbox = temp_draw.textbbox((0, 0), cue["en_text"], font=en_font)

    zh_w = zh_bbox[2] - zh_bbox[0]
    zh_h = zh_bbox[3] - zh_bbox[1]
    en_w = en_bbox[2] - en_bbox[0]
    en_h = en_bbox[3] - en_bbox[1]

    # Calculate total height (two lines with gap)
    line_gap = 4
    zh_outline_pad = ZH_OUTLINE_W * 2
    en_outline_pad = EN_OUTLINE_W * 2
    total_h = zh_h + line_gap + en_h + zh_outline_pad + en_outline_pad + 8

    max_w = max(zh_w, en_w) + max(zh_outline_pad, en_outline_pad) + 4
    max_w = min(max_w, int(VIDEO_WIDTH * 0.92))

    # Handle text wrapping if needed
    if max_w >= int(VIDEO_WIDTH * 0.90):
        # Text too wide — wrap Chinese to two lines if possible
        # Simple approach: just use the width as-is, ffmpeg overlay handles centering
        pass

    img = Image.new("RGBA", (max_w, total_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Draw Chinese (top)
    zh_x = (max_w - zh_w) // 2
    zh_y = ZH_OUTLINE_W + 2
    draw_text_with_outline(
        draw, cue["zh_text"], (zh_x, zh_y), zh_font, ZH_FILL, OUTLINE_COLOR, ZH_OUTLINE_W
    )

    # Draw English (bottom)
    en_x = (max_w - en_w) // 2
    en_y = zh_y + zh_h + line_gap + ZH_OUTLINE_W
    draw_text_with_outline(
        draw, cue["en_text"], (en_x, en_y), en_font, EN_FILL, OUTLINE_COLOR, EN_OUTLINE_W
    )

    filename = f"cue_{cue['index']:04d}.png"
    img.save(out_dir / filename)

    return {
        "index": cue["index"],
        "filename": filename,
        "start": cue["start_s"],
        "end": cue["end_s"],
        "width": max_w,
        "height": total_h,
    }


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <bilingual.srt> <output_dir>", file=sys.stderr)
        sys.exit(1)

    srt_path = sys.argv[1]
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    zh_font = find_font(CJK_FONT_CANDIDATES, ZH_FONT_SIZE)
    en_font = find_font(LATIN_FONT_CANDIDATES, EN_FONT_SIZE)

    print(f"ZH font: {zh_font.path if hasattr(zh_font, 'path') else 'default'}", file=sys.stderr)
    print(f"EN font: {en_font.path if hasattr(en_font, 'path') else 'default'}", file=sys.stderr)

    cues = parse_srt(srt_path)
    if not cues:
        print("ERROR: no cues found in SRT", file=sys.stderr)
        sys.exit(1)

    manifest_entries = []
    for cue in cues:
        entry = render_cue(cue, zh_font, en_font, out_dir)
        manifest_entries.append(entry)

    manifest = {
        "cues": manifest_entries,
        "video_width": VIDEO_WIDTH,
        "video_height": 0,  # not needed for bilingual render
    }
    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f)

    print(f"Rendered {len(cues)} bilingual cues to {out_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
