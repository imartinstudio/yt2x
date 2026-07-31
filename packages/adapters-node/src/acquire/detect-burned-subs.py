"""检测视频底部是否已有烧录硬字幕，并判断是否为中文。

用法: python3 detect-burned-subs.py <video_path> [sample_count] [threshold]
返回 JSON:
  {
    "hasBurnedSubtitles": bool,          # 足够多帧通过「边缘提名 + 字幕版式」
    "hasChineseBurnedSubtitles": bool,   # 版式命中帧 OCR 为中文字幕（非代码/UI）
    "shouldSkipBurn": bool,              # 与 hasChineseBurnedSubtitles 相同
    "scores": [...],
    "layoutHitCount": int,
    "threshold": 0.015,
    "ocrAvailable": bool
  }

跳过烧录规则（与 pipeline 约定一致）：
  仅当「画面字幕安全区呈居中硬字幕版式」且「OCR 判定为中文」时才 shouldSkipBurn=true。
  录屏底部代码/界面文字会抬高边缘密度，但版式检查会拒绝满幅密排，避免假阳性。
  仅有英文硬字幕、UI 条、进度条等误判，或无法 OCR 时，不跳过烧录。

依赖：PIL、ffmpeg、ffprobe；中文 OCR 可选 tesseract（优先 chi_sim+chi_tra+eng）。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile


def detect_edge_ratio(image_path: str) -> float:
    """计算图像底部 20% 区域的边缘像素比例。"""
    from PIL import Image, ImageOps

    img = Image.open(image_path).convert("L")
    w, h = img.size
    bottom = img.crop((0, int(h * 0.80), w, h))
    bottom = ImageOps.autocontrast(bottom)
    return _region_edge_ratio(bottom)


def _region_edge_ratio(region) -> float:
    pixels = list(region.getdata())
    row_len = region.width
    edges = 0
    for row in range(region.height):
        row_start = row * row_len
        for col in range(1, row_len):
            diff = abs(pixels[row_start + col] - pixels[row_start + col - 1])
            if diff > 30:
                edges += 1
    return edges / max(len(pixels), 1)


def analyze_subtitle_layout(image_path: str) -> dict:
    """区分字幕安全区居中叠加 vs 录屏底部满幅 UI/代码。

    字幕：安全区内亮像素水平居中、竖直只占少数行（通常 1–2 行）。
    录屏：底部多行、亮/边缘内容铺满整宽（代码/终端/界面）。
    """
    from PIL import Image, ImageOps

    img = Image.open(image_path).convert("L")
    w, h = img.size
    y0, y1 = int(h * 0.78), int(h * 0.96)
    zone = ImageOps.autocontrast(img.crop((0, y0, w, y1)))
    tw = max(zone.width, 1)
    th = max(zone.height, 1)
    pixels = list(zone.getdata())

    bright_thresh = 170
    row_profiles: list[tuple[float, float, float, float]] = []
    for row in range(th):
        row_pix = pixels[row * tw : (row + 1) * tw]
        bright_idx = [i for i, p in enumerate(row_pix) if p >= bright_thresh]
        if not bright_idx:
            row_profiles.append((0.0, 0.0, 0.0, 0.0))
            continue
        bright_ratio = len(bright_idx) / tw
        left_third = sum(1 for i in bright_idx if i < tw // 3) / tw
        center_third = sum(1 for i in bright_idx if tw // 3 <= i < (2 * tw) // 3) / tw
        right_third = sum(1 for i in bright_idx if i >= (2 * tw) // 3) / tw
        row_profiles.append((bright_ratio, left_third, center_third, right_third))

    active = [p for p in row_profiles if p[0] > 0.04]
    active_rows = len(active)
    if active_rows == 0:
        return {
            "is_subtitle_like": False,
            "center_edge": 0.0,
            "side_edge": 0.0,
            "active_bands": 0,
            "full_width_dense": False,
        }

    avg_bright = sum(p[0] for p in active) / active_rows
    avg_left = sum(p[1] for p in active) / active_rows
    avg_center = sum(p[2] for p in active) / active_rows
    avg_right = sum(p[3] for p in active) / active_rows
    side_avg = (avg_left + avg_right) / 2.0

    centered = avg_center > 0.03 and avg_center >= side_avg * 1.5 and side_avg <= avg_center * 0.8
    # Subtitles usually occupy a thin vertical strip; screencasts fill many rows.
    max_subtitle_rows = max(int(th * 0.45), 8)
    vertically_compact = active_rows <= max_subtitle_rows
    full_width_dense = (
        avg_left > 0.03
        and avg_center > 0.03
        and avg_right > 0.03
        and active_rows >= max(int(th * 0.55), 10)
    )

    left_e = _region_edge_ratio(zone.crop((0, 0, tw // 3, th)))
    center_e = _region_edge_ratio(zone.crop((tw // 3, 0, (2 * tw) // 3, th)))
    right_e = _region_edge_ratio(zone.crop(((2 * tw) // 3, 0, tw, th)))

    is_subtitle_like = centered and vertically_compact and not full_width_dense
    return {
        "is_subtitle_like": is_subtitle_like,
        "center_edge": round(center_e, 4),
        "side_edge": round((left_e + right_e) / 2.0, 4),
        "active_bands": active_rows,
        "full_width_dense": full_width_dense,
        "center_bright": round(avg_center, 4),
        "side_bright": round(side_avg, 4),
        "avg_bright": round(avg_bright, 4),
    }


def frame_looks_like_hard_subtitle(image_path: str) -> bool:
    """单帧是否呈现烧录硬字幕版式（不依赖 OCR）。"""
    return analyze_subtitle_layout(image_path)["is_subtitle_like"] is True


def is_cjk_char(ch: str) -> bool:
    o = ord(ch)
    return (
        0x4E00 <= o <= 0x9FFF
        or 0x3400 <= o <= 0x4DBF
        or 0xF900 <= o <= 0xFAFF
    )


def count_cjk(text: str) -> int:
    return sum(1 for ch in text if is_cjk_char(ch))


_CODE_OR_UI_MARKERS = (
    "{",
    "}",
    "=>",
    "&&",
    "||",
    "npm ",
    "pnpm ",
    "const ",
    "function ",
    "import ",
    "export ",
    "://",
    "</",
    "/>",
    "();",
    ");",
)


def looks_like_code_or_ui_ocr(text: str) -> bool:
    lowered = text.lower()
    if any(marker.lower() in lowered for marker in _CODE_OR_UI_MARKERS):
        return True
    ascii_letters = sum(1 for ch in text if ("a" <= ch.lower() <= "z") or ch.isdigit())
    punct = sum(1 for ch in text if ch in "{}[]();=<>|/\\`$#@")
    if ascii_letters >= 8 and punct >= 3:
        return True
    return False


def looks_like_chinese_subtitle(text: str) -> bool:
    cleaned = "".join(ch for ch in text if not ch.isspace())
    if len(cleaned) < 2:
        return False
    if looks_like_code_or_ui_ocr(text):
        return False
    cjk = count_cjk(cleaned)
    if cjk >= 4:
        return True
    return cjk / len(cleaned) >= 0.35


def available_tesseract_languages() -> set[str]:
    try:
        result = subprocess.run(
            ["tesseract", "--list-langs"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return set()
    if result.returncode != 0:
        return set()
    return {
        line.strip()
        for line in (result.stdout or "").splitlines()
        if line.strip() and not line.lower().startswith("list of available")
    }


def ocr_language_candidates() -> list[str]:
    langs = available_tesseract_languages()
    if not langs:
        return ["chi_sim+chi_tra+eng", "chi_tra+eng", "chi_sim+eng", "eng"]

    has_sim = "chi_sim" in langs
    has_tra = "chi_tra" in langs
    has_eng = "eng" in langs

    candidates: list[str] = []
    if has_sim and has_tra and has_eng:
        candidates.append("chi_sim+chi_tra+eng")
    if has_sim and has_tra:
        candidates.append("chi_sim+chi_tra")
    if has_tra and has_eng:
        candidates.append("chi_tra+eng")
    if has_sim and has_eng:
        candidates.append("chi_sim+eng")
    if has_tra:
        candidates.append("chi_tra")
    if has_sim:
        candidates.append("chi_sim")
    if has_eng:
        candidates.append("eng")
    return candidates


def ocr_bottom_region(image_path: str) -> str:
    """对帧底部 20% 做 OCR；无 tesseract 时返回空字符串。"""
    if shutil.which("tesseract") is None:
        return ""

    from PIL import Image, ImageOps

    img = Image.open(image_path)
    w, h = img.size
    bottom = img.crop((0, int(h * 0.80), w, h))
    scale = 2
    bottom = bottom.resize((max(w * scale, 1), max(bottom.height * scale, 1)))
    bottom = ImageOps.autocontrast(bottom.convert("L"))

    ocr_dir = os.path.expanduser("~/tmp")
    os.makedirs(ocr_dir, exist_ok=True)
    ocr_fd, ocr_path = tempfile.mkstemp(suffix=".png", dir=ocr_dir)
    os.close(ocr_fd)
    try:
        bottom.save(ocr_path)
        for languages in ocr_language_candidates():
            result = subprocess.run(
                [
                    "tesseract",
                    ocr_path,
                    "stdout",
                    "-l",
                    languages,
                    "--psm",
                    "6",
                    "--oem",
                    "1",
                ],
                capture_output=True,
                timeout=20,
            )
            # decode stdout manually; ignore stderr decode errors
            stdout_text = ""
            try:
                stdout_text = result.stdout.decode("utf-8") if result.stdout else ""
            except UnicodeDecodeError:
                stdout_text = result.stdout.decode("utf-8", errors="replace") if result.stdout else ""
            if result.returncode == 0 and stdout_text.strip():
                return stdout_text.strip()
        return ""
    finally:
        try:
            os.remove(ocr_path)
        except OSError:
            pass


def get_video_duration(video_path: str) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            video_path,
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    return float(result.stdout.strip())


def main() -> None:
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {
                    "error": "usage: detect-burned-subs.py <video_path> [sample_count] [threshold]",
                }
            )
        )
        sys.exit(1)

    video_path = sys.argv[1]
    sample_count = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.015
    min_burned_frames = 3

    ocr_available = shutil.which("tesseract") is not None

    if not os.path.exists(video_path):
        print(json.dumps({"error": f"video not found: {video_path}"}))
        sys.exit(1)

    try:
        duration = get_video_duration(video_path)
    except Exception as e:
        print(json.dumps({"error": f"failed to get video duration: {e}"}))
        sys.exit(1)

    empty = {
        "hasBurnedSubtitles": False,
        "hasChineseBurnedSubtitles": False,
        "shouldSkipBurn": False,
        "scores": [],
        "threshold": threshold,
        "ocrAvailable": ocr_available,
    }

    if duration < 10:
        print(json.dumps({**empty, "note": "video too short"}))
        sys.exit(0)

    start = duration * 0.15
    end = duration * 0.85
    step = (end - start) / (sample_count - 1) if sample_count > 1 else 0
    timestamps = [start + step * i for i in range(sample_count)]

    scores: list[float] = []
    candidate_frames: list[str] = []

    # Use a temp dir outside sandbox — tesseract subprocess can't read /tmp/claude-501/
    tmpdir = tempfile.mkdtemp(dir=os.path.expanduser("~/tmp"), prefix="burned-subs-")
    try:
        for i, t in enumerate(timestamps):
            frame_path = os.path.join(tmpdir, f"frame-{i:02d}.jpg")
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-ss",
                    str(t),
                    "-i",
                    video_path,
                    "-vframes",
                    "1",
                    "-q:v",
                    "2",
                    frame_path,
                    "-y",
                ],
                capture_output=True,
                timeout=30,
            )
            if result.returncode != 0 or not os.path.exists(frame_path):
                continue
            try:
                score = detect_edge_ratio(frame_path)
                scores.append(score)
                if score > threshold:
                    candidate_frames.append(frame_path)
            except Exception:
                continue

        if not scores:
            print(json.dumps({"error": "failed to extract any frames"}))
            sys.exit(1)

        burned_frame_count = sum(1 for s in scores if s > threshold)
        layout_hits = [
            frame_path
            for frame_path in candidate_frames
            if frame_looks_like_hard_subtitle(frame_path)
        ]
        # 边缘密度只负责提名；录屏底部代码也会超阈值，必须再过字幕版式关。
        has_burned = len(layout_hits) >= 2

        has_chinese = False
        ocr_samples: list[str] = []
        if has_burned and ocr_available:
            for frame_path in layout_hits[:3]:
                text = ocr_bottom_region(frame_path)
                if text:
                    ocr_samples.append(text[:120])
                if looks_like_chinese_subtitle(text):
                    has_chinese = True
                    break

        should_skip = has_chinese

        print(
            json.dumps(
                {
                    "hasBurnedSubtitles": has_burned,
                    "hasChineseBurnedSubtitles": has_chinese,
                    "shouldSkipBurn": should_skip,
                    "scores": [round(s, 4) for s in scores],
                    "burnedFrameCount": burned_frame_count,
                    "layoutHitCount": len(layout_hits),
                    "threshold": threshold,
                    "ocrAvailable": ocr_available,
                    **({"ocrSamples": ocr_samples} if ocr_samples else {}),
                }
            )
        )
        sys.exit(0)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    main()
