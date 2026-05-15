import { z } from "zod";
import { DEFAULT_X_SCOPES, type XAppConfig, type XScope } from "@yt2x/core";

const ScopeSchema = z.enum([
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
  "media.write",
]);

export const DEFAULT_X_REDIRECT_URI = "http://127.0.0.1:8989/callback";

export type ResolveXAppOptions = {
  /** 命令行覆盖 redirect（一般无须，调试时用） */
  redirectUri?: string;
  /** 命令行覆盖端口（更新 redirect 中的 port 段） */
  port?: number;
  /** 额外加 scope（如 media.write） */
  extraScopes?: readonly XScope[];
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
};

export const resolveXAppConfig = async (opts: ResolveXAppOptions = {}): Promise<XAppConfig> => {
  const env = opts.env ?? process.env;
  const clientId = env.X_CLIENT_ID?.trim();
  if (clientId === undefined || clientId.length === 0) {
    throw new Error(
      'Missing X_CLIENT_ID. Export it from your X Developer Portal app, e.g.\n  export X_CLIENT_ID="xxx"',
    );
  }

  let clientSecret = env.X_CLIENT_SECRET?.trim();
  if (clientSecret !== undefined && clientSecret.length === 0) clientSecret = undefined;

  let baseRedirect = opts.redirectUri ?? env.X_REDIRECT_URI ?? DEFAULT_X_REDIRECT_URI;
  if (opts.port !== undefined) {
    const u = new URL(baseRedirect);
    u.port = String(opts.port);
    baseRedirect = u.toString().replace(/\/$/, "");
  }

  let extraScopes: readonly XScope[] = [];
  if (opts.extraScopes !== undefined && opts.extraScopes.length > 0) {
    extraScopes = opts.extraScopes.map((s) => ScopeSchema.parse(s));
  }

  const scopes: readonly XScope[] = Array.from(
    new Set<XScope>([...DEFAULT_X_SCOPES, ...extraScopes]),
  );

  const config: XAppConfig = {
    clientId,
    redirectUri: baseRedirect,
    scopes,
  };
  if (clientSecret !== undefined) config.clientSecret = clientSecret;
  return config;
};
