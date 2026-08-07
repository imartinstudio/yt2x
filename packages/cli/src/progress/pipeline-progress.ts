import { performance } from "node:perf_hooks";
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

export type ProgressCommand = "notes" | "article" | "publish";

export type PipelineTimingsPayload = {
  command: ProgressCommand;
  timingsMs: Record<string, number>;
  timingsSec: Record<string, number>;
  totalMs: number;
  totalSec: number;
  stepCount: number;
};

export const buildPipelineTimingsPayload = (
  command: ProgressCommand,
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
  /** 更新当前步骤的细粒度进度：detail 追加在 label 后展示，fraction 替代时间估算的步内进度。 */
  setActiveDetail: (detail: string, fraction?: number) => void;
  record: (timingKey: string, durationMs: number, activeLabel?: string) => void;
  getTimingsPayload: () => PipelineTimingsPayload;
  clear: () => void;
  printSummary: () => void;
};

type ProgressHandleOptions = {
  totalUnits: number;
  command: ProgressCommand;
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
  let activeDetail = "";
  let activeFraction: number | undefined;
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
      if (activeFraction !== undefined) {
        // 子进程上报的真实步内进度优先于时间估算。
        units += Math.min(0.98, Math.max(0, activeFraction));
      } else {
        const elapsed = performance.now() - activeSinceMs;
        const inStep = Math.min(0.92, elapsed / ACTIVE_STEP_ESTIMATE_MS);
        units += inStep;
      }
    }
    return Math.min(100, (units / totalUnits) * 100);
  };

  const formatLine = (): string => {
    const pct = displayPercent();
    const bar = formatProgressBar(pct);
    const label = activeDetail.length > 0 ? `${activeLabel} · ${activeDetail}` : activeLabel;
    if (activeSinceMs > 0 && completedUnits < totalUnits) {
      const spin = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
      return `${bar} ${spin} ${label}`;
    }
    return `${bar} · ${label}`;
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
      activeDetail = "";
      activeFraction = undefined;
      activeSinceMs = performance.now();
      spinnerFrame = 0;
      startTicker();
      draw();
    },

    setActiveDetail(detail: string, fraction?: number) {
      activeDetail = detail;
      activeFraction = fraction;
      // 非 TTY 场景没有 ticker，直接重绘让百分比行推进。
      if (!useTty) {
        draw();
      }
    },

    record(timingKey: string, durationMs: number, activeLabelOverride?: string) {
      timings.set(timingKey, durationMs);
      completedUnits += 1;
      activeSinceMs = 0;
      activeDetail = "";
      activeFraction = undefined;
      if (activeLabelOverride !== undefined) {
        activeLabel = activeLabelOverride;
      }
      stopTicker();
      draw();
    },

    getTimingsPayload() {
      return buildPipelineTimingsPayload(command, timings, wallStart);
    },

    clear() {
      stopTicker();
      activeSinceMs = 0;
      clearProgressLine(useTty);
    },

    printSummary() {
      stopTicker();
      activeSinceMs = 0;
      const payload = buildPipelineTimingsPayload(command, timings, wallStart);
      clearProgressLine(useTty);
      const logMessage = `yt2x ${command}: stage timings`;
      logger.info(payload, logMessage);
      printHumanSummary(payload);
    },
  };
};

export const createCommandProgress = (
  command: ProgressCommand,
  totalUnits = 1,
): PipelineProgressHandle =>
  createProgressHandle({
    totalUnits: Math.max(1, totalUnits),
    command,
  });
