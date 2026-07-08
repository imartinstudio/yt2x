#!/usr/bin/env python3
"""Build full-frame overlay sequence: watermark + subtitles, matched to video FPS."""

import argparse
import json
import math
import sys
from pathlib import Path

from PIL import Image

WM_X = 24
WM_Y = 16
SUB_BOTTOM_MARGIN = 36


def composite_overlay_frame(
    video_w: int,
    video_h: int,
    subtitle_path: Path,
    watermark: Image.Image | None,
) -> Image.Image:
    """Composite watermark (top-left) and subtitle strip (bottom) onto a full-frame canvas."""
    frame = Image.new("RGBA", (video_w, video_h), (0, 0, 0, 0))
    if watermark is not None:
        frame.alpha_composite(watermark, (WM_X, WM_Y))
    subtitle = Image.open(subtitle_path).convert("RGBA")
    sub_x = max(0, (video_w - subtitle.width) // 2)
    sub_y = max(0, video_h - subtitle.height - SUB_BOTTOM_MARGIN)
    frame.alpha_composite(subtitle, (sub_x, sub_y))
    return frame


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate full-frame overlay sequence")
    parser.add_argument("render_dir", help="Directory with manifest.json and cue PNGs")
    parser.add_argument("frames_dir", help="Output directory for frame_#####.png files")
    parser.add_argument("blank_png", help="Transparent blank subtitle strip PNG")
    parser.add_argument("--fps", type=float, required=True, help="Overlay frame rate")
    parser.add_argument("--total-sec", type=float, required=True, help="Total overlay duration")
    parser.add_argument("--video-width", type=int, required=True)
    parser.add_argument("--video-height", type=int, required=True)
    parser.add_argument("--watermark", default="", help="Optional watermark PNG path")
    args = parser.parse_args()

    render_dir = Path(args.render_dir)
    frames_dir = Path(args.frames_dir)
    blank_png = Path(args.blank_png)
    manifest_path = render_dir / "manifest.json"

    if not manifest_path.exists():
        print(f"ERROR: manifest not found: {manifest_path}", file=sys.stderr)
        sys.exit(1)
    if not blank_png.exists():
        print(f"ERROR: blank PNG not found: {blank_png}", file=sys.stderr)
        sys.exit(1)

    with manifest_path.open(encoding="utf-8") as f:
        manifest = json.load(f)
    cues = manifest.get("cues", [])
    if not cues:
        print("ERROR: no cues in manifest", file=sys.stderr)
        sys.exit(1)

    fps = args.fps
    video_w = args.video_width
    video_h = args.video_height
    if fps <= 0 or video_w <= 0 or video_h <= 0:
        print("ERROR: fps and video dimensions must be positive", file=sys.stderr)
        sys.exit(1)

    watermark: Image.Image | None = None
    if args.watermark:
        wm_path = Path(args.watermark)
        if not wm_path.exists():
            print(f"ERROR: watermark PNG not found: {wm_path}", file=sys.stderr)
            sys.exit(1)
        watermark = Image.open(wm_path).convert("RGBA")

    total_frames = max(1, math.ceil(args.total_sec * fps))
    frames_dir.mkdir(parents=True, exist_ok=True)

    frame_cue: list[dict | None] = [None] * total_frames
    for cue in cues:
        first = max(0, math.floor(float(cue["start"]) * fps))
        last = min(total_frames - 1, math.ceil(float(cue["end"]) * fps) - 1)
        if last < first:
            continue
        for frame_idx in range(first, last + 1):
            frame_cue[frame_idx] = cue

    for frame_idx in range(total_frames):
        cue = frame_cue[frame_idx]
        if cue is not None:
            subtitle_path = render_dir / cue["filename"]
            if not subtitle_path.exists():
                print(f"ERROR: cue PNG missing: {subtitle_path}", file=sys.stderr)
                sys.exit(1)
        else:
            subtitle_path = blank_png

        frame = composite_overlay_frame(video_w, video_h, subtitle_path, watermark)
        frame.save(frames_dir / f"frame_{frame_idx:05d}.png")

    wm_note = "with watermark" if watermark is not None else "no watermark"
    print(
        f"Generated {total_frames} full-frame overlays at {fps}fps ({wm_note})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
