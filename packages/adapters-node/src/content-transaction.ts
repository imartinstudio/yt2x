import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename as fsRename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export type ContentTargetLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
};

type LockOwner = {
  token: string;
  pid: number;
  createdAt: number;
  expiresAt: number;
};

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_MS = 120_000;
const DEFAULT_LOCK_POLL_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 仅做词法解析的锁路径，用于展示和同一 root 的命名空间断言。
 * 真正取锁必须走 {@link canonicalContentTargetLockPathFor}。
 */
export const contentTargetLockPathFor = (targetDir: string, _target: string): string =>
  path.join(path.resolve(targetDir), ".content-locks", "bundle.lock");

/**
 * 把路径解析成不受符号链接别名影响的规范身份：
 * 已存在的部分用 realpath，未创建的部分作为后缀原样拼回。
 */
export const canonicalContentTargetPath = async (targetDir: string): Promise<string> => {
  const resolved = path.resolve(targetDir);
  const suffix: string[] = [];
  let current = resolved;
  while (true) {
    try {
      const real = await realpath(current);
      return suffix.length === 0 ? real : path.join(real, ...[...suffix].reverse());
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    suffix.push(path.basename(current));
    current = parent;
  }
};

/** 锁身份：符号链接别名与真实路径必须得到同一把锁。 */
export const canonicalContentTargetLockPathFor = async (
  targetDir: string,
  _target: string,
): Promise<string> =>
  path.join(await canonicalContentTargetPath(targetDir), ".content-locks", "bundle.lock");

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readOwner = async (lockPath: string): Promise<LockOwner | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Partial<LockOwner>;
    if (typeof record.token !== "string"
      || typeof record.pid !== "number"
      || typeof record.createdAt !== "number"
      || typeof record.expiresAt !== "number") return undefined;
    return record as LockOwner;
  } catch {
    return undefined;
  }
};

const canTakeOver = (owner: LockOwner | undefined, staleMs: number): boolean => {
  if (owner === undefined) return false;
  const expired = owner.expiresAt <= Date.now();
  const oldEnough = Date.now() - owner.createdAt >= staleMs;
  return expired && oldEnough && !isProcessAlive(owner.pid);
};

/**
 * 获取一个跨进程的内容目标锁。锁是带 PID、token 和租约时间的目录，
 * 进程异常退出后只允许在租约过期且持有进程已不存在时回收。
 */
export const acquireContentTargetLock = async (
  targetDir: string,
  target: string,
  options: ContentTargetLockOptions = {},
): Promise<() => Promise<void>> => {
  const lockPath = await canonicalContentTargetLockPathFor(targetDir, target);
  const parentDir = path.dirname(lockPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const startedAt = Date.now();

  await mkdir(parentDir, { recursive: true });
  while (true) {
    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
      expiresAt: Date.now() + Math.max(staleMs, DEFAULT_LOCK_STALE_MS),
    };
    try {
      await mkdir(lockPath);
      try {
        await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
      } catch (err: unknown) {
        await rm(lockPath, { recursive: true, force: true });
        throw err;
      }
      return async () => {
        const current = await readOwner(lockPath);
        if (current?.token === owner.token) {
          await rm(lockPath, { recursive: true, force: true });
        }
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (canTakeOver(await readOwner(lockPath), staleMs)) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out acquiring content target lock for "${target}" under "${targetDir}"`, { cause: err });
      }
      await sleep(pollMs);
    }
  }
};

export const withContentTargetLock = async <T>(
  targetDir: string,
  target: string,
  fn: () => Promise<T>,
  options: ContentTargetLockOptions = {},
): Promise<T> => {
  const release = await acquireContentTargetLock(targetDir, target, options);
  try {
    return await fn();
  } finally {
    await release();
  }
};

/** 用随机临时文件名写入并 rename，失败时清理临时文件。 */
export const atomicWriteUtf8 = async (targetPath: string, body: string): Promise<void> => {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, body, "utf8");
    await fsRename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
};

export type DirectoryRename = (from: string, to: string) => Promise<void>;

const lstatIfExists = async (filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> => {
  try {
    return await lstat(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
};

/**
 * 把 staged bundle 一次性换入 targetDir：先把旧目录挪到临时备份名，再把 staged
 * 改名成 targetDir，最后删掉备份。任一步失败都会把备份挪回原位，不会留下半成品。
 *
 * 换入过程中 targetDir 有一个两次 rename 之间的极短不存在窗口。yt2x 是单用户本地
 * CLI：所有写入方都在同一把 target 锁内串行，读取方是命令结束之后的人或脚本，
 * 因此不为这个窗口做进一步处理。曾经用「符号链接 root」和「不可变版本目录 +
 * 原子指针 + 硬链接铺回 + 有界 GC」来消除它，引入的复杂度和缺陷远超收益。
 */
export const replaceDirectoryAtomically = async (
  stagedDir: string,
  targetDir: string,
  options: { rename?: DirectoryRename } = {},
): Promise<void> => {
  const rename = options.rename ?? fsRename;
  const root = path.resolve(targetDir);
  const existing = await lstatIfExists(root);
  if (existing !== undefined && !existing.isDirectory()) {
    throw new Error(`Cannot replace content bundle at non-directory target "${root}"`);
  }
  const backupDir = path.join(
    path.dirname(root),
    `.${path.basename(root)}.previous-${process.pid}-${randomUUID()}`,
  );

  await mkdir(path.dirname(root), { recursive: true });
  let backedUp = false;
  let committed = false;
  try {
    if (existing !== undefined) {
      await rename(root, backupDir);
      backedUp = true;
    }
    await rename(stagedDir, root);
    committed = true;
  } finally {
    if (committed) {
      if (backedUp) await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    } else {
      await rm(stagedDir, { recursive: true, force: true }).catch(() => {});
      if (backedUp) await rename(backupDir, root).catch(() => {});
    }
  }
};
