import { describe, expect, it, vi } from "vitest";
import { isProcessError } from "./errors.js";
import { createProcessRunner } from "./runner.js";

const NODE_BIN = process.execPath;

const nodeArgs = (script: string): string[] => ["-e", script];

const isPosix = process.platform !== "win32";

describe("createProcessRunner", () => {
  it("returns stdout / stderr / exitCode on success", async () => {
    const runner = createProcessRunner();
    const result = await runner.run({
      command: NODE_BIN,
      args: nodeArgs(
        `process.stdout.write("hello-stdout"); process.stderr.write("hello-stderr"); process.exit(0);`,
      ),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-stdout");
    expect(result.stderr).toBe("hello-stderr");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws ProcessError(NON_ZERO_EXIT) on non-zero exit", async () => {
    const runner = createProcessRunner();
    try {
      await runner.run({
        command: NODE_BIN,
        args: nodeArgs(`process.stderr.write("boom\\n"); process.exit(7);`),
      });
      throw new Error("expected ProcessError");
    } catch (err: unknown) {
      expect(isProcessError(err)).toBe(true);
      if (isProcessError(err)) {
        expect(err.kind).toBe("NON_ZERO_EXIT");
        expect(err.context.exitCode).toBe(7);
        expect(err.context.stderrExcerpt).toContain("boom");
      }
    }
  });

  it("throws ProcessError(NOT_FOUND) when command does not exist", async () => {
    const runner = createProcessRunner();
    try {
      await runner.run({ command: "this-binary-does-not-exist-xyz-12345", args: [] });
      throw new Error("expected ProcessError");
    } catch (err: unknown) {
      expect(isProcessError(err)).toBe(true);
      if (isProcessError(err)) {
        expect(err.kind).toBe("NOT_FOUND");
      }
    }
  });

  it("throws ProcessError(TIMEOUT) when exceeding timeoutMs", async () => {
    const runner = createProcessRunner();
    const start = Date.now();
    try {
      await runner.run({
        command: NODE_BIN,
        args: nodeArgs(`setTimeout(() => process.exit(0), 5000);`),
        timeoutMs: 200,
      });
      throw new Error("expected ProcessError");
    } catch (err: unknown) {
      expect(isProcessError(err)).toBe(true);
      if (isProcessError(err)) {
        expect(err.kind).toBe("TIMEOUT");
      }
    }
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("throws ProcessError(KILLED) when AbortSignal aborts", async () => {
    const runner = createProcessRunner();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    try {
      await runner.run({
        command: NODE_BIN,
        args: nodeArgs(`setTimeout(() => process.exit(0), 5000);`),
        signal: controller.signal,
        timeoutMs: 10_000,
      });
      throw new Error("expected ProcessError");
    } catch (err: unknown) {
      expect(isProcessError(err)).toBe(true);
      if (isProcessError(err)) {
        expect(["KILLED", "TIMEOUT"]).toContain(err.kind);
      }
    }
  });

  it("emits onStdoutLine for each complete line", async () => {
    const onStdoutLine = vi.fn();
    const runner = createProcessRunner();
    await runner.run({
      command: NODE_BIN,
      args: nodeArgs(
        `process.stdout.write("line1\\n"); process.stdout.write("line"); process.stdout.write("2\\n"); process.stdout.write("line3");`,
      ),
      onStdoutLine,
    });
    expect(onStdoutLine).toHaveBeenCalledWith("line1");
    expect(onStdoutLine).toHaveBeenCalledWith("line2");
    expect(onStdoutLine).toHaveBeenCalledWith("line3");
  });

  it("truncates oversized stdout", async () => {
    const runner = createProcessRunner();
    const result = await runner.run({
      command: NODE_BIN,
      args: nodeArgs(`process.stdout.write("x".repeat(100000));`),
      stdoutLimit: { head: 100, tail: 100 },
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toMatch(/\[\.\.\. \d+ bytes dropped \.\.\.\]/);
  });

  it("merges spec.env over process.env when inheritEnv is true (default)", async () => {
    const runner = createProcessRunner();
    const result = await runner.run({
      command: NODE_BIN,
      args: nodeArgs(
        `process.stdout.write(process.env.YT2X_TEST_VAR || ""); process.stdout.write("|"); process.stdout.write(process.env.PATH ? "has-path" : "no-path");`,
      ),
      env: { YT2X_TEST_VAR: "injected" },
    });
    expect(result.stdout.startsWith("injected|")).toBe(true);
    expect(result.stdout.endsWith("has-path")).toBe(true);
  });

  it("isolates env when inheritEnv is false (parent-only vars must not leak)", async () => {
    if (!isPosix) return; // Windows env propagation is special-cased; skip
    // 注入一个父进程独有的"金丝雀"变量，inheritEnv:false 时子进程必须看不到
    process.env.YT2X_PARENT_CANARY = "must-not-leak";
    try {
      const runner = createProcessRunner();
      const result = await runner.run({
        command: NODE_BIN,
        args: nodeArgs(
          `process.stdout.write("canary=" + (process.env.YT2X_PARENT_CANARY ?? "absent") + ",injected=" + (process.env.YT2X_TEST_VAR ?? "absent"));`,
        ),
        env: { YT2X_TEST_VAR: "ok" },
        inheritEnv: false,
      });
      expect(result.stdout).toContain("canary=absent");
      expect(result.stdout).toContain("injected=ok");
    } finally {
      delete process.env.YT2X_PARENT_CANARY;
    }
  });

  it("forwards stdin via spec.input", async () => {
    const runner = createProcessRunner();
    const result = await runner.run({
      command: NODE_BIN,
      args: nodeArgs(
        `let data = ""; process.stdin.on("data", (c) => data += c); process.stdin.on("end", () => process.stdout.write("got:" + data));`,
      ),
      input: "hello",
    });
    expect(result.stdout).toBe("got:hello");
  });

  it("never leaks secrets that live only in env (env not echoed)", async () => {
    const runner = createProcessRunner();
    const result = await runner.run({
      command: NODE_BIN,
      args: nodeArgs(`process.stdout.write("no-secret");`),
      env: { OPENAI_API_KEY: "sk-PROOF-OF-LIFE" },
    });
    expect(result.stdout).not.toContain("sk-PROOF-OF-LIFE");
    expect(result.stderr).not.toContain("sk-PROOF-OF-LIFE");
  });
});
