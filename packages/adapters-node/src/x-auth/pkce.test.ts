import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePkcePair, generateState, timingSafeStringEqual } from "./pkce.js";

const isBase64Url = (s: string): boolean => /^[A-Za-z0-9_-]+$/.test(s);

const base64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("generatePkcePair", () => {
  it("returns a base64url verifier of 43+ chars (RFC 7636)", () => {
    const pair = generatePkcePair();
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(isBase64Url(pair.codeVerifier)).toBe(true);
  });

  it("challenge equals BASE64URL(SHA256(verifier))", () => {
    const pair = generatePkcePair();
    const expected = base64url(createHash("sha256").update(pair.codeVerifier).digest());
    expect(pair.codeChallenge).toBe(expected);
    expect(pair.codeChallengeMethod).toBe("S256");
  });

  it("returns a distinct pair on each call (CSPRNG)", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

describe("generateState", () => {
  it("returns base64url string of >= 32 chars", () => {
    const state = generateState();
    expect(isBase64Url(state)).toBe(true);
    expect(state.length).toBeGreaterThanOrEqual(32);
  });

  it("is unique across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(generateState());
    expect(seen.size).toBe(100);
  });
});

describe("timingSafeStringEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
  });
  it("returns false for different strings of equal length", () => {
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
  });
  it("returns false for different-length strings", () => {
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
  });
  it("handles empty strings", () => {
    expect(timingSafeStringEqual("", "")).toBe(true);
    expect(timingSafeStringEqual("", "a")).toBe(false);
  });
});
