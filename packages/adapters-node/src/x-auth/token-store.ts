import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CredentialsFileV1, StoredCredentials } from "@yt2x/core";
import { withExclusiveLock } from "../fs/file-lock.js";

const TokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  tokenType: z.literal("bearer"),
  expiresAt: z.number().int(),
  scope: z.string(),
});

const UserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  name: z.string().min(1).optional(),
});

const StoredCredentialsSchema = z.object({
  provider: z.literal("x"),
  clientId: z.string().min(1),
  tokens: TokensSchema,
  user: UserSchema.optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const CredentialsFileSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string().min(1), StoredCredentialsSchema),
});

const DEFAULT_PROFILE = "default";
const CREDENTIALS_LOCK_FILE = ".credentials.lock";

export const defaultCredentialsPath = (): string =>
  path.join(homedir(), ".config", "yt2x", "credentials.json");

const ensureSecureDir = async (filePath: string): Promise<void> => {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // 部分文件系统不允许显式 chmod（如 windows），忽略
  }
};

const atomicWrite = async (filePath: string, contents: string): Promise<void> => {
  await ensureSecureDir(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, contents, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    // ignore non-POSIX systems
  }
  await rename(tmp, filePath);
  try {
    await chmod(filePath, 0o600);
  } catch {
    // ignore
  }
};

const emptyFile = (): CredentialsFileV1 => ({ version: 1, profiles: {} });

export type TokenStore = {
  readFile(): Promise<CredentialsFileV1>;
  read(profile?: string): Promise<StoredCredentials | null>;
  write(creds: StoredCredentials, profile?: string): Promise<void>;
  delete(profile?: string): Promise<void>;
  /** 全文件删除（一般供测试或 `yt2x auth logout --all` 用） */
  destroy(): Promise<void>;
};

export const createTokenStore = (filePath: string = defaultCredentialsPath()): TokenStore => {
  const lockDir = path.dirname(filePath);
  const withCredentialsLock = <T>(fn: () => Promise<T>): Promise<T> =>
    withExclusiveLock(lockDir, CREDENTIALS_LOCK_FILE, fn);

  const readRawFile = async (): Promise<CredentialsFileV1> => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyFile();
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`credentials file is not valid JSON: ${message}`);
    }
    // zod 推导的 optional 字段类型为 `T | undefined`，与 core 的
    // `exactOptionalPropertyTypes` 字段（缺席）在运行时同义但在 TS 静态层不互兼。
    // 这里只能做受控 cast；上方 schema 已校验所有必需字段。
    return CredentialsFileSchema.parse(parsed) as CredentialsFileV1;
  };

  const read = async (profile: string = DEFAULT_PROFILE): Promise<StoredCredentials | null> => {
    const file = await readRawFile();
    return file.profiles[profile] ?? null;
  };

  const write = async (creds: StoredCredentials, profile: string = DEFAULT_PROFILE): Promise<void> => {
    await withCredentialsLock(async () => {
      const file = await readRawFile();
      const now = Date.now();
      const existing = file.profiles[profile];
      file.profiles[profile] = {
        ...creds,
        createdAt: existing?.createdAt ?? creds.createdAt ?? now,
        updatedAt: now,
      };
      await atomicWrite(filePath, JSON.stringify(file, null, 2) + "\n");
    });
  };

  const deleteProfile = async (profile: string = DEFAULT_PROFILE): Promise<void> => {
    await withCredentialsLock(async () => {
      const file = await readRawFile();
      if (file.profiles[profile] === undefined) return;
      delete file.profiles[profile];
      await atomicWrite(filePath, JSON.stringify(file, null, 2) + "\n");
    });
  };

  const destroy = async (): Promise<void> => {
    try {
      await rm(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  };

  return {
    readFile: readRawFile,
    read,
    write,
    delete: deleteProfile,
    destroy,
  };
};
