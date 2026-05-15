import { performance } from "node:perf_hooks";
import { parseSearchQuery } from "@yt2x/adapters-node";
import type { PipelineArgs } from "../args/pipeline.js";
import { logger } from "../logger.js";

const BAR_WIDTH = 28;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
/** 当前步骤无更细进度时，用时间推动条内「半步」动画（上限为一步的 92%） */
const ACTIVE_STEP_ESTIMATE_MS = 18_000;
const TICK_MS = 120;

export const formatProgressBar = (percent: number, width = BAR_WIDTH): string => {
  const pct = Math.max(0, Math.min(100, percent));
  const filled = Math.round((pct / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.round(pct)}%`;
};

/** 估算 pipeline 进度总步数用的视频数（URL 列表 / search:N / 已有目录）。 */
export const estimatePipelineVideoCount = (
  args: PipelineArgs,
  knownFromDisk = 0,
): number => {
  if (knownFromDisk > 0) {
    return knownFromDisk;
  }
  if (args.sources.urls.length > 0) {
    return args.sources.urls.length;
  }
  if (args.sources.search !== undefined) {
    return parseSearchQuery(args.sources.search).count;
  }
  return 1;
};

export const countPipelineProgressUnits = (args: PipelineArgs, videoCount: number): number => {
  const n = Math.max(1, videoCount);
  let total = 0;

  const runAcquire = args.stages.acquire !== "skip" && !args.control.continueFlag;
  if (runAcquire) {
    const subSteps = args.acquire.keyframes > 0 ? 5 : 4;
    total += subSteps * n;
  }
  if (args.stages.notes !== "skip") {
    total += n;
  }
  if (args.stages.article !== "skip") {
    total += n;
  }
  if (args.stages.publish !== "skip") {
    total += n;
  }
  return total;
};

export type PipelineTimingsPayload = {
  command: "pipeline" | "acquire";
  timingsMs: Record<string, number>;
  timingsSec: Record<string, number>;
  totalMs: number;
  totalSec: number;
  stepCount: number;
};

export const buildPipelineTimingsPayload = (
  command: PipelineTimingsPayload["command"],
  timings: Map<string, number>,
  wallStartMs: number,
): PipelineTimingsPayload => {
  const timingsMs: Record<string, number> = {};
  const timingsSec: Record<string, number> = {};
  for (const [key, ms] of [...timings.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    timingsMs[key] = ms;
    timingsSec[key] = Math.round((ms / 1000) * 10) / 10;
  }
  const totalMs = Math.round(performance.now() - wallStartMs);
  return {
    command,
    timingsMs,
    timingsSec,
    totalMs,
    totalSec: Math.round((totalMs / 1000) * 10) / 10,
    stepCount: timings.size,
  };
};

export type PipelineProgressHandle = {
  setActive: (label: string) => void;
  record: (timingKey: string, durationMs: number, activeLabel?: string) => void;
  getTimingsPayload: () => PipelineTimingsPayload;
  printSummary: () => void;
};

type ProgressHandleOptions = {
  totalUnits: number;
  command: PipelineTimingsPayload["command"];
};

const clearProgressLine = (useTty: boolean): void => {
  if (useTty) {
    process.stderr.write("\r\x1b[2K");
  }
};

const createProgressHandle = (opts: ProgressHandleOptions): PipelineProgressHandle => {
  const { totalUnits, command } = opts;
  const useTty = process.stderr.isTTY === true;
  let completedUnits = 0;
  const timings = new Map<string, number>();
  let activeLabel = "";
  let activeSinceMs = 0;
  let spinnerFrame = 0;
  let lastPrintedPct = -1;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const wallStart = performance.now();

  const displayPercent = (): number => {
    if (totalUnits <= 0) {
      return 100;
    }
    let units = completedUnits;
    if (activeSinceMs > 0 && completedUnits < totalUnits) {
      const elapsed = performance.now() - activeSinceMs;
      const inStep = Math.min(0.92, elapsed / ACTIVE_STEP_ESTIMATE_MS);
      units += inStep;
    }
    return Math.min(100, (units / totalUnits) * 100);
  };

  const formatLine = (): string => {
    const pct = displayPercent();
    const bar = formatProgressBar(pct);
    if (activeSinceMs > 0 && completedUnits < totalUnits) {
      const spin = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
      return `${bar} ${spin} ${activeLabel}`;
    }
    return `${bar} · ${activeLabel}`;
  };

  const stopTicker = (): void => {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  const startTicker = (): void => {
    stopTicker();
    if (!useTty) {
      return;
    }
    ticker = setInterval(() => {
      spinnerFrame += 1;
      draw();
    }, TICK_MS);
  };

  const draw = (): void => {
    const line = formatLine();
    if (useTty) {
      process.stderr.write(`\r\x1b[2K${line}`);
      return;
    }
    const pctRounded = Math.floor(displayPercent());
    if (pctRounded !== lastPrintedPct) {
      lastPrintedPct = pctRounded;
      process.stderr.write(`${line}\n`);
    }
  };

  const printHumanSummary = (payload: PipelineTimingsPayload): void => {
    console.log("\n耗时统计（秒）");
    for (const [key, sec] of Object.entries(payload.timingsSec)) {
      console.log(`  ${key}: ${sec.toFixed(1)}`);
    }
    console.log(`  总计: ${payload.totalSec.toFixed(1)}`);
  };

  return {
    setActive(label: string) {
      activeLabel = label;
      activeSinceMs = performance.now();
      spinnerFrame = 0;
      startTicker();
      draw();
    },

    record(timingKey: string, durationMs: number, activeLabelOverride?: string) {
      timings.set(timingKey, durationMs);
      completedUnits += 1;
      activeSinceMs = 0;
      if (activeLabelOverride !== undefined) {
        activeLabel = activeLabelOverride;
      }
      stopTicker();
      draw();
    },

    getTimingsPayload() {
      return buildPipelineTimingsPayload(command, timings, wallStart);
    },

    printSummary() {
      stopTicker();
      activeSinceMs = 0;
      const payload = buildPipelineTimingsPayload(command, timings, wallStart);
      clearProgressLine(useTty);
      const logMessage =
        command === "pipeline" ? "yt2x pipeline: stage timings" : "yt2x acquire: stage timings";
      logger.info(payload, logMessage);
      printHumanSummary(payload);
    },
  };
};

export const createPipelineProgress = (
  args: PipelineArgs,
  videoCount: number,
): PipelineProgressHandle =>
  createProgressHandle({
    totalUnits: countPipelineProgressUnits(args, videoCount),
    command: "pipeline",
  });

export const acquireSubStepProgressFromHandle = (
  handle: PipelineProgressHandle,
  labelPrefix: string,
): {
  onSubStepStart: (videoId: string, stepKey: string) => void;
  onSubStepEnd: (videoId: string, stepKey: string, durationMs: number) => void;
} => ({
  onSubStepStart: (videoId, stepKey) => {
    handle.setActive(`${labelPrefix} · ${stepKey} · ${videoId}`);
  },
  onSubStepEnd: (videoId, stepKey, durationMs) => {
    handle.record(`${labelPrefix}.${videoId}.${stepKey}`, durationMs);
  },
});

/** 单命令 `yt2x acquire` 的子步骤数（每视频）。 */
export const countAcquireSubSteps = (keyframes: number): number => (keyframes > 0 ? 5 : 4);

export const createAcquireOnlyProgress = (
  videoCount: number,
  keyframes: number,
): PipelineProgressHandle =>
  createProgressHandle({
    totalUnits: countAcquireSubSteps(keyframes) * Math.max(1, videoCount),
    command: "acquire",
  });
