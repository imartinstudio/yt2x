"""检测视频底部是否已有烧录硬字幕，并判断是否为中文。

用法: python3 detect-burned-subs.py <video_path> [sample_count] [threshold]
返回 JSON:
  {
    "hasBurnedSubtitles": bool,          # 至少 2 帧底部边缘密度超阈值
    "hasChineseBurnedSubtitles": bool,   # 高置信帧 OCR 出足够汉字
    "shouldSkipBurn": bool,              # 与 hasChineseBurnedSubtitles 相同
    "scores": [...],
    "threshold": 0.04,
    "ocrAvailable": bool
  }

跳过烧录规则（与 pipeline 约定一致）：
  仅当「画面底部已有硬字幕」且「OCR 判定为中文」时才 shouldSkipBurn=true。
  仅有英文硬字幕、UI 条、进度条等误判，或无法 OCR 时，不跳过烧录。

依赖：PIL、ffmpeg、ffprobe；中文 OCR 可选 tesseract（chi_sim+eng）。
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
    pixels = list(bottom.getdata())
    row_len = bottom.width
    edges = 0
    for row in range(bottom.height):
        row_start = row * row_len
        for col in range(1, row_len):
            diff = abs(pixels[row_start + col] - pixels[row_start + col - 1])
            if diff > 30:
                edges += 1
    return edges / max(len(pixels), 1)


def is_cjk_char(ch: str) -> bool:
    o = ord(ch)
    return (
        0x4E00 <= o <= 0x9FFF
        or 0x3400 <= o <= 0x4DBF
        or 0xF900 <= o <= 0xFAFF
    )


def count_cjk(text: str) -> int:
    return sum(1 for ch in text if is_cjk_char(ch))


def looks_like_chinese_subtitle(text: str) -> bool:
    cleaned = "".join(ch for ch in text if not ch.isspace())
    if len(cleaned) < 2:
        return False
    cjk = count_cjk(cleaned)
    if cjk >= 4:
        return True
    return cjk / len(cleaned) >= 0.35


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

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        ocr_path = tmp.name
    try:
        bottom.save(ocr_path)
        result = subprocess.run(
            [
                "tesseract",
                ocr_path,
                "stdout",
                "-l",
                "chi_sim+eng",
                "--psm",
                "6",
                "--oem",
                "1",
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if result.returncode != 0:
            return ""
        return (result.stdout or "").strip()
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
    sample_count = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.04
    min_burned_frames = 2

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

    with tempfile.TemporaryDirectory() as tmpdir:
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
    has_burned = burned_frame_count >= min_burned_frames

    has_chinese = False
    ocr_samples: list[str] = []
    if has_burned and ocr_available:
        for frame_path in candidate_frames[:3]:
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
                "threshold": threshold,
                "ocrAvailable": ocr_available,
                **({"ocrSamples": ocr_samples} if ocr_samples else {}),
            }
        )
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
