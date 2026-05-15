/**
 * 带"中间省略"的累积缓冲。
 *
 *  - 前 `maxHead` 字节进 head；溢出后开始进 tail；
 *  - tail 是一个 FIFO 字节窗口，最多保留 `maxTail` 字节；
 *  - 一旦溢出，最终 toString() 会在中间插入 `[... N bytes dropped ...]`。
 *
 * 设计动机：子进程错误通常在 stderr **末尾**（exception trace、最后一条日志），
 * 但偶尔也需要看开头的诊断（如 yt-dlp 的版本/cookies 警告）。
 * 取首尾各 256K（默认）能覆盖 99% 调试场景，且把 stderr 总占用钳制在 ~512K。
 */
export class TruncatingBuffer {
  private head: Buffer[] = [];
  private headSize = 0;
  private tail: Buffer[] = [];
  private tailSize = 0;
  private droppedBytes = 0;

  constructor(
    private readonly maxHead: number,
    private readonly maxTail: number,
  ) {
    if (maxHead < 0 || maxTail < 0) {
      throw new RangeError("maxHead and maxTail must be non-negative");
    }
  }

  append(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (buf.length === 0) return;

    let cursor = 0;
    if (this.headSize < this.maxHead) {
      const room = this.maxHead - this.headSize;
      const take = Math.min(room, buf.length);
      this.head.push(buf.subarray(0, take));
      this.headSize += take;
      cursor = take;
    }
    if (cursor >= buf.length) return;

    const remainder = buf.subarray(cursor);
    if (this.maxTail === 0) {
      this.droppedBytes += remainder.length;
      return;
    }

    this.tail.push(remainder);
    this.tailSize += remainder.length;

    while (this.tailSize > this.maxTail && this.tail.length > 1) {
      const first = this.tail[0]!;
      this.tail.shift();
      this.tailSize -= first.length;
      this.droppedBytes += first.length;
    }
    if (this.tailSize > this.maxTail) {
      const only = this.tail[0]!;
      const drop = this.tailSize - this.maxTail;
      this.tail[0] = only.subarray(drop);
      this.tailSize -= drop;
      this.droppedBytes += drop;
    }
  }

  get totalBytesSeen(): number {
    return this.headSize + this.tailSize + this.droppedBytes;
  }

  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  toString(): string {
    if (this.tail.length === 0 && this.droppedBytes === 0) {
      return Buffer.concat(this.head).toString("utf8");
    }
    const headStr = Buffer.concat(this.head).toString("utf8");
    const tailStr = Buffer.concat(this.tail).toString("utf8");
    if (this.droppedBytes === 0) {
      return headStr + tailStr;
    }
    return `${headStr}\n[... ${this.droppedBytes} bytes dropped ...]\n${tailStr}`;
  }
}

export type LineSplitter = (chunk: Buffer | string) => void;

/**
 * 创建一个 chunk → 整行回调的分割器。
 * 跨 chunk 的半行被保留，调用 `flush()` 输出剩余尾巴。
 */
export const createLineSplitter = (onLine: (line: string) => void): {
  feed: (chunk: Buffer | string) => void;
  flush: () => void;
} => {
  let pending = "";
  const feed = (chunk: Buffer | string): void => {
    pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx = pending.indexOf("\n");
    while (idx >= 0) {
      const line = pending.slice(0, idx).replace(/\r$/, "");
      onLine(line);
      pending = pending.slice(idx + 1);
      idx = pending.indexOf("\n");
    }
  };
  const flush = (): void => {
    if (pending.length > 0) {
      onLine(pending);
      pending = "";
    }
  };
  return { feed, flush };
};
