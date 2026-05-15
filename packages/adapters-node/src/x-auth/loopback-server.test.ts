import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLoopbackServer, type LoopbackServerHandle } from "./loopback-server.js";

/** 申请一个临时空闲端口（让 OS 分配，立刻关闭，仅复用端口号）。 */
const grabFreePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

let handle: LoopbackServerHandle | undefined;

beforeEach(() => {
  handle = undefined;
});

afterEach(async () => {
  if (handle !== undefined) {
    await handle.close();
  }
});

describe("loopback-server", () => {
  it("captures code+state from /callback success", async () => {
    const port = await grabFreePort();
    handle = await startLoopbackServer({ port });
    const resp = await fetch(`http://127.0.0.1:${port}/callback?code=AUTH&state=STATE`);
    expect(resp.status).toBe(200);
    const result = await handle.result;
    expect(result).toEqual({ ok: true, code: "AUTH", state: "STATE" });
  });

  it("captures error+description on /callback failure", async () => {
    const port = await grabFreePort();
    handle = await startLoopbackServer({ port });
    await fetch(
      `http://127.0.0.1:${port}/callback?error=access_denied&error_description=user%20denied&state=ST`,
    );
    const result = await handle.result;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("access_denied");
      expect(result.errorDescription).toBe("user denied");
      expect(result.state).toBe("ST");
    }
  });

  it("returns 404 for unrelated paths", async () => {
    const port = await grabFreePort();
    handle = await startLoopbackServer({ port });
    const resp = await fetch(`http://127.0.0.1:${port}/not-callback`);
    expect(resp.status).toBe(404);
  });

  it("EADDRINUSE → XAuthError(PORT_IN_USE)", async () => {
    const port = await grabFreePort();
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", () => resolve()));
    try {
      await expect(startLoopbackServer({ port })).rejects.toMatchObject({
        name: "XAuthError",
        code: "PORT_IN_USE",
      });
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("aborts with USER_CANCELLED on signal abort", async () => {
    const port = await grabFreePort();
    const controller = new AbortController();
    handle = await startLoopbackServer({ port, signal: controller.signal });
    controller.abort();
    const result = await handle.result;
    expect(result).toEqual({ ok: false, error: "user_cancelled" });
  });
});
