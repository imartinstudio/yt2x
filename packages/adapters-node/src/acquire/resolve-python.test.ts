import { describe, expect, it } from "vitest";
import {
  hasTorchaudio,
  resetResolvedTorchaudioPythonCache,
  resolvePythonWithTorchaudio,
} from "./resolve-python.js";

describe("hasTorchaudio", () => {
  it("returns false for an interpreter that lacks torchaudio", async () => {
    // The bare macOS system Python never has our project's Python deps.
    await expect(hasTorchaudio("/usr/bin/python3")).resolves.toBe(false);
  });

  it("returns false for a nonexistent binary instead of throwing", async () => {
    await expect(hasTorchaudio("/no/such/python3")).resolves.toBe(false);
  });
});

describe("resolvePythonWithTorchaudio", () => {
  it("resolves without throwing, returning either a python path or undefined", async () => {
    resetResolvedTorchaudioPythonCache();
    const result = await resolvePythonWithTorchaudio();
    expect(result === undefined || typeof result === "string").toBe(true);
  });

  it("caches the result across calls", async () => {
    resetResolvedTorchaudioPythonCache();
    const first = await resolvePythonWithTorchaudio();
    const second = await resolvePythonWithTorchaudio();
    expect(second).toBe(first);
  });
});
