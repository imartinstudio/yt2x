import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extensionInvalidatedUserMessage,
  isExtensionContextInvalidated,
  isExtensionRuntimeAlive,
  loadSubscriptionTier,
  saveSubscriptionTier,
  toUserFacingImportError,
} from "./extension-runtime.js";

const memoryStorage = new Map<string, string>();

const installLocalStorageMock = (): void => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStorage.delete(key);
    },
    clear: () => {
      memoryStorage.clear();
    },
  });
};

describe("extension-runtime", () => {
  beforeEach(() => {
    memoryStorage.clear();
    installLocalStorageMock();
  });

  afterEach(() => {
    memoryStorage.clear();
    vi.unstubAllGlobals();
  });

  it("detects invalidated extension errors", () => {
    expect(isExtensionContextInvalidated(new Error("Extension context invalidated."))).toBe(true);
    expect(isExtensionContextInvalidated(new Error("other"))).toBe(false);
    expect(toUserFacingImportError(new Error("Extension context invalidated."))).toBe(
      extensionInvalidatedUserMessage,
    );
  });

  it("falls back to localStorage when chrome runtime is unavailable", async () => {
    vi.stubGlobal("chrome", undefined);
    await saveSubscriptionTier("premium-plus");
    expect(await loadSubscriptionTier()).toBe("premium-plus");
  });

  it("reports runtime alive when chrome.runtime.id exists", () => {
    vi.stubGlobal("chrome", { runtime: { id: "test-extension" }, storage: { local: { get: vi.fn(), set: vi.fn() } } });
    expect(isExtensionRuntimeAlive()).toBe(true);
  });
});
