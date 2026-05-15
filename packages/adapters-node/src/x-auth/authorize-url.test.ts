import { describe, expect, it } from "vitest";
import { DEFAULT_X_SCOPES, type XAppConfig } from "@yt2x/core";
import { buildAuthorizeUrl, serializeScopes, X_OAUTH_ENDPOINTS } from "./authorize-url.js";

const app: XAppConfig = {
  clientId: "test-client",
  redirectUri: "http://127.0.0.1:8989/callback",
  scopes: DEFAULT_X_SCOPES,
};

describe("buildAuthorizeUrl", () => {
  it("includes all required PKCE params", () => {
    const url = new URL(
      buildAuthorizeUrl({ app, state: "state-123", codeChallenge: "challenge-abc" }),
    );
    expect(url.origin + url.pathname).toBe(X_OAUTH_ENDPOINTS.authorize);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-client");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8989/callback");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("serializes default scopes (space-joined, deduped)", () => {
    const url = new URL(
      buildAuthorizeUrl({ app, state: "s", codeChallenge: "c" }),
    );
    expect(url.searchParams.get("scope")).toBe(
      "tweet.read tweet.write users.read offline.access",
    );
  });

  it("dedupes when caller passes overlapping scopes", () => {
    const dupApp: XAppConfig = {
      ...app,
      scopes: ["tweet.read", "tweet.read", "users.read"] as XAppConfig["scopes"],
    };
    const url = new URL(buildAuthorizeUrl({ app: dupApp, state: "s", codeChallenge: "c" }));
    expect(url.searchParams.get("scope")).toBe("tweet.read users.read");
  });

  it("never leaks clientSecret into the authorize URL", () => {
    const confidential: XAppConfig = {
      ...app,
      clientSecret: "super-secret",
    };
    const url = buildAuthorizeUrl({ app: confidential, state: "s", codeChallenge: "c" });
    expect(url).not.toContain("super-secret");
    expect(url).not.toContain("client_secret");
  });
});

describe("serializeScopes", () => {
  it("rejects empty scopes (server would reject anyway)", () => {
    expect(() => serializeScopes([])).toThrow(/empty/);
  });
});
