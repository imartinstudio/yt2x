"""检测视频底部是否已有烧录字幕（硬字幕）。

用法: python3 detect-burned-subs.py <video_path> [sample_count] [threshold]
返回: JSON {"hasBurnedSubtitles": true/false, "scores": [...], "threshold": 0.04}
退出码: 0=检测完成（不管有无字幕），非0=检测失败

算法: 对视频多个时间点采样帧，裁剪底部 20%，计算边缘密度。
      字幕文字产生的边缘密度通常 > 0.04，无字幕帧通常 < 0.03。
      只需要有一帧超过阈值就判定为有字幕。
"""

import json
import subprocess
import sys
import tempfile
import os
import math


def detect_edge_ratio(image_path: str) -> float:
    """计算图像底部 20% 区域的边缘像素比例。"""
    from PIL import Image

    img = Image.open(image_path).convert("L")
    w, h = img.size
    bottom = img.crop((0, int(h * 0.80), w, h))
    pixels = list(bottom.getdata())
    row_len = bottom.width
    edges = 0
    for row in range(bottom.height):
        row_start = row * row_len
        for col in range(1, row_len):
            diff = abs(pixels[row_start + col] - pixels[row_start + col - 1])
            if diff > 30:
                edges += 1
    return edges / len(pixels)


def get_video_duration(video_path: str) -> float:
    """获取视频时长（秒）。"""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", video_path,
        ],
        capture_output=True, text=True, timeout=15,
    )
    return float(result.stdout.strip())


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: detect-burned-subs.py <video_path> [sample_count] [threshold]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    sample_count = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.04

    if not os.path.exists(video_path):
        print(json.dumps({"error": f"video not found: {video_path}"}))
        sys.exit(1)

    # 获取视频时长
    try:
        duration = get_video_duration(video_path)
    except Exception as e:
        print(json.dumps({"error": f"failed to get video duration: {e}"}))
        sys.exit(1)

    if duration < 10:
        print(json.dumps({"hasBurnedSubtitles": False, "scores": [], "note": "video too short"}))
        sys.exit(0)

    # 在视频 15%-85% 区间均匀采样
    start = duration * 0.15
    end = duration * 0.85
    step = (end - start) / (sample_count - 1) if sample_count > 1 else 0
    timestamps = [start + step * i for i in range(sample_count)]

    scores = []
    with tempfile.TemporaryDirectory() as tmpdir:
        for i, t in enumerate(timestamps):
            frame_path = os.path.join(tmpdir, f"frame-{i:02d}.jpg")
            result = subprocess.run(
                ["ffmpeg", "-ss", str(t), "-i", video_path,
                 "-vframes", "1", "-q:v", "2", frame_path, "-y"],
                capture_output=True, timeout=30,
            )
            if result.returncode != 0 or not os.path.exists(frame_path):
                continue
            try:
                score = detect_edge_ratio(frame_path)
                scores.append(score)
            except Exception:
                continue

    if not scores:
        print(json.dumps({"error": "failed to extract any frames"}))
        sys.exit(1)

    # 任何一帧超过阈值就算有字幕
    has_burned = any(s > threshold for s in scores)
    print(json.dumps({
        "hasBurnedSubtitles": has_burned,
        "scores": [round(s, 4) for s in scores],
        "threshold": threshold,
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
