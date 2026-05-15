import { execa, ExecaError, type Options, type Result, type ResultPromise } from "execa";
import { ProcessError, type ProcessErrorContext, type ProcessErrorKind } from "./errors.js";
import { createLineSplitter, TruncatingBuffer } from "./stderr-buffer.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_STDOUT_HEAD = 256 * 1024;
const DEFAULT_STDOUT_TAIL = 256 * 1024;
const DEFAULT_STDERR_HEAD = 256 * 1024;
const DEFAULT_STDERR_TAIL = 256 * 1024;

export type ProcessSpec = {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /**
   * 显式环境变量。当 `inheritEnv: true`（默认）时，会和 `process.env` 合并，
   * 显式值覆盖父进程。设为 false 可以得到一个完全干净的 env。
   */
  env?: Readonly<Record<string, string>>;
  inheritEnv?: boolean;
  /** 默认 5 分钟。设 0 / undefined 关闭超时（不推荐用于外部命令）。 */
  timeoutMs?: number;
  /** AbortSignal 中止时发送 SIGTERM。 */
  signal?: AbortSignal;
  /**
   *  - "pipe"（默认）：父进程拿到 stdout / stderr，可截断、可回调。
   *  - "inherit"：直接透传到父进程的 stdio（交互式 / TTY review）。
   */
  stdio?: "pipe" | "inherit";
  /** 标准输入字符串。设了之后 runner 自动用 pipe stdin。 */
  input?: string;
  /** 默认前 256K + 后 256K，超出在中间插入 `[... N bytes dropped ...]`。 */
  stdoutLimit?: { head?: number; tail?: number };
  stderrLimit?: { head?: number; tail?: number };
  /** 行级回调，方便实时日志。注意 chunks 已被 utf8 分行。 */
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
};

export type ProcessResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  command: string;
  args: readonly string[];
};

export type ProcessRunner = {
  run(spec: ProcessSpec): Promise<ProcessResult>;
};

/**
 * execa 9 的 env 行为：默认 `extendEnv: true`，会把 process.env 合并进来。
 * 想得到一个干净的子进程 env，必须显式传 `extendEnv: false`，否则父进程的
 * 任意环境变量（包括无关密钥）会泄漏到子进程。
 */
const buildEnv = (spec: ProcessSpec): { env?: Record<string, string>; extendEnv: boolean } => {
  const extendEnv = spec.inheritEnv !== false;
  if (spec.env === undefined) {
    return extendEnv ? { extendEnv: true } : { env: {}, extendEnv: false };
  }
  return { env: { ...spec.env }, extendEnv };
};

const wireStreams = (
  subprocess: ResultPromise,
  spec: ProcessSpec,
  stdoutBuf: TruncatingBuffer,
  stderrBuf: TruncatingBuffer,
): void => {
  const stdoutLine = spec.onStdoutLine
    ? createLineSplitter(spec.onStdoutLine)
    : undefined;
  const stderrLine = spec.onStderrLine
    ? createLineSplitter(spec.onStderrLine)
    : undefined;

  if (subprocess.stdout !== undefined && subprocess.stdout !== null) {
    subprocess.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBuf.append(chunk);
      stdoutLine?.feed(chunk);
    });
    subprocess.stdout.on("end", () => stdoutLine?.flush());
  }
  if (subprocess.stderr !== undefined && subprocess.stderr !== null) {
    subprocess.stderr.on("data", (chunk: Buffer | string) => {
      stderrBuf.append(chunk);
      stderrLine?.feed(chunk);
    });
    subprocess.stderr.on("end", () => stderrLine?.flush());
  }
};

const classify = (
  raw: Result | ExecaError,
  ctx: ProcessErrorContext,
): ProcessError => {
  let kind: ProcessErrorKind = "UNKNOWN";
  let message: string;

  // execa 把 spawn 失败（ENOENT 等）放在 ExecaError 上
  if (raw instanceof ExecaError) {
    const errno = (raw as unknown as { code?: string }).code;
    if (errno === "ENOENT") {
      kind = "NOT_FOUND";
      message = `Command not found: "${ctx.command}". Check PATH or install the binary.`;
    } else if (raw.timedOut) {
      kind = "TIMEOUT";
      message = `Command "${ctx.command}" timed out after ${ctx.durationMs ?? "?"}ms.`;
    } else if (raw.isCanceled) {
      kind = "KILLED";
      message = `Command "${ctx.command}" was cancelled by AbortSignal.`;
    } else if ((ctx.exitCode ?? 0) !== 0) {
      kind = "NON_ZERO_EXIT";
      message = `Command "${ctx.command}" exited with code ${ctx.exitCode ?? "(unknown)"}.`;
    } else {
      kind = "SPAWN_FAILED";
      message = `Failed to spawn "${ctx.command}": ${raw.shortMessage}`;
    }
  } else if (raw.timedOut) {
    kind = "TIMEOUT";
    message = `Command "${ctx.command}" timed out after ${ctx.durationMs ?? "?"}ms.`;
  } else if (raw.isCanceled) {
    kind = "KILLED";
    message = `Command "${ctx.command}" was cancelled by AbortSignal.`;
  } else if ((ctx.exitCode ?? 0) !== 0) {
    kind = "NON_ZERO_EXIT";
    message = `Command "${ctx.command}" exited with code ${ctx.exitCode ?? "(unknown)"}.`;
  } else {
    message = `Command "${ctx.command}" failed for an unknown reason.`;
  }
  return new ProcessError(kind, message, ctx);
};

export const createProcessRunner = (): ProcessRunner => {
  const run = async (spec: ProcessSpec): Promise<ProcessResult> => {
    const stdoutBuf = new TruncatingBuffer(
      spec.stdoutLimit?.head ?? DEFAULT_STDOUT_HEAD,
      spec.stdoutLimit?.tail ?? DEFAULT_STDOUT_TAIL,
    );
    const stderrBuf = new TruncatingBuffer(
      spec.stderrLimit?.head ?? DEFAULT_STDERR_HEAD,
      spec.stderrLimit?.tail ?? DEFAULT_STDERR_TAIL,
    );

    const isPipe = spec.stdio !== "inherit";
    const startedAt = Date.now();
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const envSpec = buildEnv(spec);
    const execaOptions = {
      cwd: spec.cwd,
      ...envSpec,
      reject: false as const,
      timeout: timeoutMs,
      cancelSignal: spec.signal,
      stdin: spec.input !== undefined ? ("pipe" as const) : ("ignore" as const),
      stdout: isPipe ? ("pipe" as const) : ("inherit" as const),
      stderr: isPipe ? ("pipe" as const) : ("inherit" as const),
      input: spec.input,
      // 不开启 shell。任何 shell metachar 都由调用方负责拼装到 args 里。
      shell: false as const,
    };

    let result: Result | ExecaError;
    try {
      // execa 的 options 在 exactOptionalPropertyTypes 下需要一次受控 cast
      const subprocess: ResultPromise = execa(
        spec.command,
        [...(spec.args ?? [])],
        execaOptions as Options,
      );
      if (isPipe) wireStreams(subprocess, spec, stdoutBuf, stderrBuf);
      result = await subprocess;
    } catch (err: unknown) {
      if (err instanceof ExecaError) {
        result = err;
      } else {
        const message = err instanceof Error ? err.message : String(err);
        throw new ProcessError("UNKNOWN", `Unexpected error: ${message}`, {
          command: spec.command,
          args: spec.args ?? [],
        });
      }
    }

    const durationMs = Date.now() - startedAt;
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : -1;
    const signal = (result.signal as NodeJS.Signals | undefined) ?? null;
    const stdoutText = isPipe ? stdoutBuf.toString() : "";
    const stderrText = isPipe ? stderrBuf.toString() : "";

    const context: ProcessErrorContext = {
      command: spec.command,
      args: spec.args ?? [],
      exitCode,
      signal,
      durationMs,
      stderrExcerpt: stderrText.length > 0 ? stderrText : undefined,
    };

    if (
      result instanceof ExecaError ||
      result.failed ||
      result.timedOut ||
      result.isCanceled ||
      exitCode !== 0
    ) {
      throw classify(result, context);
    }

    return {
      exitCode,
      signal,
      stdout: stdoutText,
      stderr: stderrText,
      stdoutTruncated: stdoutBuf.truncated,
      stderrTruncated: stderrBuf.truncated,
      durationMs,
      command: spec.command,
      args: spec.args ?? [],
    };
  };
  return { run };
};

/**
 * 单例 runner。CLI 大部分场景共用一个就够；
 * 测试或需要切换 stdio 策略时可以直接调 `createProcessRunner`。
 */
export const defaultProcessRunner: ProcessRunner = createProcessRunner();
