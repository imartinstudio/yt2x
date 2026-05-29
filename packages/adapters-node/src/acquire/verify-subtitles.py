#!/usr/bin/env python3
"""Verify that a video frame has visible subtitles by comparing against a reference.

Takes two frames: the burned frame and the original (unburned) frame at the
same timestamp. Checks the bottom 25% for significant differences indicating
subtitle overlay.

Outputs: "PASS <reason>" or "FAIL <reason>"
"""

import sys
from PIL import Image


def check_frame(burned_path: str, original_path: str) -> tuple[bool, str]:
    """Compare burned vs original frame to detect subtitle presence."""
    try:
        burned = Image.open(burned_path).convert("L")
        original = Image.open(original_path).convert("L")
    except Exception as e:
        return False, f"FAIL cannot open frame: {e}"

    w, h = burned.size
    if w < 10 or h < 40:
        return False, "FAIL frame too small"

    # Narrow subtitle region: overlay places PNG at y = H - h - 36.
    # The rendered PNG is typically 70-120px tall. Focus on the bottom
    # 20% of the frame where subtitles always land regardless of PNG height.
    sub_top = int(h * 0.80)
    burned_sub = burned.crop((0, sub_top, w, h))
    orig_sub = original.crop((0, sub_top, w, h))

    bp = list(burned_sub.getdata())
    op = list(orig_sub.getdata())
    n = len(bp)
    sub_w = burned_sub.size[0]
    sub_h = burned_sub.size[1]

    # 1. Significant pixel change count: text pixels cause localized changes
    #    regardless of scene brightness. Use a moderate threshold (15) to
    #    catch text strokes on dark or bright backgrounds.
    changed_15 = sum(1 for i in range(n) if abs(bp[i] - op[i]) > 15)
    changed_ratio = changed_15 / n

    # 2. Mean absolute difference (still useful as a secondary signal)
    abs_diff_sum = sum(abs(bp[i] - op[i]) for i in range(n))
    mean_diff = abs_diff_sum / n

    # 3. Edge density increase — glyph strokes create sharp transitions
    #    even when overall brightness is similar.
    def edge_density(pixels, width, height):
        edge_count = 0
        for y in range(height):
            row_start = y * width
            for x in range(width - 1):
                if abs(pixels[row_start + x] - pixels[row_start + x + 1]) > 25:
                    edge_count += 1
        return edge_count / max(width * height, 1)

    burned_edges = edge_density(bp, sub_w, sub_h)
    orig_edges = edge_density(op, sub_w, sub_h)
    edge_increase = burned_edges - orig_edges

    # 4. Bright pixel injection check: subtitle text is white (255).
    #    Even on a dark scene, text pixels brighten the frame significantly.
    #    Count pixels in burned frame that are substantially brighter than
    #    the corresponding original pixel.
    brightened = sum(1 for i in range(n) if bp[i] - op[i] > 20)
    darkened = sum(1 for i in range(n) if op[i] - bp[i] > 20)
    # At least one direction should have significant changes
    max_change_dir = max(brightened, darkened) / n

    # Composite score
    score = 0.0
    reasons = []

    # changed_ratio is the strongest signal — text pixels differ regardless
    # of scene brightness. Typically 0.003–0.015 for subtitled frames.
    if changed_ratio > 0.0015:
        score += min(changed_ratio / 0.02, 1.0) * 40
        reasons.append(f"changed={changed_ratio:.4f}")
    if mean_diff > 0.5:
        score += min(mean_diff / 5.0, 1.0) * 20
        reasons.append(f"mean_diff={mean_diff:.2f}")
    if edge_increase > 0.0003:
        score += min(edge_increase / 0.01, 1.0) * 20
        reasons.append(f"edge_delta={edge_increase:.4f}")
    if max_change_dir > 0.001:
        score += min(max_change_dir / 0.015, 1.0) * 20
        reasons.append(f"change_dir={max_change_dir:.4f}")

    if score >= 25:
        return True, f"PASS score={score:.0f} ({', '.join(reasons)})"
    else:
        return False, (
            f"FAIL score={score:.0f} — insufficient subtitle signal "
            f"(changed={changed_ratio:.4f}, mean_diff={mean_diff:.2f}, "
            f"edge_delta={edge_increase:.4f}, change_dir={max_change_dir:.4f})"
        )


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: verify-subtitles.py <burned_frame.png> <original_frame.png>",
              file=sys.stderr)
        sys.exit(1)

    passed, msg = check_frame(sys.argv[1], sys.argv[2])
    # Always exit 0 — pass/fail is determined by parsing stdout prefix.
    # This avoids losing output when the caller's process runner throws on
    # non-zero exit codes.
    print(msg)
    sys.exit(0)
