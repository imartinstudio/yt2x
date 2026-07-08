#!/usr/bin/env python3
"""Generate a compact top-left watermark PNG for bilingual video burn."""

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BOLD_FONT_CANDIDATES = [
    ("/System/Library/Fonts/PingFang.ttc", 2),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 3),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
]


def find_font(size: int) -> ImageFont.FreeTypeFont:
    for path, face_index in BOLD_FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size, index=face_index)
            except Exception:
                continue
    return ImageFont.load_default()


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate bilingual-burn watermark PNG")
    parser.add_argument("output", help="Output PNG path")
    parser.add_argument("--watermark-video", default="", help="Source channel handle")
    parser.add_argument("--watermark-xlate", default="", help="Translator handle")
    parser.add_argument("--font-size", type=int, default=28)
    args = parser.parse_args()

    lines: list[str] = []
    if args.watermark_video:
        lines.append(f"视频：{args.watermark_video}")
    if args.watermark_xlate:
        lines.append(f"翻译：{args.watermark_xlate}")
    if not lines:
        print("ERROR: at least one watermark line is required", file=sys.stderr)
        sys.exit(1)

    font = find_font(args.font_size)
    line_gap = 6
    # ~24% opacity — subtle; visible only on close inspection
    text_fill = (0, 0, 0, 60)

    measure = Image.new("RGBA", (1, 1))
    measure_draw = ImageDraw.Draw(measure)
    max_w = 0
    line_metrics: list[tuple[int, int]] = []
    for line in lines:
        bbox = measure_draw.textbbox((0, 0), line, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        max_w = max(max_w, w)
        line_metrics.append((w, h))

    total_h = sum(h for _, h in line_metrics) + line_gap * (len(lines) - 1)
    img_w = max_w
    img_h = total_h

    img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    y = 0
    for line, (w, h) in zip(lines, line_metrics):
        draw.text((0, y), line, font=font, fill=text_fill)
        y += h + line_gap

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    print(f"Watermark saved to {out} ({img_w}x{img_h})", file=sys.stderr)


if __name__ == "__main__":
    main()
