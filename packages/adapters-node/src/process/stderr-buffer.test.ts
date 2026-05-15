import { describe, expect, it, vi } from "vitest";
import { createLineSplitter, TruncatingBuffer } from "./stderr-buffer.js";

describe("TruncatingBuffer", () => {
  it("returns raw content when below head limit", () => {
    const buf = new TruncatingBuffer(100, 100);
    buf.append("hello world");
    expect(buf.toString()).toBe("hello world");
    expect(buf.truncated).toBe(false);
  });

  it("retains head when it would overflow on its own", () => {
    const buf = new TruncatingBuffer(5, 5);
    buf.append("abcdefghij");
    expect(buf.toString()).toContain("abcde");
    expect(buf.toString()).toContain("fghij");
    // first 5 bytes go to head, last 5 to tail, no drops
    expect(buf.truncated).toBe(false);
  });

  it("inserts dropped marker when middle bytes are evicted", () => {
    const buf = new TruncatingBuffer(3, 3);
    buf.append("AAA");
    buf.append("BBBBB");
    buf.append("CCC");
    const out = buf.toString();
    expect(out.startsWith("AAA")).toBe(true);
    expect(out.endsWith("CCC")).toBe(true);
    expect(out).toMatch(/\[\.\.\. \d+ bytes dropped \.\.\.\]/);
    expect(buf.truncated).toBe(true);
  });

  it("handles chunks larger than head + tail", () => {
    const buf = new TruncatingBuffer(2, 2);
    const big = Buffer.alloc(1000, "x");
    buf.append(big);
    const out = buf.toString();
    expect(out).toMatch(/^xx\n\[\.\.\. \d+ bytes dropped \.\.\.\]\nxx$/);
  });

  it("counts total bytes seen correctly", () => {
    const buf = new TruncatingBuffer(4, 4);
    buf.append("AAAA");
    buf.append("BBBBBBBB");
    expect(buf.totalBytesSeen).toBe(12);
  });

  it("handles maxTail = 0 (head-only mode)", () => {
    const buf = new TruncatingBuffer(3, 0);
    buf.append("AAA");
    buf.append("BBBB");
    expect(buf.toString()).toMatch(/^AAA\n\[\.\.\. 4 bytes dropped \.\.\.\]\n$/);
  });

  it("accepts string and Buffer interchangeably", () => {
    const buf = new TruncatingBuffer(50, 50);
    buf.append("hello ");
    buf.append(Buffer.from("world", "utf8"));
    expect(buf.toString()).toBe("hello world");
  });

  it("rejects negative limits", () => {
    expect(() => new TruncatingBuffer(-1, 0)).toThrow(RangeError);
    expect(() => new TruncatingBuffer(0, -1)).toThrow(RangeError);
  });

  it("ignores empty chunks", () => {
    const buf = new TruncatingBuffer(5, 5);
    buf.append("");
    buf.append(Buffer.alloc(0));
    expect(buf.toString()).toBe("");
    expect(buf.totalBytesSeen).toBe(0);
  });
});

describe("createLineSplitter", () => {
  it("emits each complete line", () => {
    const onLine = vi.fn();
    const splitter = createLineSplitter(onLine);
    splitter.feed("a\nb\nc\n");
    expect(onLine).toHaveBeenCalledTimes(3);
    expect(onLine).toHaveBeenNthCalledWith(1, "a");
    expect(onLine).toHaveBeenNthCalledWith(2, "b");
    expect(onLine).toHaveBeenNthCalledWith(3, "c");
  });

  it("buffers partial lines across chunks", () => {
    const onLine = vi.fn();
    const splitter = createLineSplitter(onLine);
    splitter.feed("foo");
    splitter.feed("bar\n");
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine).toHaveBeenCalledWith("foobar");
  });

  it("strips trailing \\r (Windows line endings)", () => {
    const onLine = vi.fn();
    const splitter = createLineSplitter(onLine);
    splitter.feed("hello\r\n");
    expect(onLine).toHaveBeenCalledWith("hello");
  });

  it("flush emits remaining buffer without trailing newline", () => {
    const onLine = vi.fn();
    const splitter = createLineSplitter(onLine);
    splitter.feed("dangling");
    splitter.flush();
    expect(onLine).toHaveBeenCalledWith("dangling");
  });

  it("flush is idempotent (won't emit empty after drain)", () => {
    const onLine = vi.fn();
    const splitter = createLineSplitter(onLine);
    splitter.feed("done\n");
    splitter.flush();
    splitter.flush();
    expect(onLine).toHaveBeenCalledTimes(1);
  });
});
