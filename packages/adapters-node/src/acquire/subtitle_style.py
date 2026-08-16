#!/usr/bin/env python3
"""The visual contract shared by both subtitle renderers.

Single source of truth for what burned subtitles LOOK like — faces, weights,
fills, outline, shadow, tracking. Both `render-subtitles.py` (single-language
Chinese) and `render-bilingual-subtitles.py` (Chinese over English) import from
here, so the Chinese row is the same design in either delivery.

Layout deliberately stays with each renderer: the single-language path sizes
type adaptively per cue to fill the caption area, the bilingual path stacks two
fixed-height rows so ffmpeg's image2 sequence never resizes mid-stream. Those
are genuinely different problems. What must not diverge is how the text reads
once placed, and that is what lives here.

Everything is stated at the 720p baseline and scaled by `videoHeight / 720`,
so the two renderers land on identical pixels at any one resolution even though
they arrive at their type sizes by different routes.
"""

import math
import re
import unicodedata
from pathlib import Path
from PIL import ImageFont

# A font candidate is (path, face_index, family_name, variation_name | None).
# variation_name selects a named instance on a variable font; None means the
# face_index already picks the weight.
FontCandidate = tuple[str, int, str, "str | None"]

_REPO_FONT_DIR = Path(__file__).resolve().parent / "fonts"

# ── Chinese ──
# Source Han Sans Heavy is the requested face. Noto Sans SC is the same design
# under Google's name and ships as a variable font whose Black instance IS
# weight 900, which is what the spec asks for; the Source Han static releases
# name that weight "Heavy". It is ~17MB of CJK outlines, far too big to vendor,
# so it is discovered on the host — BaoCut's bundled copy first, since that is
# the one machine-local place it reliably exists.
#
# The PingFang / Hiragino tail is a legibility fallback only: neither has a 900
# weight, so a host without a Source Han face renders a visibly lighter Chinese
# row rather than failing. `zh_weight_warning()` reports that.
_NOTO_SANS_SC_VARIABLE = (
    "/Applications/BaoCut.app/Contents/Resources/skills/baocut/templates/studio/"
    "fonts/NotoSansSC-Variable.ttf"
)
ZH_FONT_CANDIDATES: list[FontCandidate] = [
    (_NOTO_SANS_SC_VARIABLE, 0, "Noto Sans SC Black", "Black"),
    (str(Path.home() / "Library/Fonts/NotoSansSC-Variable.ttf"), 0, "Noto Sans SC Black", "Black"),
    (str(Path.home() / "Library/Fonts/SourceHanSansSC-Heavy.otf"), 0, "Source Han Sans SC Heavy", None),
    ("/Library/Fonts/SourceHanSansSC-Heavy.otf", 0, "Source Han Sans SC Heavy", None),
    # Face index picks the heaviest available weight:
    #   PingFang.ttc: 0=Regular, 1=Medium, 2=Semibold
    #   Hiragino Sans GB.ttc: 0=W3, 3=W6(bold)
    ("/System/Library/Fonts/PingFang.ttc", 2, "PingFang SC", None),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 3, "Hiragino Sans GB", None),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0, "STHeiti", None),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0, "Arial Unicode", None),
]

# ── English ──
# Inter Bold is the requested English face, and unlike the Chinese one it is
# small enough (~420KB) to vendor, so the repo copy is authoritative and the
# host is never consulted for it. Inter carries no CJK glyphs, so it can only
# head a fallback chain — an English cue still needs a Chinese face for the
# occasional CJK character inside it.
#
# It was SemiBold until a burn test over bright UI footage: with no outline, the
# lighter weight was the weakest thing on screen. Bold plus the hairline below
# is what makes this row hold up on a near-white background.
EN_FONT_CANDIDATES: list[FontCandidate] = [
    (str(_REPO_FONT_DIR / "Inter-Bold.ttf"), 0, "Inter Bold", None),
    ("/System/Library/Fonts/PingFang.ttc", 2, "PingFang SC", None),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 3, "Hiragino Sans GB", None),
]

# The English row's CJK slot deliberately does NOT ask for weight 900: it has to
# sit next to Inter Bold, not next to the Heavy Chinese row above it.
EN_CJK_FONT_CANDIDATES: list[FontCandidate] = [
    (_NOTO_SANS_SC_VARIABLE, 0, "Noto Sans SC Bold", "Bold"),
    ("/System/Library/Fonts/PingFang.ttc", 2, "PingFang SC", None),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 3, "Hiragino Sans GB", None),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0, "STHeiti", None),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0, "Arial Unicode", None),
]

# ── Colour ──
ZH_FILL = (255, 255, 255, 255)
EN_FILL = (255, 255, 255, 255)  # pure white
EN_HIGHLIGHT_FILL = (255, 217, 40, 255)  # #FFD928
OUTLINE_COLOR = (0, 0, 0, 255)  # pure black

# The one word the English row accents. `\b` on a case-sensitive match keeps it
# to the standalone token: "AI" and "AI-native" hit, "AIs" and "SAIL" do not.
# Chinese passes highlight_re=None, so this never touches that row.
EN_HIGHLIGHT_RE = re.compile(r"\bAI\b")

# ── Outline ──
# Deliberately NOT a font-size fraction: an 8%-of-font-size outline scaled to
# 2-4px across our resolutions and read as too heavy. A hairline is a fixed
# visual weight regardless of type size, so it stays a constant pixel count —
# which also means the single-language row keeps the same hairline as the
# bilingual one despite setting type more than twice as large.
#
# The design spec asks for shadow only, but a white glyph on a near-white scene
# needs an edge to survive, so the hairline is kept underneath the shadow. Both
# rows carry it: English ran without one until a burn test over bright UI
# footage showed it was by far the first thing to become unreadable.
ZH_OUTLINE_PX = 1
EN_OUTLINE_PX = 1

# ── Type size ──
# Chinese is set at one size, the same in both deliveries: single-language
# captions are the bilingual Chinese row with the English row removed, not a
# larger variant of it.
#
# This used to be the single-language renderer's own business, and it set type
# in a 52-72px adaptive range — picking the largest size that kept each cue on
# one line. That produced a visibly different caption from the bilingual row
# AND made the size jump from cue to cue. It is a fixed size now: cues arrive
# from `projectSemanticBilingualSubtitles` already split to the 16/14/20 CJK
# budget, so a well-formed cue fits one line at this size without shrinking,
# and anything longer wraps rather than shrinking away from the contract.
ZH_FONT_SIZE_BASE = 30

# ── Line pitch ──
# Baseline-to-baseline distance for wrapped text, as a multiple of the row's own
# font size. This is a look, not a layout detail, so every row derives from it:
# the two renderers used to disagree badly — a row would either add a flat 2px
# to the face's own line height (~1.50em for Chinese, lines nearly touching,
# with line one's drop shadow muddying line two) or add 0.55em on top of it
# (2.00em, the two lines reading as separate blocks).
#
# 1.65em is the middle ground that actually reads as one multi-line caption:
# real separation, enough room for the shadow to fall clear of the line below,
# and no wasted vertical space in the safe area. One value covers both
# languages because it is applied to each row's own size, so the smaller
# English row gets a proportionally smaller gap.
LINE_PITCH_EM = 1.65

# ── Tracking ──
# An em fraction of the row's own font size, so it scales with resolution like
# everything else. Chinese is untracked: CJK glyphs already sit on a fixed
# advance and extra spacing just loosens the word shapes.
ZH_TRACKING_EM = 0.0
EN_TRACKING_EM = 0.02

# ── Shadow ──
# Chinese transcribes the design spec's CSS `0 4px 20px rgba(0,0,0,.5)` as
# absolute 720p pixels, NOT as a fraction of the font size. That distinction
# matters here in a way it would not in the bilingual renderer alone: the
# single-language path picks a different type size for every cue, so a
# font-relative shadow would visibly change weight from one caption to the
# next. Absolute px scaled only by resolution keeps one shadow for the whole
# video, and keeps both renderers on the same one.
ZH_SHADOW_CSS_OFFSET_PX = (0, 4)
ZH_SHADOW_CSS_BLUR_PX = 20
ZH_SHADOW_OPACITY = 0.50
ZH_SHADOW_RGB = (0, 0, 0)

# English keeps the earlier BaoCut-derived shadow (距离 0.08 / 模糊 0.1 at 45°):
# the design spec sets English face, colour and tracking but says nothing about
# its shadow. It stays light on purpose — raising its opacity to carry
# legibility by itself is what produced the "too heavy" look, and now the
# hairline outline does that job instead.
# It is font-relative because the bilingual row it belongs to has one fixed
# type size per resolution.
EN_SHADOW_ANGLE_DEG = 45
EN_SHADOW_DISTANCE_FRAC = 0.08
EN_SHADOW_BLUR_FRAC = 0.10
EN_SHADOW_OPACITY = 0.42
EN_SHADOW_RGB = (64, 64, 64)  # #404040

# Text is held to this fraction of the video width in both renderers, so the
# horizontal safe area does not move between single-language and bilingual
# delivery.
MAX_WIDTH_FRAC = 0.80

# Every absolute pixel value above is stated at this frame height.
BASELINE_VIDEO_HEIGHT = 720


def resolution_scale(video_height: int) -> float:
    """Scale factor for the absolute pixel values in this module."""
    return video_height / BASELINE_VIDEO_HEIGHT


# ── Chinese caption text treatment ──
# What the Chinese row draws is not the raw cue text, and the two renderers
# have to agree on the transformation or they render visibly different strings
# from the same SRT.

_CJK_CLASS = r"[぀-ヿ㐀-䶿一-鿿豈-﫿]"
_CJK_THEN_LATIN = re.compile(f"({_CJK_CLASS})([A-Za-z0-9])")
_LATIN_THEN_CJK = re.compile(f"([A-Za-z0-9])({_CJK_CLASS})")


def clean_subtitle_text(text: str) -> str:
    """Remove punctuation from Chinese text: in-sentence marks become a single
    space, trailing marks are dropped, and decimal points between digits
    (e.g. 4.5, v0.1) are kept.

    The space a comma leaves behind is the point — it reads as the pause the
    punctuation stood for, without putting a glyph on screen.
    """
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


def space_cjk_latin(text: str) -> str:
    """Insert a space at every CJK↔Latin boundary, the standard CJK
    typesetting convention: "我的Grill Me和..." reads as
    "我的 Grill Me 和...". Without it the embedded product names run straight
    into the surrounding Chinese with no visual separation."""
    spaced = _CJK_THEN_LATIN.sub(r"\1 \2", text)
    return _LATIN_THEN_CJK.sub(r"\1 \2", spaced)


def zh_caption_text(text: str) -> str:
    """The full Chinese row treatment: punctuation to pauses, then CJK↔Latin
    spacing. Both renderers call this, so one SRT yields one string."""
    return space_cjk_latin(clean_subtitle_text(text))


def draw_outlined_runs(
    draw,
    placed: list[tuple[float, str, ImageFont.FreeTypeFont, tuple[int, int, int, int]]],
    baseline_y: float,
    outline_width: int,
    outline_color: tuple[int, int, int, int],
    anchor: str = "ls",
) -> None:
    """Draw pre-positioned text runs on one baseline, outlined.

    `placed` is [(x, text, font, fill)] — the caller has already decided where
    each run starts, which is what lets one primitive serve both a single-face
    Chinese line and a mixed-script line that switches faces per run.

    The outline is a 3x3 offset dilation of the glyph, NOT Pillow's
    `stroke_width` (which strokes the true contour via FreeType). The two are
    a pixel or two apart at the same nominal width, so the choice is part of
    the look, not an implementation detail — both renderers have to make the
    same one or their Chinese rows stop matching.

    Two passes, every outline before any fill. Interleaving them per run lets a
    later run's outline paint over the glyph fill of the run before it, which
    would nick the right edge of a character sitting against a face or colour
    boundary.
    """
    if outline_width > 0:
        for dx in range(-outline_width, outline_width + 1):
            for dy in range(-outline_width, outline_width + 1):
                if dx == 0 and dy == 0:
                    continue
                for x, text, font, _ in placed:
                    draw.text(
                        (x + dx, baseline_y + dy), text,
                        font=font, fill=outline_color, anchor=anchor,
                    )

    for x, text, font, fill in placed:
        draw.text((x, baseline_y), text, font=font, fill=fill, anchor=anchor)


def line_gap(font_size: int, font_line_height: int, outline_px: int) -> int:
    """The extra pixels to insert between wrapped lines of one row.

    Callers supply the face's own line height (ascent + descent), because that
    already covers most of the pitch; this returns only the remainder. Never
    less than the outline needs on both sides, so hairlines cannot collide even
    if a face reports an unusually tall line height.
    """
    pitch = round(font_size * LINE_PITCH_EM)
    return max(pitch - font_line_height, outline_px * 2)


def find_font(candidates: list[FontCandidate], size: int) -> tuple[ImageFont.FreeTypeFont, str]:
    """Load the first available candidate, selecting its named weight instance
    when the candidate asks for one and the file is a variable font (Noto Sans
    SC ships as one, so weight 900 means selecting its 'Black' instance rather
    than faking weight)."""
    for path, face_index, family_name, variation in candidates:
        if Path(path).exists():
            try:
                font = ImageFont.truetype(path, size, index=face_index)
            except Exception:
                continue
            if variation is not None:
                try:
                    if variation.encode() in font.get_variation_names():
                        font.set_variation_by_name(variation)
                    else:
                        continue  # static face under a variable face's name
                except OSError:
                    pass  # static face — its index already selects the weight
            return font, family_name
    return ImageFont.load_default(), "Pillow default"


def zh_weight_warning(resolved_family: str) -> str | None:
    """The message to log when the Chinese face is not the specified weight 900,
    or None when it is. Falling through to PingFang or Hiragino still renders,
    but visibly lighter than the design — callers say so rather than letting it
    pass as the intended look."""
    if "Black" in resolved_family or "Heavy" in resolved_family:
        return None
    return (
        f"no weight-900 Chinese face found; fell back to {resolved_family}. "
        f"Install Source Han Sans SC Heavy or NotoSansSC-Variable into "
        f"~/Library/Fonts for the specified look."
    )


class ShadowStyle:
    """One row's resolved shadow: pixel offset, Gaussian blur radius and RGBA.

    `blur` is a real sigma handed to Pillow's GaussianBlur, not the stamped
    offset trail these renderers used to fake a shadow with.
    """

    def __init__(self, dx: int, dy: int, blur: float, color: tuple[int, int, int, int]):
        self.dx = dx
        self.dy = dy
        self.blur = blur
        self.color = color

    def vertical_pad(self) -> int:
        return self.dy + math.ceil(self.blur) * 2

    def __repr__(self) -> str:
        return (
            f"ShadowStyle(offset=({self.dx},{self.dy}), "
            f"blur={self.blur:.2f}, color={self.color})"
        )


def shadow_rgba(rgb: tuple[int, int, int], opacity: float) -> tuple[int, int, int, int]:
    return (*rgb, round(255 * opacity))


def zh_shadow(video_height: int) -> ShadowStyle:
    """The Chinese shadow at a given frame height.

    CSS states blur as 2-sigma while Pillow's GaussianBlur radius IS sigma, so
    the spec's 20px reaches Pillow as 10. Passing 20 straight through would
    double the intended spread.
    """
    scale = resolution_scale(video_height)
    dx, dy = ZH_SHADOW_CSS_OFFSET_PX
    return ShadowStyle(
        round(dx * scale),
        round(dy * scale),
        (ZH_SHADOW_CSS_BLUR_PX / 2) * scale,
        shadow_rgba(ZH_SHADOW_RGB, ZH_SHADOW_OPACITY),
    )


def en_shadow(font_size: int) -> ShadowStyle:
    """The English shadow, stated relative to its own font size. 45° puts it
    down-right, the conventional direction for a caption drop shadow."""
    distance = font_size * EN_SHADOW_DISTANCE_FRAC
    rad = math.radians(EN_SHADOW_ANGLE_DEG)
    return ShadowStyle(
        round(distance * math.cos(rad)),
        round(distance * math.sin(rad)),
        font_size * EN_SHADOW_BLUR_FRAC,
        shadow_rgba(EN_SHADOW_RGB, EN_SHADOW_OPACITY),
    )
