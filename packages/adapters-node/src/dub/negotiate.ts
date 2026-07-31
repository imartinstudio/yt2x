import {
  buildDubShortenRepairPrompt,
  buildDubShortenUserPrompt,
  getDubShortenSystemPrompt,
  type DubNegotiateLinePlan,
  type DubNegotiatePlan,
  type DubPlacedLine,
  type DubPlacementReport,
  type LlmPort,
  type TtsPort,
} from "@yt2x/core";
import { parseJsonWithRepairs, salvagePartialJsonArray } from "../llm/parse-json.js";
import type { ProcessRunner } from "../process/index.js";
import { synthesizeDubLine } from "./synthesize.js";

/**
 * 执行时长协商计划：按需调速重合成 / LLM 改短 / 顺延，产出最终落点。
 *
 * keep 行直接复用 PR1 的 lines/*.mp3；speed / shorten 会覆盖同名文件。
 * shorten 失败或改短后仍装不下时降为 delay，保证整条链总能跑完。
 * 凡重合成一律走 `synthesizeDubLine`（含首尾静音裁剪），与初次合成同缝。
 */

const FIT_SLACK_MS = 50;
const MIN_GAP_KEEP_MS = 80;
const SHORTEN_BATCH_SIZE = 10;
/** 改短后仍略超时，允许再加速到这个上限（与偏好上限一致）。 */
const PREFERRED_RETRY_RATE = 1.15;

export type ApplyDubNegotiationInput = {
  plan: DubNegotiatePlan;
  tts: TtsPort;
  voice: string;
  dubDir: string;
  /** keep/delay 行已有的相对路径（来自 timing 报告）。 */
  existingAudioByIndex: ReadonlyMap<number, string>;
  llm?: LlmPort;
  model?: string;
  runner?: ProcessRunner;
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
  onLineDone?: (done: number, total: number) => void;
};

export type ApplyDubNegotiationResult = {
  report: DubPlacementReport;
  warnings: string[];
};

type ShortenedLine = { index: number; text: string };

const parseShortenResponse = (content: string): ShortenedLine[] => {
  let parsed: unknown;
  try {
    parsed = parseJsonWithRepairs(content);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) parsed = salvagePartialJsonArray(content);
  if (!Array.isArray(parsed)) return [];

  const lines: ShortenedLine[] = [];
  for (const item of parsed) {
    const obj = item as Record<string, unknown>;
    if (typeof obj.index === "number" && typeof obj.text === "string") {
      const text = obj.text.trim();
      if (text.length > 0) lines.push({ index: obj.index, text });
    }
  }
  return lines;
};

const shortenBatch = async (
  batch: readonly DubNegotiateLinePlan[],
  llm: LlmPort,
  model: string,
  repairMode: boolean,
  signal?: AbortSignal,
): Promise<ShortenedLine[]> => {
  const items = batch.map((line) => ({
    index: line.index,
    text: line.text,
    maxChars: line.shortenMaxChars ?? Math.max(4, Math.floor(line.text.length * 0.7)),
  }));
  const systemPrompt = repairMode
    ? buildDubShortenRepairPrompt(batch.map((l) => l.index))
    : getDubShortenSystemPrompt();

  const resp = await llm.chat({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildDubShortenUserPrompt(items) },
    ],
    temperature: 0.2,
    maxTokens: 4096,
    jsonMode: true,
    ...(signal !== undefined ? { signal } : {}),
  });

  const known = new Set(batch.map((l) => l.index));
  return parseShortenResponse(resp.content.trim()).filter((line) => known.has(line.index));
};

const shortenTexts = async (
  plans: readonly DubNegotiateLinePlan[],
  llm: LlmPort,
  model: string,
  signal: AbortSignal | undefined,
  warnings: string[],
): Promise<Map<number, string>> => {
  const rewritten = new Map<number, string>();
  for (let i = 0; i < plans.length; i += SHORTEN_BATCH_SIZE) {
    const batch = plans.slice(i, i + SHORTEN_BATCH_SIZE);
    let got = await shortenBatch(batch, llm, model, false, signal);
    const missing = batch.filter((l) => !got.some((g) => g.index === l.index));
    if (missing.length > 0) {
      const repaired = await shortenBatch(missing, llm, model, true, signal);
      got = [...got, ...repaired];
    }
    for (const line of got) {
      const plan = batch.find((p) => p.index === line.index);
      const maxChars = plan?.shortenMaxChars;
      if (maxChars !== undefined && [...line.text].length > maxChars) {
        // 超预算的改写不算数——用原文走 delay 比念一段仍然太长的"改短"强
        warnings.push(
          `line ${line.index}: shorten exceeded maxChars ${maxChars} (got ${[...line.text].length}); will delay`,
        );
        continue;
      }
      rewritten.set(line.index, line.text);
    }
    for (const plan of batch) {
      if (!rewritten.has(plan.index)) {
        warnings.push(`line ${plan.index}: shorten failed; will delay with original text`);
      }
    }
  }
  return rewritten;
};

const synthesizeLine = async (
  input: ApplyDubNegotiationInput,
  text: string,
  rate: number,
  index: number,
): Promise<{ durationMs: number; audioFile: string }> => {
  const synth = await synthesizeDubLine({
    tts: input.tts,
    text,
    voice: input.voice,
    rate,
    index,
    dubDir: input.dubDir,
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    ...(input.ffmpegPath !== undefined ? { ffmpegPath: input.ffmpegPath } : {}),
    ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  return { durationMs: synth.durationMs, audioFile: synth.audioFile };
};

export const applyDubNegotiation = async (
  input: ApplyDubNegotiationInput,
): Promise<ApplyDubNegotiationResult> => {
  const warnings: string[] = [];

  const shortenPlans = input.plan.lines.filter((l) => l.action === "shorten");
  let shortened = new Map<number, string>();
  if (shortenPlans.length > 0) {
    if (input.llm === undefined || input.model === undefined) {
      warnings.push("shorten planned but no LLM provided; those lines will delay");
    } else {
      shortened = await shortenTexts(
        shortenPlans,
        input.llm,
        input.model,
        input.signal,
        warnings,
      );
    }
  }

  const placed: DubPlacedLine[] = [];
  let drift = 0;
  let keepCount = 0;
  let speedCount = 0;
  let shortenCount = 0;
  let delayCount = 0;
  const total = input.plan.lines.length;

  for (let i = 0; i < input.plan.lines.length; i += 1) {
    const plan = input.plan.lines[i]!;
    const startMs = plan.originalStartMs + drift;
    let action = plan.action;
    let text = plan.text;
    let rate = plan.rate;
    let durationMs: number;
    let audioFile: string;

    if (action === "keep" || action === "delay") {
      const existing = input.existingAudioByIndex.get(plan.index);
      if (existing === undefined) {
        // 缺文件时重合成，避免整条链断掉
        const synth = await synthesizeLine(input, text, 1, plan.index);
        durationMs = synth.durationMs;
        audioFile = synth.audioFile;
        warnings.push(`line ${plan.index}: missing audio, re-synthesized at rate 1.0`);
      } else {
        durationMs = plan.naturalMs;
        audioFile = existing;
      }
      if (action === "keep") keepCount += 1;
      else delayCount += 1;
    } else if (action === "speed") {
      const synth = await synthesizeLine(input, text, rate, plan.index);
      durationMs = synth.durationMs;
      audioFile = synth.audioFile;
      // 调速后仍明显溢出 → 当 delay 处理漂移
      if (durationMs > plan.targetDurationMs + FIT_SLACK_MS) {
        warnings.push(
          `line ${plan.index}: speed rate ${rate.toFixed(3)} still overflowed (${durationMs}ms > ${plan.targetDurationMs}ms)`,
        );
        action = "delay";
        delayCount += 1;
      } else {
        speedCount += 1;
      }
    } else {
      // shorten
      const shortText = shortened.get(plan.index);
      if (shortText === undefined) {
        const existing = input.existingAudioByIndex.get(plan.index);
        if (existing === undefined) {
          const synth = await synthesizeLine(input, text, 1, plan.index);
          durationMs = synth.durationMs;
          audioFile = synth.audioFile;
        } else {
          durationMs = plan.naturalMs;
          audioFile = existing;
        }
        action = "delay";
        delayCount += 1;
      } else {
        text = shortText;
        const synth = await synthesizeLine(input, text, 1, plan.index);
        durationMs = synth.durationMs;
        audioFile = synth.audioFile;
        if (durationMs > plan.targetDurationMs + FIT_SLACK_MS) {
          // 改短后仍装不下：再试一次温和加速
          const needed = durationMs / plan.targetDurationMs;
          const maxRate = input.tts.rateRange.max;
          if (needed <= Math.min(PREFERRED_RETRY_RATE, maxRate)) {
            const sped = await synthesizeLine(input, text, needed, plan.index);
            durationMs = sped.durationMs;
            audioFile = sped.audioFile;
            rate = needed;
            if (durationMs <= plan.targetDurationMs + FIT_SLACK_MS) {
              action = "speed";
              speedCount += 1;
            } else {
              action = "delay";
              delayCount += 1;
              warnings.push(`line ${plan.index}: shorten+speed still overflowed; delaying`);
            }
          } else {
            action = "delay";
            delayCount += 1;
            warnings.push(`line ${plan.index}: shorten still overflowed; delaying`);
          }
        } else {
          shortenCount += 1;
        }
      }
    }

    const endMs = startMs + durationMs;
    placed.push({
      index: plan.index,
      action,
      rate,
      text,
      startMs,
      endMs,
      durationMs,
      audioFile,
    });

    const overflow = durationMs - plan.targetDurationMs;
    drift = Math.max(0, drift + overflow);

    const next = input.plan.lines[i + 1];
    if (next !== undefined) {
      const gap = next.originalStartMs - plan.originalEndMs;
      const absorbable = Math.max(0, gap - MIN_GAP_KEEP_MS);
      drift = Math.max(0, drift - absorbable);
    }

    input.onLineDone?.(i + 1, total);
  }

  const audioEndMs = placed.length > 0 ? placed[placed.length - 1]!.endMs : 0;
  const report: DubPlacementReport = {
    version: 1,
    videoId: input.plan.videoId,
    engine: input.tts.id,
    voice: input.voice,
    lines: placed,
    extendMs: Math.round(drift),
    audioEndMs,
    speedCount,
    shortenCount,
    delayCount,
    keepCount,
  };

  return { report, warnings };
};
