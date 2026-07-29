"""对给定的英文原文做词级强制对齐（forced alignment），输出每个词的起止时间。

用法: python3 forced-align.py --audio <wav_path> --words <words.json> --output <output.json>
  words.json: 输入文本按词切分后的 JSON 数组，如 ["hello", "world", "today"]
  output.json: [{"word":"hello","start":0.04,"end":0.14}, ...]，与输入词一一对应且顺序一致

依赖：torch、torchaudio、torchcodec（首次运行 MMS_FA 会自动下载约 1.2GB 的
wav2vec2 对齐模型到 ~/.cache/torch/hub/checkpoints/）。这些依赖较重，不是这个
仓库其余脚本的标配（对比 detect-burned-subs.py 只需要 PIL）——按现有约定，
上层 TypeScript 只负责探测这些依赖是否存在（resolve-python.ts 里的
resolvePythonWithTorchaudio），从不自动安装；探测不到就整体跳过强制对齐，
退回原有的按字符占比猜测时长的办法。

失败处理：某个词如果被模型判定为超出词表（unsupported character），会跳过
该词、不产出对应条目——上层按 word 文本做 best-effort 匹配，缺失的词不强行
补齐时间戳。
"""

import argparse
import json
import re
import sys


def normalize_word_for_alignment(word: str) -> str:
    """MMS_FA 的 tokenizer 只认识小写罗马字符；去掉两端标点、转小写。"""
    return re.sub(r"^[^a-zA-Z0-9']+|[^a-zA-Z0-9']+$", "", word).lower()


def build_alignment_result(words: list[str], spans_by_word: list[list[tuple[float, float]]]) -> list[dict]:
    """把每个词的（可能多段）token span 合并成一条 {word, start, end}，跳过没有对齐结果的词。"""
    result = []
    for word, spans in zip(words, spans_by_word):
        if not spans:
            continue
        start = min(s for s, _ in spans)
        end = max(e for _, e in spans)
        result.append({"word": word, "start": start, "end": end})
    return result


def run_forced_alignment(audio_path: str, words: list[str]) -> list[dict]:
    import torch
    import torchaudio
    from torchaudio.pipelines import MMS_FA as bundle

    normalized = [normalize_word_for_alignment(w) for w in words]
    # Keep only words the tokenizer can actually handle; empty strings (all
    # punctuation, e.g. a lone "—") can't be aligned.
    alignable_idx = [i for i, w in enumerate(normalized) if w]
    if not alignable_idx:
        return []

    model = bundle.get_model()
    tokenizer = bundle.get_tokenizer()
    aligner = bundle.get_aligner()

    waveform, sample_rate = torchaudio.load(audio_path)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sample_rate != bundle.sample_rate:
        waveform = torchaudio.functional.resample(waveform, sample_rate, bundle.sample_rate)

    with torch.inference_mode():
        emission, _ = model(waveform)

    tokens = tokenizer([normalized[i] for i in alignable_idx])
    token_spans = aligner(emission[0], tokens)

    num_frames = emission.shape[1]
    ratio = waveform.shape[1] / num_frames / bundle.sample_rate

    spans_by_word: list[list[tuple[float, float]]] = [[] for _ in words]
    for pos, spans in zip(alignable_idx, token_spans):
        if not spans:
            continue
        spans_by_word[pos] = [(spans[0].start * ratio, spans[-1].end * ratio)]

    return build_alignment_result(words, spans_by_word)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--words", required=True, help="path to a JSON array of words")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    with open(args.words, "r", encoding="utf-8") as f:
        words = json.load(f)
    if not isinstance(words, list) or not all(isinstance(w, str) for w in words):
        print("error: --words must be a JSON array of strings", file=sys.stderr)
        return 1

    try:
        result = run_forced_alignment(args.audio, words)
    except Exception as e:  # noqa: BLE001 — any ML/runtime failure degrades gracefully upstream
        print(f"error: forced alignment failed: {e}", file=sys.stderr)
        return 1

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
