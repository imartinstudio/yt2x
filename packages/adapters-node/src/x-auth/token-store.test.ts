import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredCredentials } from "@yt2x/core";
import { createTokenStore } from "./token-store.js";

const isWindows = process.platform === "win32";

const buildCreds = (overrides: Partial<StoredCredentials> = {}): StoredCredentials => ({
  provider: "x",
  clientId: "client-test",
  tokens: {
    accessToken: "at-test",
    refreshToken: "rt-test",
    tokenType: "bearer",
    expiresAt: Date.now() + 60_000,
    scope: "tweet.read tweet.write users.read offline.access",
  },
  user: { id: "1", username: "tester" },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "yt2x-store-"));
  filePath = path.join(tmpDir, "nested", "credentials.json");
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(tmpDir, { recursive: true, force: true });
});

describe("token-store", () => {
  it("returns null when file does not exist", async () => {
    const store = createTokenStore(filePath);
    expect(await store.read()).toBeNull();
  });

  it("writes + reads a profile round-trip", async () => {
    const store = createTokenStore(filePath);
    const creds = buildCreds();
    await store.write(creds);
    const out = await store.read();
    expect(out).not.toBeNull();
    expect(out?.tokens.accessToken).toBe("at-test");
    expect(out?.user?.username).toBe("tester");
  });

  it("isolates profiles", async () => {
    const store = createTokenStore(filePath);
    await store.write(buildCreds({ clientId: "default-client" }), "default");
    await store.write(buildCreds({ clientId: "alt-client" }), "alt");
    expect((await store.read("default"))?.clientId).toBe("default-client");
    expect((await store.read("alt"))?.clientId).toBe("alt-client");
  });

  it("delete removes only the given profile", async () => {
    const store = createTokenStore(filePath);
    await store.write(buildCreds(), "default");
    await store.write(buildCreds(), "alt");
    await store.delete("default");
    expect(await store.read("default")).toBeNull();
    expect(await store.read("alt")).not.toBeNull();
  });

  it("writes file with 0600 permissions on POSIX", async () => {
    if (isWindows) return;
    const store = createTokenStore(filePath);
    await store.write(buildCreds());
    const info = await stat(filePath);
    const mode = info.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates parent dir with 0700 on POSIX", async () => {
    if (isWindows) return;
    const store = createTokenStore(filePath);
    await store.write(buildCreds());
    const info = await stat(path.dirname(filePath));
    const mode = info.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("survives malformed JSON detection (parse error throws clear message)", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "not-json", "utf8");
    const store = createTokenStore(filePath);
    await expect(store.read()).rejects.toThrow(/credentials file is not valid JSON/);
  });

  it("rewrites preserve createdAt across updates", async () => {
    const store = createTokenStore(filePath);
    const first = buildCreds({ createdAt: 1000, updatedAt: 1000 });
    await store.write(first);
    const second = buildCreds({ createdAt: 2000, updatedAt: 2000 });
    await store.write(second);
    const out = await store.read();
    expect(out?.createdAt).toBe(1000);
    expect(out?.updatedAt).toBeGreaterThanOrEqual(2000);
  });

  it("destroy removes the file entirely", async () => {
    const store = createTokenStore(filePath);
    await store.write(buildCreds());
    await store.destroy();
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });
});
