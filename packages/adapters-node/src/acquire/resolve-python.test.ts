import { describe, expect, it } from "vitest";
import {
  hasDemucs,
  hasFasterWhisper,
  hasTorchaudio,
  resetResolvedDemucsPythonCache,
  resetResolvedFasterWhisperPythonCache,
  resetResolvedTorchaudioPythonCache,
  resolvePythonWithDemucs,
  resolvePythonWithFasterWhisper,
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

describe("hasFasterWhisper", () => {
  it("returns false for an interpreter that lacks faster-whisper", async () => {
    await expect(hasFasterWhisper("/usr/bin/python3")).resolves.toBe(false);
  });

  it("returns false for a nonexistent binary instead of throwing", async () => {
    await expect(hasFasterWhisper("/no/such/python3")).resolves.toBe(false);
  });
});

describe("resolvePythonWithFasterWhisper", () => {
  it("resolves without throwing, returning either a python path or undefined", async () => {
    resetResolvedFasterWhisperPythonCache();
    const result = await resolvePythonWithFasterWhisper();
    expect(result === undefined || typeof result === "string").toBe(true);
  });

  it("caches the result across calls", async () => {
    resetResolvedFasterWhisperPythonCache();
    const first = await resolvePythonWithFasterWhisper();
    const second = await resolvePythonWithFasterWhisper();
    expect(second).toBe(first);
  });
});

describe("hasDemucs", () => {
  it("returns false for an interpreter that lacks demucs", async () => {
    await expect(hasDemucs("/usr/bin/python3")).resolves.toBe(false);
  });

  it("returns false for a nonexistent binary instead of throwing", async () => {
    await expect(hasDemucs("/no/such/python3")).resolves.toBe(false);
  });
});

describe("resolvePythonWithDemucs", () => {
  it("resolves without throwing, returning either a python path or undefined", async () => {
    resetResolvedDemucsPythonCache();
    const result = await resolvePythonWithDemucs();
    expect(result === undefined || typeof result === "string").toBe(true);
  });

  it("caches the result across calls", async () => {
    resetResolvedDemucsPythonCache();
    const first = await resolvePythonWithDemucs();
    const second = await resolvePythonWithDemucs();
    expect(second).toBe(first);
  });
});
