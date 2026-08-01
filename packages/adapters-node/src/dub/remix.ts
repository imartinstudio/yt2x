import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DubPlacedLine } from "@yt2x/core";
import { defaultProcessRunner, type ProcessRunner } from "../process/index.js";
import { probeAudioDurationMs } from "./synthesize.js";

/**
 * 混音 + 冻结帧 → 交给双语字幕交付路径统一烧录一次（不再自建烧录，见
 * docs/DUB-TASK.md「数据流」结尾：「配音不再自己烧片。它交出音轨与时间轴映射，由双语
 * 交付路径统一烧录」）。
 *
 * 1. 按落点把逐句 mp3 拼成完整人声轨（句间补静音）
 * 2. 与 Demucs no_vocals 混合；音轨长度对齐「原片 + 冻结延长」，不是止于最后一句人声
 *    → 交出的「中文音轨」
 * 3. 只有当人声跑到原片时长之外时，才需要画面 tpad 冻结末帧补到同一长度（决策 #11）——
 *    这一刀必须现在就切，因为下一步的双语烧录只按原片时长生成字幕叠加帧序列，画面本身
 *    的时长要在交给它之前就锁定好。多数情况下（人声不超原片时长）完全不需要这一步，
 *    这时直接把原片路径交出去，双语烧录会在它自己那一次 ffmpeg 调用里换上这里产出的
 *    中文音轨、烧上字幕——全程只编码一次。
 *
 * 注意：绝不用 `-shortest` 收尾——它会把刚 tpad 出的冻结帧按短音频砍掉，
 * 使决策 #11 变成死代码。改用显式 `-t` 锁定成片时长。
 */

export const DUBBED_VIDEO_NAME = "full.zh-dubbed.mp4";
export const DUB_REVERSE_SRT_NAME = "full.zh-dub.srt";

/** 与交接反馈回路一致：实测时长与计划差超过此值即判失败。 */
export const DUB_RENDER_DURATION_TOLERANCE_MS = 50;

/** 人声轨统一用这个编码；行音频先转成它再 concat，避免 mp3+wav 异构被 demuxer 静默丢段。 */
const VOICE_WAV_CODEC = "pcm_s16le";
const VOICE_WAV_RATE = "44100";
const VOICE_WAV_CHANNELS = "1";

const FFMPEG_TIMEOUT_MS = 60 * 60 * 1000;

/** concat demuxer 列表里所有文件必须同扩展名，否则后段可能被整段丢弃且 exit 0。 */
export const assertConcatEntriesHomogeneous = (filePaths: readonly string[]): void => {
  if (filePaths.length === 0) return;
  const exts = filePaths.map((p) => path.extname(p).toLowerCase());
  const first = exts[0]!;
  const mismatched = [...new Set(exts.filter((e) => e !== first))];
  if (mismatched.length > 0) {
    throw new Error(
      `concat entries must share one extension (got ${first} plus ${mismatched.join(", ")}); ` +
        "decode every input to the same container before concat",
    );
  }
};

/** 渲染结果护栏：计划时长与实测差过大就硬失败（mixed.m4a 被 apad 补满时看不出问题）。 */
export const assertRenderedDurationMs = (input: {
  actualMs: number;
  expectedMs: number;
  label: string;
  toleranceMs?: number;
}): void => {
  const tolerance = input.toleranceMs ?? DUB_RENDER_DURATION_TOLERANCE_MS;
  const diff = input.actualMs - input.expectedMs;
  if (Math.abs(diff) > tolerance) {
    throw new Error(
      `VOICE TRACK LENGTH MISMATCH: ${input.label} duration mismatch ` +
        `(expected=${input.expectedMs} actual=${input.actualMs} diff=${diff}, ` +
        `tolerance=${tolerance}ms)`,
    );
  }
};

/**
 * exit 0 不等于渲染正确：concat 异构输入时 demuxer 会丢掉坏包并继续。
 * 命中这类 stderr 一律当失败，逼上层修编码一致性。
 */
export const assertFfmpegStderrClean = (stderr: string): void => {
  if (/Error submitting packet to decoder/i.test(stderr)) {
    throw new Error(
      `ffmpeg reported decoder errors despite exit 0 (likely mixed-codec concat): ` +
        `${stderr.match(/.*Error submitting packet to decoder.*/i)?.[0] ?? stderr.slice(-300)}`,
    );
  }
};

/** 成片时长：覆盖完整原片（含片尾 BGM），并容纳协商残留漂移。 */
export const computeDubbedOutputDurationMs = (input: {
  voiceEndMs: number;
  videoDurationMs: number;
  extendMs: number;
}): number => {
  const extend = Math.max(0, input.extendMs);
  return Math.max(input.voiceEndMs, input.videoDurationMs + extend);
};

/** 人声与 BGM 都 apad 到成片时长，避免 amix duration=first 被人声截断。 */
export const mixVoiceAndBgmFilterComplex = (durationSec: number): string => {
  const whole = durationSec.toFixed(3);
  return [
    `[0:a]aformat=sample_rates=44100:channel_layouts=mono,volume=1.0,apad=whole_dur=${whole}[voice]`,
    `[1:a]aformat=sample_rates=44100:channel_layouts=mono,volume=0.7,apad=whole_dur=${whole}[bgm]`,
    `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
  ].join(";");
};

export const buildMuxDubbedVideoArgs = (input: {
  videoPath: string;
  audioPath: string;
  outputPath: string;
  /** 画面需要冻结的毫秒数（outputMs - videoDurationMs）。 */
  videoPadMs: number;
  /** 成片总时长；与音轨对齐，用 -t 锁定，不用 -shortest。 */
  outputDurationMs: number;
}): string[] => {
  const outputSec = (input.outputDurationMs / 1000).toFixed(3);
  const args = ["-y", "-i", input.videoPath, "-i", input.audioPath];
  if (input.videoPadMs > 0) {
    const padSec = (input.videoPadMs / 1000).toFixed(3);
    args.push(
      "-filter_complex",
      `[0:v]tpad=stop_mode=clone:stop_duration=${padSec}[v]`,
      "-map",
      "[v]",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-c:a",
      "copy",
      "-t",
      outputSec,
      input.outputPath,
    );
  } else {
    args.push(
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-t",
      outputSec,
      input.outputPath,
    );
  }
  return args;
};

export type RemixDubbedAudioInput = {
  videoPath: string;
  noVocalsPath: string;
  placedLines: readonly DubPlacedLine[];
  /** 配音目录，用于解析 audioFile 相对路径，也是 voice.wav / mixed.m4a 的落盘目录。 */
  dubDir: string;
  extendMs: number;
  runner?: ProcessRunner;
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
};

export type RemixDubbedAudioResult = {
  /**
   * 交给双语烧录路径当视频输入：人声没有跑出原片时长时就是 `videoPath` 本身（未改动、
   * 未重编码）；跑出时长时是已经 tpad 冻结延长、且已经带上正确中文音轨的中间产物——
   * 这种情况下 `replaceAudioPath` 是 undefined，因为音轨已经在这一步烧进去了。
   */
  videoForBurnPath: string;
  /**
   * 交给双语烧录路径的「替换音轨」参数；`videoForBurnPath` 已经自带正确音轨（冻结帧
   * 分支）时为 undefined，调用方不应再传。
   */
  replaceAudioPath?: string;
  voiceTrackPath: string;
  /** 混音后的中文音轨（人声 + BGM），已 pad 到 outputDurationMs——这是交出的「中文音轨」。 */
  mixedAudioPath: string;
  /** 成片目标时长：覆盖完整原片，并容纳协商残留漂移。 */
  outputDurationMs: number;
  /** 画面需要冻结延长的毫秒数；0 表示不需要冻结帧。 */
  videoPadMs: number;
  extendMs: number;
};

const runFfmpeg = async (
  runner: ProcessRunner,
  ffmpegPath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<void> => {
  const result = await runner.run({
    command: ffmpegPath,
    args: [...args],
    timeoutMs: FFMPEG_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`);
  }
  assertFfmpegStderrClean(result.stderr);
};

/**
 * 从完整原片抽出时间窗到临时文件（不得写入 downloads）。
 * 用 stream copy，失败时由调用方决定是否重编码。
 */
export const extractDubSourceWindow = async (input: {
  videoPath: string;
  outputPath: string;
  startMs: number;
  endMs?: number;
  runner?: ProcessRunner;
  ffmpegPath?: string;
  signal?: AbortSignal;
}): Promise<string> => {
  const runner = input.runner ?? defaultProcessRunner;
  const ffmpegPath = input.ffmpegPath ?? "ffmpeg";
  await mkdir(path.dirname(input.outputPath), { recursive: true });
  const args = ["-y", "-ss", (Math.max(0, input.startMs) / 1000).toFixed(3)];
  if (input.endMs !== undefined) {
    args.push("-to", (input.endMs / 1000).toFixed(3));
  }
  args.push(
    "-i",
    input.videoPath,
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    input.outputPath,
  );
  await runFfmpeg(runner, ffmpegPath, args, input.signal);
  return input.outputPath;
};

/**
 * 用 concat demuxer 拼人声轨：前导静音 + 句 + 句间静音 + …
 *
 * 方案 C：行音频先解码成与静音相同的 WAV（pcm_s16le / 44100 / mono），再拼接。
 * 直接拼 MP3+WAV 时 demuxer 会按首段当 MP3 解后续 WAV，静音整段丢弃且 exit 0。
 */
export const buildVoiceTrack = async (input: {
  placedLines: readonly DubPlacedLine[];
  dubDir: string;
  outputPath: string;
  runner: ProcessRunner;
  ffmpegPath: string;
  workDir: string;
  ffprobePath?: string;
  signal?: AbortSignal;
}): Promise<number> => {
  if (input.placedLines.length === 0) {
    throw new Error("cannot build voice track: no placed lines");
  }

  const listPath = path.join(input.workDir, "voice-concat.txt");
  const silenceDir = path.join(input.workDir, "silence");
  const decodedDir = path.join(input.workDir, "decoded-lines");
  await mkdir(silenceDir, { recursive: true });
  await mkdir(decodedDir, { recursive: true });

  const entries: string[] = [];
  const entryPaths: string[] = [];
  let cursor = 0;
  let silenceSeq = 0;
  let lineSeq = 0;

  const pushEntry = (filePath: string): void => {
    entryPaths.push(filePath);
    entries.push(`file '${filePath.replace(/'/g, "'\\''")}'`);
  };

  const pushSilence = async (durationMs: number): Promise<void> => {
    if (durationMs <= 0) return;
    const sec = (durationMs / 1000).toFixed(3);
    const silencePath = path.join(silenceDir, `s${silenceSeq}.wav`);
    silenceSeq += 1;
    await runFfmpeg(input.runner, input.ffmpegPath, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${VOICE_WAV_RATE}:cl=mono`,
      "-t",
      sec,
      "-c:a",
      VOICE_WAV_CODEC,
      silencePath,
    ], input.signal);
    pushEntry(silencePath);
    cursor += durationMs;
  };

  for (const line of input.placedLines) {
    const gap = Math.round(line.startMs) - cursor;
    if (gap > 0) await pushSilence(gap);
    else if (gap < 0) {
      // 重叠：仍拼接，听感上会叠字，但比丢句强；上层 reverse-srt 已尽量推开
    }
    const audioPath = path.resolve(input.dubDir, line.audioFile);
    lineSeq += 1;
    const decodedPath = path.join(decodedDir, `${String(lineSeq).padStart(4, "0")}.wav`);
    await runFfmpeg(input.runner, input.ffmpegPath, [
      "-y",
      "-i",
      audioPath,
      "-c:a",
      VOICE_WAV_CODEC,
      "-ar",
      VOICE_WAV_RATE,
      "-ac",
      VOICE_WAV_CHANNELS,
      decodedPath,
    ], input.signal);
    pushEntry(decodedPath);
    cursor = Math.max(cursor, Math.round(line.startMs)) + Math.round(line.durationMs);
  }

  assertConcatEntriesHomogeneous(entryPaths);
  await writeFile(listPath, `${entries.join("\n")}\n`, "utf8");
  await runFfmpeg(input.runner, input.ffmpegPath, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c:a",
    VOICE_WAV_CODEC,
    "-ar",
    VOICE_WAV_RATE,
    "-ac",
    VOICE_WAV_CHANNELS,
    input.outputPath,
  ], input.signal);

  const actualMs = await probeAudioDurationMs({
    filePath: input.outputPath,
    runner: input.runner,
    ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  assertRenderedDurationMs({
    actualMs,
    expectedMs: cursor,
    label: `voice track ${input.outputPath}`,
  });

  return cursor;
};

/** 人声 + BGM 混合为单一音轨；`durationMs` 必须是成片目标时长（含原片尾 + 冻结）。 */
export const mixVoiceAndBgm = async (input: {
  voicePath: string;
  noVocalsPath: string;
  outputPath: string;
  durationMs: number;
  runner: ProcessRunner;
  ffmpegPath: string;
  ffprobePath?: string;
  signal?: AbortSignal;
}): Promise<void> => {
  const durationSec = (input.durationMs / 1000).toFixed(3);
  await runFfmpeg(input.runner, input.ffmpegPath, [
    "-y",
    "-i",
    input.voicePath,
    "-i",
    input.noVocalsPath,
    "-filter_complex",
    mixVoiceAndBgmFilterComplex(Number.parseFloat(durationSec)),
    "-map",
    "[mix]",
    "-t",
    durationSec,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    input.outputPath,
  ], input.signal);

  const actualMs = await probeAudioDurationMs({
    filePath: input.outputPath,
    runner: input.runner,
    ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  assertRenderedDurationMs({
    actualMs,
    expectedMs: input.durationMs,
    label: `mixed audio ${input.outputPath}`,
  });
};

/**
 * 把混合音轨接到画面上；`videoPadMs > 0` 时用 tpad 冻结末帧。
 * 成片时长由 `-t outputDurationMs` 锁定，故意不用 `-shortest`。
 */
export const muxDubbedVideo = async (input: {
  videoPath: string;
  audioPath: string;
  outputPath: string;
  videoPadMs: number;
  outputDurationMs: number;
  runner: ProcessRunner;
  ffmpegPath: string;
  ffprobePath?: string;
  signal?: AbortSignal;
}): Promise<void> => {
  await runFfmpeg(
    input.runner,
    input.ffmpegPath,
    buildMuxDubbedVideoArgs({
      videoPath: input.videoPath,
      audioPath: input.audioPath,
      outputPath: input.outputPath,
      videoPadMs: input.videoPadMs,
      outputDurationMs: input.outputDurationMs,
    }),
    input.signal,
  );

  const actualMs = await probeAudioDurationMs({
    filePath: input.outputPath,
    runner: input.runner,
    ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  assertRenderedDurationMs({
    actualMs,
    expectedMs: input.outputDurationMs,
    label: `muxed video ${input.outputPath}`,
  });
};

/**
 * 混音 + （按需）冻结帧，交出给双语烧录路径的中文音轨与视频输入——不再产出成片，
 * 也不再触碰字幕。见文件头注释。
 */
export const remixDubbedAudio = async (
  input: RemixDubbedAudioInput,
): Promise<RemixDubbedAudioResult> => {
  const runner = input.runner ?? defaultProcessRunner;
  const ffmpegPath = input.ffmpegPath ?? "ffmpeg";

  const workDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-dub-remix-"));
  const voiceTrackPath = path.join(input.dubDir, "voice.wav");
  const mixedAudioPath = path.join(input.dubDir, "mixed.m4a");
  await mkdir(input.dubDir, { recursive: true });

  try {
    const voiceEndMs = await buildVoiceTrack({
      placedLines: input.placedLines,
      dubDir: input.dubDir,
      outputPath: voiceTrackPath,
      runner,
      ffmpegPath,
      workDir,
      ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    const videoDurationMs = await probeAudioDurationMs({
      filePath: input.videoPath,
      runner,
      ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    const outputDurationMs = computeDubbedOutputDurationMs({
      voiceEndMs: Math.max(
        voiceEndMs,
        input.placedLines.length > 0 ? input.placedLines[input.placedLines.length - 1]!.endMs : 0,
      ),
      videoDurationMs,
      extendMs: Math.max(0, input.extendMs),
    });
    const videoPadMs = Math.max(0, outputDurationMs - videoDurationMs);

    await mixVoiceAndBgm({
      voicePath: voiceTrackPath,
      noVocalsPath: input.noVocalsPath,
      outputPath: mixedAudioPath,
      durationMs: outputDurationMs,
      runner,
      ffmpegPath,
      ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    if (videoPadMs > 0) {
      // 人声跑出了原片时长：必须现在就把画面冻结延长到位，下游的双语烧录只按视频
      // 输入自身的时长生成叠加帧序列，没有能力再延长画面。这一分支不可避免要多编码
      // 一次（mux 本身），但音轨已经在这一步就绑定正确——双语烧录那次调用不需要
      // 再传 replaceAudioPath，用它自带的 0:a 即可。
      const paddedPath = path.join(input.dubDir, "video-padded.mp4");
      await muxDubbedVideo({
        videoPath: input.videoPath,
        audioPath: mixedAudioPath,
        outputPath: paddedPath,
        videoPadMs,
        outputDurationMs,
        runner,
        ffmpegPath,
        ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      return {
        videoForBurnPath: paddedPath,
        voiceTrackPath,
        mixedAudioPath,
        outputDurationMs,
        videoPadMs,
        extendMs: Math.max(0, input.extendMs),
      };
    }

    // 常见情况：人声没有超出原片时长，画面完全不需要改动。原片原样交给双语烧录，
    // 音轨用 replaceAudioPath 在那一次 ffmpeg 调用里换掉——全程只编码一次。
    return {
      videoForBurnPath: input.videoPath,
      replaceAudioPath: mixedAudioPath,
      voiceTrackPath,
      mixedAudioPath,
      outputDurationMs,
      videoPadMs,
      extendMs: Math.max(0, input.extendMs),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};
