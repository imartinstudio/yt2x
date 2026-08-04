import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Cache the resolved Python binary for the process lifetime.
 * Subtitle burn scripts require Pillow (PIL); bare macOS CLT python3 often
 * lacks it while Homebrew python3 has it.
 */
let cachedPython: string | undefined;
let resolvePromise: Promise<string> | undefined;

const CANDIDATES = [
  process.env.YT2X_PYTHON,
  // .venv-demucs 是 docs/USAGE.md 引导用户创建的专用 venv（demucs + faster-whisper），
  // 应该比裸系统 Python 优先命中这两项能力探测。
  ".venv-demucs/bin/python3",
  // Prefer Homebrew /opt paths before bare "python3" so agent shells whose
  // PATH puts /usr/bin first still find a Pillow-capable interpreter.
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "python3",
  "python",
].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

const hasPillow = async (bin: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(
      bin,
      ["-c", "import PIL; print('ok')"],
      { timeout: 10_000, env: process.env },
    );
    return stdout.includes("ok");
  } catch {
    return false;
  }
};

const isExecutable = async (bin: string): Promise<boolean> => {
  // Absolute path: check access. Relative command name: let execFile probe PATH.
  if (bin.includes("/") || bin.startsWith(".")) {
    try {
      await access(bin);
      return true;
    } catch {
      return false;
    }
  }
  return true;
};

/**
 * Resolve a Python 3 interpreter that can import Pillow.
 * Override with YT2X_PYTHON when needed.
 */
export const resolvePythonWithPillow = async (): Promise<string> => {
  if (cachedPython !== undefined) return cachedPython;
  if (resolvePromise !== undefined) return resolvePromise;

  resolvePromise = (async () => {
    const tried: string[] = [];
    for (const bin of CANDIDATES) {
      if (!(await isExecutable(bin))) continue;
      tried.push(bin);
      if (await hasPillow(bin)) {
        cachedPython = bin;
        return bin;
      }
    }
    throw new Error(
      `No Python with Pillow found. Tried: ${tried.join(", ") || "(none)"}. ` +
        `Install Pillow (e.g. brew install pillow / pip install Pillow) ` +
        `or set YT2X_PYTHON to a Python 3 binary that has it.`,
    );
  })();

  try {
    return await resolvePromise;
  } catch (err) {
    resolvePromise = undefined;
    throw err;
  }
};

/** Test helper: clear the cache between cases. */
export const resetResolvedPythonCache = (): void => {
  cachedPython = undefined;
  resolvePromise = undefined;
};

/**
 * torchaudio (needed for forced-alignment word timing) is a heavy, optional
 * dependency — unlike Pillow, its absence must degrade gracefully rather
 * than fail the whole pipeline. Returns `undefined` instead of throwing.
 */
export const hasTorchaudio = async (bin: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(
      bin,
      ["-c", "import torchaudio; print('ok')"],
      { timeout: 10_000, env: process.env },
    );
    return stdout.includes("ok");
  } catch {
    return false;
  }
};

let cachedTorchaudioPython: string | undefined;
let resolveTorchaudioPromise: Promise<string | undefined> | undefined;

export const resolvePythonWithTorchaudio = async (): Promise<string | undefined> => {
  if (cachedTorchaudioPython !== undefined) return cachedTorchaudioPython;
  if (resolveTorchaudioPromise !== undefined) return resolveTorchaudioPromise;

  resolveTorchaudioPromise = (async () => {
    for (const bin of CANDIDATES) {
      if (!(await isExecutable(bin))) continue;
      if (await hasTorchaudio(bin)) {
        cachedTorchaudioPython = bin;
        return bin;
      }
    }
    return undefined;
  })();

  try {
    return await resolveTorchaudioPromise;
  } finally {
    resolveTorchaudioPromise = undefined;
  }
};

/** Test helper: clear the cache between cases. */
export const resetResolvedTorchaudioPythonCache = (): void => {
  cachedTorchaudioPython = undefined;
  resolveTorchaudioPromise = undefined;
};

/**
 * faster-whisper (local transcription channel) is likewise an optional,
 * heavy dependency — absence must degrade gracefully, never fail the run.
 */
export const hasFasterWhisper = async (bin: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(
      bin,
      ["-c", "import faster_whisper; print('ok')"],
      { timeout: 10_000, env: process.env },
    );
    return stdout.includes("ok");
  } catch {
    return false;
  }
};

let cachedFasterWhisperPython: string | undefined;
let resolveFasterWhisperPromise: Promise<string | undefined> | undefined;

export const resolvePythonWithFasterWhisper = async (): Promise<string | undefined> => {
  if (cachedFasterWhisperPython !== undefined) return cachedFasterWhisperPython;
  if (resolveFasterWhisperPromise !== undefined) return resolveFasterWhisperPromise;

  resolveFasterWhisperPromise = (async () => {
    for (const bin of CANDIDATES) {
      if (!(await isExecutable(bin))) continue;
      if (await hasFasterWhisper(bin)) {
        cachedFasterWhisperPython = bin;
        return bin;
      }
    }
    return undefined;
  })();

  try {
    return await resolveFasterWhisperPromise;
  } finally {
    resolveFasterWhisperPromise = undefined;
  }
};

/** Test helper: clear the cache between cases. */
export const resetResolvedFasterWhisperPythonCache = (): void => {
  cachedFasterWhisperPython = undefined;
  resolveFasterWhisperPromise = undefined;
};

/**
 * demucs（配音背景音分离）同样是可选、重依赖——探测不到必须优雅降级，不能让整条流水线崩溃。
 */
export const hasDemucs = async (bin: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(
      bin,
      ["-c", "import demucs; print('ok')"],
      { timeout: 10_000, env: process.env },
    );
    return stdout.includes("ok");
  } catch {
    return false;
  }
};

let cachedDemucsPython: string | undefined;
let resolveDemucsPromise: Promise<string | undefined> | undefined;

export const resolvePythonWithDemucs = async (): Promise<string | undefined> => {
  if (cachedDemucsPython !== undefined) return cachedDemucsPython;
  if (resolveDemucsPromise !== undefined) return resolveDemucsPromise;

  resolveDemucsPromise = (async () => {
    for (const bin of CANDIDATES) {
      if (!(await isExecutable(bin))) continue;
      if (await hasDemucs(bin)) {
        cachedDemucsPython = bin;
        return bin;
      }
    }
    return undefined;
  })();

  try {
    return await resolveDemucsPromise;
  } finally {
    resolveDemucsPromise = undefined;
  }
};

/** Test helper: clear the cache between cases. */
export const resetResolvedDemucsPythonCache = (): void => {
  cachedDemucsPython = undefined;
  resolveDemucsPromise = undefined;
};
