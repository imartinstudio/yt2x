import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import {
  ProcessStatusJournalLineSchema,
  type PipelineStep,
  type ProcessStatusJournalLine,
  type ProcessStatusV1,
  type StepInfo,
  applyJournalLines,
  createInitialProcessStatus,
  normalizeProcessStatusJson,
} from "@yt2x/core";
import { sanitizeVideoId } from "../acquire/video-id-from-url.js";

export const PROCESS_STATUS_FILE = "process-status.json";
export const PROCESS_STATUS_JOURNAL = "process-status.journal.ndjson";
const LOCK_FILE = ".process-status.lock";
/** 锁文件 TTL（毫秒）。超过此时间视为孤儿锁，允许抢占。 */
const LOCK_TTL_MS = 120_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 检查 PID 对应的进程是否仍然存活。
 */
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * 读取孤儿锁文件的内容，返回写入时的 PID 和时间戳。
 * 格式：`<pid>\n<epoch_ms>`
 */
const readLockContent = async (lockPath: string): Promise<{ pid: number; ts: number } | null> => {
  try {
    const raw = await readFile(lockPath, "utf8");
    const lines = raw.trim().split("\n");
    const pid = Number.parseInt(lines[0] ?? "", 10);
    const ts = Number.parseInt(lines[1] ?? "", 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ts)) return null;
    return { pid, ts };
  } catch {
    return null;
  }
};

const tryAcquireLock = async (videoDir: string): Promise<FileHandle | null> => {
  const lockPath = path.join(videoDir, LOCK_FILE);
  try {
    const fh = await open(lockPath, "wx");
    // 写入 PID + 时间戳，供后续孤儿锁检测
    await fh.writeFile(`${String(process.pid)}\n${String(Date.now())}\n`);
    return fh;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  // 锁已存在：检查是否为孤儿锁
  const content = await readLockContent(lockPath);
  if (content !== null) {
    const age = Date.now() - content.ts;
    if (age > LOCK_TTL_MS && !isProcessAlive(content.pid)) {
      // 孤儿锁：超过 TTL 且原进程已不存在，抢占
      await unlink(lockPath).catch(() => {});
      try {
        const fh = await open(lockPath, "wx");
        await fh.writeFile(`${String(process.pid)}\n${String(Date.now())}\n`);
        return fh;
      } catch {
        return null;
      }
    }
  }

  return null;
};

/**
 * 对单个视频目录的 `process-status` 更新串行化，避免并发写损坏 JSON。
 */
export const withProcessStatusLock = async <T>(videoDir: string, fn: () => Promise<T>): Promise<T> => {
  await mkdir(videoDir, { recursive: true });
  const lockPath = path.join(videoDir, LOCK_FILE);
  let fh: FileHandle | null = null;
  for (let i = 0; i < 240; i += 1) {
    fh = await tryAcquireLock(videoDir);
    if (fh !== null) break;
    await sleep(20 + Math.min(i, 40) * 5);
  }
  if (fh === null) {
    throw new Error(`Timed out waiting for process-status lock under "${videoDir}"`);
  }
  try {
    return await fn();
  } finally {
    await fh.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
};

const safeReadUtf8 = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

const parseJournalLines = (raw: string): ProcessStatusJournalLine[] => {
  const out: ProcessStatusJournalLine[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t) as unknown;
    } catch {
      continue;
    }
    const row = ProcessStatusJournalLineSchema.safeParse(parsed);
    if (row.success) out.push(row.data);
  }
  return out;
};

/**
 * 读取合并后的状态：主 JSON + 未压缩的 NDJSON 日志（用于崩溃恢复）。
 */
export const readProcessStatusMerged = async (
  videoDir: string,
  identity: { videoId: string; url: string },
): Promise<ProcessStatusV1 | null> => {
  const statusPath = path.join(videoDir, PROCESS_STATUS_FILE);
  const journalPath = path.join(videoDir, PROCESS_STATUS_JOURNAL);

  const [jsonRaw, journalRaw] = await Promise.all([safeReadUtf8(statusPath), safeReadUtf8(journalPath)]);

  if (jsonRaw === null && (journalRaw === null || journalRaw.trim() === "")) {
    return null;
  }

  let base: ProcessStatusV1;
  if (jsonRaw === null || jsonRaw.trim() === "") {
    base = createInitialProcessStatus(identity);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonRaw) as unknown;
    } catch {
      console.warn(`process-status.json in "${videoDir}" is corrupted JSON — falling back to initial state`);
      base = createInitialProcessStatus(identity);
      const lines = journalRaw !== null ? parseJournalLines(journalRaw) : [];
      return lines.length > 0 ? applyJournalLines(base, lines) : base;
    }
    base = normalizeProcessStatusJson(parsed, identity);
  }

  const lines = journalRaw !== null ? parseJournalLines(journalRaw) : [];
  return lines.length > 0 ? applyJournalLines(base, lines) : base;
};

const atomicWriteText = async (targetPath: string, body: string): Promise<void> => {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, body, "utf8");
  await rename(tmp, targetPath);
};

/**
 * 在锁内：合并当前状态 → 应用补丁 → NDJSON 追加 → 原子写 JSON → 清空 journal。
 */
export const patchProcessStatus = async (
  videoDir: string,
  identity: { videoId: string; url: string },
  patch: {
    step: PipelineStep;
    stepInfo: StepInfo;
    threadUrl?: string;
    articleOutDir?: string;
  },
): Promise<void> => {
  await withProcessStatusLock(videoDir, async () => {
    const prev = await readProcessStatusMerged(videoDir, identity);
    const base = prev ?? createInitialProcessStatus(identity);
    const now = new Date().toISOString();
    const next: ProcessStatusV1 = {
      ...base,
      videoId: identity.videoId,
      url: identity.url,
      updatedAt: now,
      steps: {
        ...base.steps,
        [patch.step]: patch.stepInfo,
      },
      ...(patch.threadUrl !== undefined ? { threadUrl: patch.threadUrl } : {}),
      ...(patch.articleOutDir !== undefined ? { articleOutDir: patch.articleOutDir } : {}),
    };

    const journalLine = {
      v: 1 as const,
      ts: now,
      step: patch.step,
      stepInfo: patch.stepInfo,
      ...(patch.threadUrl !== undefined ? { threadUrl: patch.threadUrl } : {}),
      ...(patch.articleOutDir !== undefined ? { articleOutDir: patch.articleOutDir } : {}),
    };

    const journalPath = path.join(videoDir, PROCESS_STATUS_JOURNAL);
    await appendFile(journalPath, `${JSON.stringify(journalLine)}\n`, "utf8");

    const statusPath = path.join(videoDir, PROCESS_STATUS_FILE);
    await atomicWriteText(statusPath, `${JSON.stringify(next, null, 2)}\n`);

    await atomicWriteText(journalPath, "");
  });
};

/**
 * 标记某 pipeline 步骤进入 **running**（长时间 IO / LLM / 发帖前调用）。
 * 成功或失败时应再调 `patchProcessStatus` 写入 `done` / `failed` 覆盖本状态。
 */
export const patchStepRunning = async (
  videoDir: string,
  identity: { videoId: string; url: string },
  step: PipelineStep,
  options?: { articleOutDir?: string; threadUrl?: string },
): Promise<void> => {
  const startedAt = new Date().toISOString();
  await patchProcessStatus(videoDir, identity, {
    step,
    stepInfo: {
      status: "running",
      startedAt,
      artifacts: [],
    },
    ...(options?.articleOutDir !== undefined ? { articleOutDir: options.articleOutDir } : {}),
    ...(options?.threadUrl !== undefined ? { threadUrl: options.threadUrl } : {}),
  });
};

/** 从目录名 + `metadata.json` 解析 `process-status` 写入所需的 videoId / url。 */
export const videoProcessIdentity = async (videoDir: string): Promise<{ videoId: string; url: string }> => {
  const videoId = sanitizeVideoId(path.basename(videoDir));
  const url = await readYoutubePageUrl(videoDir, videoId);
  return { videoId, url };
};

/** 某步骤是否已成功完成（`status === "done"`）。 */
export const isStepDone = async (videoDir: string, step: PipelineStep): Promise<boolean> => {
  const identity = await videoProcessIdentity(videoDir);
  const merged = await readProcessStatusMerged(videoDir, identity);
  if (merged === null) return false;
  return merged.steps[step]?.status === "done";
};

/** 标记步骤 **done**（带锁写入 `process-status.json`）。 */
export const markStepDone = async (
  videoDir: string,
  step: PipelineStep,
  artifacts: string[] = [],
): Promise<void> => {
  const identity = await videoProcessIdentity(videoDir);
  const finishedAt = new Date().toISOString();
  await patchProcessStatus(videoDir, identity, {
    step,
    stepInfo: {
      status: "done",
      finishedAt,
      artifacts,
    },
  });
};

/** 标记步骤 **failed**（带锁写入 `process-status.json`）。 */
export const markStepFailed = async (videoDir: string, step: PipelineStep, error: string): Promise<void> => {
  const identity = await videoProcessIdentity(videoDir);
  await patchProcessStatus(videoDir, identity, {
    step,
    stepInfo: {
      status: "failed",
      finishedAt: new Date().toISOString(),
      artifacts: [],
      error: { code: "E_UNKNOWN", message: error },
    },
  });
};

/**
 * 从 `metadata.json` 读取 `webpage_url`，缺失时退回 watch URL。
 */
export const readYoutubePageUrl = async (videoDir: string, videoId: string): Promise<string> => {
  const raw = await safeReadUtf8(path.join(videoDir, "metadata.json"));
  if (raw === null || raw.trim() === "") {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }
  try {
    const meta = JSON.parse(raw) as { webpage_url?: string };
    if (typeof meta.webpage_url === "string" && meta.webpage_url.length > 0) return meta.webpage_url;
  } catch {
    // ignore
  }
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
};
