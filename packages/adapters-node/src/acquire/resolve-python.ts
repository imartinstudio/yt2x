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
