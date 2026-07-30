"""用 Demucs 把视频/音频拆成 vocals + no_vocals 两轨。

用法:
  python3 demucs-separate.py --input <video_or_audio> --out-dir <dir> [--model htdemucs]

产出（写在 --out-dir 下）:
  no_vocals.wav   伴奏/音效（配音混音用这一轨）
  vocals.wav      原人声（丢掉，仅留作调试）

依赖：demucs（含 torch）。上层 TypeScript 在任何计费调用之前先探测，
缺了就硬失败——静默降级会交出一个 BGM 被抹掉的成片。

实现走 `python -m demucs` 而不是 demucs CLI：有的环境只装了模块没装
console_script。--two-stems=vocals 直接给出两轨，不用再自己拼 drums+bass+other。
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def probe_demucs() -> None:
    import demucs  # noqa: F401


def extract_wav(input_path: Path, wav_path: Path) -> None:
    """ffmpeg 抽成 44.1k stereo wav，Demucs 对格式不挑剔但 wav 最稳。"""
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-ac",
        "2",
        "-ar",
        "44100",
        "-vn",
        str(wav_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg extract failed: {result.stderr[-500:]}")


def run_demucs(wav_path: Path, work_dir: Path, model: str) -> Path:
    """返回 demucs 写出的 track 目录（内含 vocals.wav / no_vocals.wav）。"""
    cmd = [
        sys.executable,
        "-m",
        "demucs",
        "--two-stems=vocals",
        "-n",
        model,
        "-o",
        str(work_dir),
        str(wav_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"demucs failed: {result.stderr[-800:] or result.stdout[-800:]}")

    # demucs 布局: <out>/<model>/<track_stem>/{vocals,no_vocals}.wav
    model_dir = work_dir / model
    if not model_dir.is_dir():
        raise RuntimeError(f"demucs output model dir missing: {model_dir}")
    track_dirs = [p for p in model_dir.iterdir() if p.is_dir()]
    if not track_dirs:
        raise RuntimeError(f"demucs produced no track dir under {model_dir}")
    return track_dirs[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Source video or audio file")
    parser.add_argument("--out-dir", required=True, help="Directory for no_vocals.wav / vocals.wav")
    parser.add_argument("--model", default="htdemucs", help="Demucs model name (default: htdemucs)")
    parser.add_argument(
        "--probe-only",
        action="store_true",
        help="Only check that demucs imports; print ok and exit",
    )
    args = parser.parse_args()

    try:
        probe_demucs()
    except Exception as exc:  # noqa: BLE001
        print(f"error: demucs is not importable: {exc}", file=sys.stderr)
        return 2

    if args.probe_only:
        print(json.dumps({"ok": True}))
        return 0

    input_path = Path(args.input)
    out_dir = Path(args.out_dir)
    if not input_path.is_file():
        print(f"error: input not found: {input_path}", file=sys.stderr)
        return 1
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="yt2x-demucs-") as tmp:
        tmp_dir = Path(tmp)
        wav_path = tmp_dir / "input.wav"
        try:
            extract_wav(input_path, wav_path)
            track_dir = run_demucs(wav_path, tmp_dir / "separated", args.model)
        except Exception as exc:  # noqa: BLE001
            print(f"error: {exc}", file=sys.stderr)
            return 1

        no_vocals = track_dir / "no_vocals.wav"
        vocals = track_dir / "vocals.wav"
        if not no_vocals.is_file():
            print(f"error: demucs did not write no_vocals.wav under {track_dir}", file=sys.stderr)
            return 1

        shutil.copy2(no_vocals, out_dir / "no_vocals.wav")
        if vocals.is_file():
            shutil.copy2(vocals, out_dir / "vocals.wav")

    print(
        json.dumps(
            {
                "ok": True,
                "noVocals": str(out_dir / "no_vocals.wav"),
                "vocals": str(out_dir / "vocals.wav"),
                "model": args.model,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
