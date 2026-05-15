export type ProcessErrorKind =
  | "NOT_FOUND" // 可执行文件不存在（ENOENT）
  | "TIMEOUT" // 超时被强制结束
  | "NON_ZERO_EXIT" // 进程退出码非 0
  | "KILLED" // 被 AbortSignal 中止
  | "SPAWN_FAILED" // 其它 spawn 错误（权限、PATH、shell 限制）
  | "UNKNOWN";

export type ProcessErrorContext = {
  command: string;
  args: readonly string[];
  exitCode?: number | undefined;
  signal?: NodeJS.Signals | null | undefined;
  durationMs?: number | undefined;
  /** 截断后的 stderr 摘录，长度受 runner 的 limit 控制 */
  stderrExcerpt?: string | undefined;
};

/**
 * 子进程错误的统一外观。
 *
 * 设计原则：
 *  - 错误 message 是**用户面向**的（中性、不含技术黑魔法）。
 *  - `kind` 是**程序面向**的（用来做退出码映射、重试决策）。
 *  - `context` 是**调试面向**的（stderr 摘录、duration），供 logger 结构化输出。
 *
 * 任何 stderr 摘录都不直接拼进 message，避免把含密信息暴露到 e.g. exit message 中。
 */
export class ProcessError extends Error {
  readonly kind: ProcessErrorKind;
  readonly context: ProcessErrorContext;

  constructor(kind: ProcessErrorKind, message: string, context: ProcessErrorContext) {
    super(message);
    this.name = "ProcessError";
    this.kind = kind;
    this.context = context;
  }
}

export const isProcessError = (err: unknown): err is ProcessError =>
  err instanceof ProcessError;
