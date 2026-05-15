import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

const LOCK_TTL_MS = 120_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

const tryAcquireLock = async (lockPath: string): Promise<FileHandle | null> => {
  try {
    const fh = await open(lockPath, "wx");
    await fh.writeFile(`${String(process.pid)}\n${String(Date.now())}\n`);
    return fh;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  const content = await readLockContent(lockPath);
  if (content !== null) {
    const age = Date.now() - content.ts;
    if (age > LOCK_TTL_MS && !isProcessAlive(content.pid)) {
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
 * 在 `lockDir` 下用 `lockFileName` 串行化临界区（credentials、process-status 等）。
 */
export const withExclusiveLock = async <T>(
  lockDir: string,
  lockFileName: string,
  fn: () => Promise<T>,
): Promise<T> => {
  await mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, lockFileName);
  let fh: FileHandle | null = null;
  for (let i = 0; i < 240; i += 1) {
    fh = await tryAcquireLock(lockPath);
    if (fh !== null) break;
    await sleep(20 + Math.min(i, 40) * 5);
  }
  if (fh === null) {
    throw new Error(`Timed out waiting for lock "${lockPath}"`);
  }
  try {
    return await fn();
  } finally {
    await fh.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
};
