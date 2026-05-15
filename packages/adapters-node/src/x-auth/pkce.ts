import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE 工具（RFC 7636）。
 *
 *  - verifier：43-128 字符的 URL-safe 随机字符串。我们固定取 32 字节（base64url ≈ 43 字符），
 *    既满足 RFC 下限，也避免被某些边缘 server 误判过长。
 *  - challenge = BASE64URL(SHA256(verifier))
 *  - method = "S256"（明文 "plain" 已被各大 IdP 禁用，不做支持）
 *  - state：32 字节随机，base64url，单次有效，回调必须严格相等比较。
 *
 * 所有随机源走 `crypto.randomBytes`（CSPRNG），不允许任何外部注入弱随机。
 */

const base64url = (buf: Buffer): string =>
  buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export type PkcePair = {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

export const generatePkcePair = (): PkcePair => {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256",
  };
};

export const generateState = (): string => base64url(randomBytes(32));

/**
 * 时间安全的字符串比较，避免授权回调 state 比对中泄漏长度信息。
 * 对短字符串差异其实不重要，但成本零，养成好习惯。
 */
export const timingSafeStringEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};
