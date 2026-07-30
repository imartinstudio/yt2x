import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultProcessRunner, isProcessError, type ProcessRunner } from "../process/index.js";

/**
 * Demucs 人声分离。
 *
 * 探测必须硬失败、且前置于任何计费调用——缺 Demucs 却默默交出无 BGM 成片，
 * 比开跑前报错更糟。实际分离走同目录的 demucs-separate.py。
 */

export const DEMUCS_NO_VOCALS_FILE = "no_vocals.wav";
export const DEMUCS_VOCALS_FILE = "vocals.wav";
export const DEFAULT_DEMUCS_MODEL = "htdemucs";

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "dub",
  "demucs-separate.py",
);

const PROBE_TIMEOUT_MS = 60_000;
/** 15 分钟片在 CPU 上分离可能要好几分钟，给足余量。 */
const SEPARATE_TIMEOUT_MS = 60 * 60 * 1000;

export class DemucsError extends Error {
  readonly kind: "UNAVAILABLE" | "FAILED";

  constructor(kind: "UNAVAILABLE" | "FAILED", message: string, opts?: { cause?: unknown }) {
    super(message, opts !== undefined ? { cause: opts.cause } : undefined);
    this.name = "DemucsError";
    this.kind = kind;
  }
}

export const isDemucsError = (err: unknown): err is DemucsError => err instanceof DemucsError;

export type ProbeDemucsInput = {
  runner?: ProcessRunner;
  pythonPath?: string;
  signal?: AbortSignal;
};

/**
 * 探测 demucs 是否可 import。成功返回 python 路径；失败抛 DemucsError UNAVAILABLE。
 */
export const probeDemucs = async (input: ProbeDemucsInput = {}): Promise<string> => {
  const runner = input.runner ?? defaultProcessRunner;
  const pythonPath = input.pythonPath ?? "python3";
  try {
    const result = await runner.run({
      command: pythonPath,
      args: [SCRIPT_PATH, "--probe-only", "--input", "_", "--out-dir", "_"],
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (result.exitCode !== 0) {
      throw new DemucsError(
        "UNAVAILABLE",
        `demucs is not available (exit ${result.exitCode}). Install with \`pip install demucs\`, then retry.`,
      );
    }
    return pythonPath;
  } catch (err: unknown) {
    if (err instanceof DemucsError) throw err;
    if (isProcessError(err) && (err.kind === "NOT_FOUND" || err.kind === "SPAWN_FAILED")) {
      throw new DemucsError(
        "UNAVAILABLE",
        `Python or demucs is not available (${err.kind}). Install demucs with \`pip install demucs\`, or set a Python that has it.`,
        { cause: err },
      );
    }
    // ProcessRunner 在非零退出时常抛错；把 stderr 里的 demucs 提示透出来
    const detail = err instanceof Error ? err.message : String(err);
    throw new DemucsError(
      "UNAVAILABLE",
      `demucs probe failed: ${detail}. Install with \`pip install demucs\`.`,
      { cause: err },
    );
  }
};

export type SeparateDemucsInput = {
  inputPath: string;
  outDir: string;
  runner?: ProcessRunner;
  pythonPath?: string;
  model?: string;
  signal?: AbortSignal;
  /** 已有 no_vocals.wav 时跳过分离（--force 由调用方清掉）。 */
  skipIfExists?: boolean;
};

export type SeparateDemucsResult = {
  noVocalsPath: string;
  vocalsPath: string;
  skipped: boolean;
  model: string;
};

const exists = async (candidate: string): Promise<boolean> =>
  access(candidate)
    .then(() => true)
    .catch(() => false);

export const separateDemucs = async (input: SeparateDemucsInput): Promise<SeparateDemucsResult> => {
  const runner = input.runner ?? defaultProcessRunner;
  const model = input.model ?? DEFAULT_DEMUCS_MODEL;
  const noVocalsPath = path.join(input.outDir, DEMUCS_NO_VOCALS_FILE);
  const vocalsPath = path.join(input.outDir, DEMUCS_VOCALS_FILE);

  if (input.skipIfExists !== false && (await exists(noVocalsPath))) {
    return { noVocalsPath, vocalsPath, skipped: true, model };
  }

  const pythonPath =
    input.pythonPath ??
    (await probeDemucs({
      runner,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }));

  try {
    const result = await runner.run({
      command: pythonPath,
      args: [
        SCRIPT_PATH,
        "--input",
        input.inputPath,
        "--out-dir",
        input.outDir,
        "--model",
        model,
      ],
      timeoutMs: SEPARATE_TIMEOUT_MS,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (result.exitCode !== 0) {
      throw new DemucsError(
        "FAILED",
        `demucs separation failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`,
      );
    }
  } catch (err: unknown) {
    if (err instanceof DemucsError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new DemucsError("FAILED", `demucs separation failed: ${detail}`, { cause: err });
  }

  if (!(await exists(noVocalsPath))) {
    throw new DemucsError("FAILED", `demucs did not produce ${DEMUCS_NO_VOCALS_FILE} in ${input.outDir}`);
  }

  return { noVocalsPath, vocalsPath, skipped: false, model };
};
