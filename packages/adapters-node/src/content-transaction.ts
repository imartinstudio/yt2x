import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename as fsRename,
  rm,
  symlink,
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

const safeTargetName = (target: string): string => target.replace(/[^a-zA-Z0-9._-]/g, "_");

export const contentTargetLockPathFor = (targetDir: string, target: string): string =>
  path.join(path.resolve(targetDir), ".content-locks", `${safeTargetName(target)}.lock`);

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
  const lockPath = contentTargetLockPathFor(targetDir, target);
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
        throw new Error(`Timed out acquiring content target lock for "${target}" under "${targetDir}"`);
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

const isInsideDirectory = (parentDir: string, childPath: string): boolean => {
  const relative = path.relative(parentDir, childPath);
  return relative !== ""
    && !relative.startsWith(".." + path.sep)
    && relative !== ".."
    && !path.isAbsolute(relative);
};

/**
 * 把 staged bundle 移入不可变版本目录，再以一次 rename 原子切换目标符号链接。
 * 既有实体目录会在目标锁内迁移成首个版本；失败时恢复旧目录。所有旧读取路径
 * 仍可通过 targetDir 透明访问当前 generation。
 */
export const replaceDirectoryAtomically = async (
  stagedDir: string,
  targetDir: string,
  options: { rename?: DirectoryRename } = {},
): Promise<void> => {
  const rename = options.rename ?? fsRename;
  const targetParent = path.dirname(targetDir);
  const targetName = path.basename(targetDir);
  const versionsDir = path.join(targetParent, "." + targetName + "-bundles");
  const generationDir = path.join(versionsDir, "generation-" + process.pid + "-" + randomUUID());
  const pointerPath = path.join(targetParent, "." + targetName + ".pointer-" + process.pid + "-" + randomUUID());
  const pointerTarget = path.relative(targetParent, generationDir);
  const targetEntry = await lstatIfExists(targetDir);
  const legacyDir = targetEntry !== undefined && !targetEntry.isSymbolicLink()
    ? path.join(versionsDir, "legacy-" + process.pid + "-" + randomUUID())
    : undefined;
  const previousGeneration = targetEntry?.isSymbolicLink() === true
    ? path.resolve(targetParent, await readlink(targetDir))
    : undefined;

  if (targetEntry !== undefined && !targetEntry.isDirectory() && !targetEntry.isSymbolicLink()) {
    throw new Error("Cannot replace content bundle at non-directory target \"" + targetDir + "\"");
  }

  await mkdir(versionsDir, { recursive: true });
  let stagedMoved = false;
  let legacyMoved = false;
  let pointerCommitted = false;
  try {
    await rename(stagedDir, generationDir);
    stagedMoved = true;
    await symlink(pointerTarget, pointerPath, "dir");

    if (legacyDir !== undefined) {
      await rename(targetDir, legacyDir);
      legacyMoved = true;
    }

    try {
      await rename(pointerPath, targetDir);
      pointerCommitted = true;
    } catch (err: unknown) {
      if (legacyMoved && legacyDir !== undefined) {
        try {
          await rename(legacyDir, targetDir);
          legacyMoved = false;
        } catch (restoreError: unknown) {
          throw new AggregateError(
            [err, restoreError],
            "Content bundle commit and rollback both failed for \"" + targetDir + "\"",
          );
        }
      }
      throw err;
    }

    const obsoleteGeneration = legacyDir ?? previousGeneration;
    if (obsoleteGeneration !== undefined
      && obsoleteGeneration !== generationDir
      && isInsideDirectory(versionsDir, obsoleteGeneration)) {
      await rm(obsoleteGeneration, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await rm(pointerPath, { force: true }).catch(() => {});
    if (!pointerCommitted && stagedMoved) {
      await rm(generationDir, { recursive: true, force: true }).catch(() => {});
    }
    if (!stagedMoved) {
      await rm(stagedDir, { recursive: true, force: true }).catch(() => {});
    }
    if (!pointerCommitted && legacyMoved && legacyDir !== undefined) {
      await rename(legacyDir, targetDir).catch(() => {});
    }
  }
};
