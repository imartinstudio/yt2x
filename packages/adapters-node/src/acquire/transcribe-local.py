"""用本地 faster-whisper 转写一段音频，产出自然分段的 SRT 与词级时间戳。

用法: python3 transcribe-local.py --audio <wav_path> --language en \
    --srt-output <out.srt> --words-output <out.words.json> [--model small]

背景：YouTube 自动字幕的 cue 边界是平台自己按显示行宽切的，经常在词组中间
硬切（如 "this axis," 被切成两条 cue），我们的 Phase 0 又从不跨 cue 边界
重排文字，坏的源边界会直接传导到最终双语字幕里。faster-whisper 基于停顿
（VAD）做的自然分段明显更贴近语义边界，实测同一条视频里，YouTube 原始
cue 里 4.1% 是孤立的单词残句，faster-whisper 的自然分段只有 0.4%。

输出两个文件：
  <out.srt>：自然分段的英文字幕，格式与 YouTube/whisper-cli 产出的 SRT
    完全一致，可以直接替换现有 pipeline 的输入源，不需要改 Phase 0/1/2。
  <out.words.json>：[{"word":"hello","start":0.04,"end":0.14}, ...]，
    与 forced-align.py 的 WordTiming 输出格式一致，可以直接喂给现有的
    wordTimings 机制做精确的逗号拆分定位，不需要再跑一遍 --align-audio。

依赖：faster-whisper（较重，非本仓库标配）。上层 TypeScript 只负责探测
是否可用（resolve-python.ts 里的 resolvePythonWithFasterWhisper），探测
不到就跳过本地转写通道，保留 YouTube 字幕通道作为唯一来源。
"""

import argparse
import json
import sys


def format_srt_timestamp(seconds: float) -> str:
    total_ms = round(seconds * 1000)
    hours, rem_ms = divmod(total_ms, 3_600_000)
    minutes, rem_ms = divmod(rem_ms, 60_000)
    secs, ms = divmod(rem_ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def run_transcription(audio_path: str, language: str, model_size: str) -> tuple[list[dict], list[dict]]:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(
        audio_path,
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )

    srt_cues: list[dict] = []
    word_timings: list[dict] = []
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        srt_cues.append({"start": seg.start, "end": seg.end, "text": text})
        for w in seg.words or []:
            word = w.word.strip()
            if not word:
                continue
            word_timings.append({"word": word, "start": w.start, "end": w.end})
    return srt_cues, word_timings


def write_srt(cues: list[dict], output_path: str) -> None:
    lines = []
    for i, cue in enumerate(cues, start=1):
        lines.append(str(i))
        lines.append(f"{format_srt_timestamp(cue['start'])} --> {format_srt_timestamp(cue['end'])}")
        lines.append(cue["text"])
        lines.append("")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
        f.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--language", default="en")
    parser.add_argument("--model", default="small", help="faster-whisper model size (default: small)")
    parser.add_argument("--srt-output", required=True)
    parser.add_argument("--words-output", required=True)
    args = parser.parse_args()

    try:
        cues, word_timings = run_transcription(args.audio, args.language, args.model)
    except Exception as e:  # noqa: BLE001 — any ML/runtime failure degrades gracefully upstream
        print(f"error: local transcription failed: {e}", file=sys.stderr)
        return 1

    if not cues:
        print("error: local transcription produced no segments", file=sys.stderr)
        return 1

    write_srt(cues, args.srt_output)
    with open(args.words_output, "w", encoding="utf-8") as f:
        json.dump(word_timings, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
