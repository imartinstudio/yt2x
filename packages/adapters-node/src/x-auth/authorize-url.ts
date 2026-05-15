import type { XAppConfig, XScope } from "@yt2x/core";

/**
 * X OAuth 2.0 endpoints。
 *
 * 来源：https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
 *
 * NOTE: X 的 authorize 端口在 twitter.com 域，token/revoke 在 api.twitter.com 域，
 * 这是历史原因，必须分别使用。api.x.com 也部分可用，但 token endpoint 在 v2 文档中仍以
 * api.twitter.com 为准。我们坚持文档上的稳定值，不去赌新域名。
 */
export const X_OAUTH_ENDPOINTS = {
  authorize: "https://twitter.com/i/oauth2/authorize",
  token: "https://api.twitter.com/2/oauth2/token",
  revoke: "https://api.twitter.com/2/oauth2/revoke",
  usersMe: "https://api.twitter.com/2/users/me",
} as const;

export type BuildAuthorizeUrlInput = {
  app: XAppConfig;
  state: string;
  codeChallenge: string;
};

export const buildAuthorizeUrl = (input: BuildAuthorizeUrlInput): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.app.clientId,
    redirect_uri: input.app.redirectUri,
    scope: serializeScopes(input.app.scopes),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${X_OAUTH_ENDPOINTS.authorize}?${params.toString()}`;
};

export const serializeScopes = (scopes: readonly XScope[]): string => {
  if (scopes.length === 0) {
    throw new Error("scopes cannot be empty");
  }
  const unique = Array.from(new Set(scopes));
  return unique.join(" ");
};
