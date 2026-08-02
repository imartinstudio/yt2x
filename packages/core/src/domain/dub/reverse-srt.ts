import { splitUtteranceIntoCues } from "./cue-split.js";
import { formatMsToSrtTimestamp } from "./srt-time.js";
import type { DubPlacedLine, DubScriptLine } from "./types.js";

/**
 * 从最终落点反向生成双语 SRT：中文取配音稿、英文取同一话语单元的原文，两者共用同一条
 * T′ 时间轴（`buildReverseSrtCues` 只负责在此基础上做 SRT 落地必需的边界收敛）。
 *
 * 字幕时间戳必须跟配音音频一致，而不是原片字幕——顺延和调速都会让两者分叉。一个话语
 * 单元先按屏宽细分成若干显示单元（见 `cue-split.ts`），再逐条落地成 cue；显示单元始终
 * 从属于某个话语单元，而话语单元时长是实测值，因此字幕不会随视频推进累积漂移。
 *
 * 英文来自 `DubScriptLine.sourceText`，不是 `full.en.srt`——后者是按屏宽切碎的英文原始
 * 字幕，句子边界已经被打散；`sourceText` 是话语单元自己的完整自然句，直接用不需要
 * "从切碎字幕里还原句子" 这一步（那是 `semantic-bilingual-subtitles.ts` 的语义投影要解
 * 决的问题，配音链路的话语单元已经天然解决了它，见 docs/DUB-TASK.md「两级切分」）。
 */

export type ReverseSrtCue = {
  index: number;
  startMs: number;
  endMs: number;
  /** 配音稿中文，烧录时显示在上面一行。 */
  zhText: string;
  /** 同一话语单元的英文原文，烧录时显示在下面一行；找不到源文本时为空字符串。 */
  enText: string;
};

/**
 * 把每条配音落点（话语单元）细分成显示单元，过滤空文本，并保证时间轴单调不重叠。
 * 英文按 `line.index` 在 `scriptLines` 里查对应话语单元的 `sourceText`——两者共享同一套
 * index 空间（`DubPlacedLine.index` 全程复用 `Utterance.index`，见 `dub/script.ts`），
 * 找不到时留空而不是报错，避免一条数据缺失拖垮整份字幕。
 */
export const buildReverseSrtCues = (
  lines: readonly DubPlacedLine[],
  scriptLines: readonly DubScriptLine[],
): ReverseSrtCue[] => {
  const sourceByIndex = new Map(scriptLines.map((line) => [line.index, line.sourceText]));
  const cues: ReverseSrtCue[] = [];
  let cursor = 0;

  for (const line of lines) {
    const zhText = line.text.trim();
    if (zhText.length === 0) continue;

    const startMs = Math.max(0, Math.round(line.startMs));
    let endMs = Math.max(0, Math.round(line.endMs));
    if (endMs <= startMs) {
      // 零时长 cue 会被烧录完整性检查杀掉；至少给 1ms
      endMs = startMs + Math.max(1, Math.round(line.durationMs) || 1);
    }

    const enText = sourceByIndex.get(line.index) ?? "";
    const displayCues = splitUtteranceIntoCues({ zhText, enText, startMs, endMs });

    for (const cue of displayCues) {
      let cueStart = cue.startMs;
      let cueEnd = cue.endMs;
      // 与前一条重叠时，把起点推到前一条终点——听感上字幕会略晚，但不会让烧录失败
      if (cueStart < cursor) cueStart = cursor;
      if (cueEnd <= cueStart) cueEnd = cueStart + 1;

      cues.push({
        index: cues.length + 1,
        startMs: cueStart,
        endMs: cueEnd,
        zhText: cue.zhText,
        enText: cue.enText,
      });
      cursor = cueEnd;
    }
  }

  return cues;
};

/**
 * 渲染成 SRT 文本，双语排版为「中文在上、英文在下」，与既有双语字幕交付
 * （`render-bilingual-subtitles.py`：first line = Chinese (top), rest = English (bottom)）
 * 保持一致。英文源文本缺失时只输出中文一行，不留空行占位。
 */
export const formatReverseSrt = (
  lines: readonly DubPlacedLine[],
  scriptLines: readonly DubScriptLine[],
): string => {
  const cues = buildReverseSrtCues(lines, scriptLines);
  if (cues.length === 0) return "";

  const blocks: string[] = [];
  for (const cue of cues) {
    const textLines = cue.enText.length > 0 ? [cue.zhText, cue.enText] : [cue.zhText];
    blocks.push(
      String(cue.index),
      `${formatMsToSrtTimestamp(cue.startMs)} --> ${formatMsToSrtTimestamp(cue.endMs)}`,
      ...textLines,
      "",
    );
  }
  return blocks.join("\n");
};

/**
 * 中文单语 SRT——与 {@link formatReverseSrt} 共用同一批 cue（相同 index / 相同时间戳），
 * 只是每条只留中文一行。存在的唯一目的是供双语交付路径的质量门
 * （`auditSubtitleArtifacts` 的三份 SRT 一致性检查）比对，不单独烧录。
 */
export const formatReverseZhSrt = (
  lines: readonly DubPlacedLine[],
  scriptLines: readonly DubScriptLine[],
): string => {
  const cues = buildReverseSrtCues(lines, scriptLines);
  if (cues.length === 0) return "";

  const blocks: string[] = [];
  for (const cue of cues) {
    blocks.push(
      String(cue.index),
      `${formatMsToSrtTimestamp(cue.startMs)} --> ${formatMsToSrtTimestamp(cue.endMs)}`,
      cue.zhText,
      "",
    );
  }
  return blocks.join("\n");
};

/**
 * 英文单语 SRT，用途同 {@link formatReverseZhSrt}。故意不像 {@link formatReverseSrt}
 * 那样在缺英文源文本时省略该行——三份 SRT 必须逐条 index/时间戳对齐，省略会打破对齐
 * 检查；找不到源文本时该条留空文本本身就是一个真实信号（该行没有对应的英文原文可比对），
 * 应该被质量门的 empty-text 检查抓到，而不是被静默吞掉。
 */
export const formatReverseEnSrt = (
  lines: readonly DubPlacedLine[],
  scriptLines: readonly DubScriptLine[],
): string => {
  const cues = buildReverseSrtCues(lines, scriptLines);
  if (cues.length === 0) return "";

  const blocks: string[] = [];
  for (const cue of cues) {
    blocks.push(
      String(cue.index),
      `${formatMsToSrtTimestamp(cue.startMs)} --> ${formatMsToSrtTimestamp(cue.endMs)}`,
      cue.enText,
      "",
    );
  }
  return blocks.join("\n");
};
