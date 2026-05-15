import { createTokenStore, createXAuthAdapter, defaultCredentialsPath } from "@yt2x/adapters-node";
import { XAuthError, type XAuthPort, type StoredCredentials, type XUserSummary } from "@yt2x/core";
import type { Command } from "commander";
import { resolveXAppConfig } from "../config/x-app.js";
import { logger } from "../logger.js";

type LoginFlags = {
  port?: string;
  profile?: string;
  redirectUri?: string;
  scope?: string[];
};

type ProfileFlags = {
  profile?: string;
};

const EXIT_NOT_LOGGED_IN = 2;
const EXIT_TOKEN_EXPIRED = 3;
const EXIT_NETWORK = 4;

const EXIT_CODE_BY_AUTH_ERROR: Record<string, number> = {
  NOT_LOGGED_IN: EXIT_NOT_LOGGED_IN,
  TOKEN_EXPIRED: EXIT_TOKEN_EXPIRED,
  REFRESH_FAILED: EXIT_TOKEN_EXPIRED,
  NETWORK: EXIT_NETWORK,
};

const exitFromError = (err: unknown): never => {
  if (err instanceof XAuthError) {
    logger.error({ code: err.code, msg: err.message }, "auth failed");
    const code = EXIT_CODE_BY_AUTH_ERROR[err.code] ?? 1;
    process.exit(code);
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "auth failed");
  process.exit(1);
};

const buildAdapter = async (flags: LoginFlags = {}): Promise<XAuthPort> => {
  const opts: {
    redirectUri?: string;
    port?: number;
    extraScopes?: readonly ("media.write")[];
  } = {};
  if (flags.redirectUri !== undefined) opts.redirectUri = flags.redirectUri;
  if (flags.port !== undefined) {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: "${flags.port}". Expected an integer between 1 and 65535.`);
    }
    opts.port = port;
  }
  if (flags.scope !== undefined && flags.scope.includes("media.write")) {
    opts.extraScopes = ["media.write"];
  }
  const app = await resolveXAppConfig(opts);
  const adapterOpts: Parameters<typeof createXAuthAdapter>[0] = {
    app,
    onAuthorizeUrl: (url) => {
      logger.info("Open this URL if your browser does not launch automatically:");
      process.stdout.write(`\n${url}\n\n`);
    },
  };
  if (opts.port !== undefined) adapterOpts.loopbackPort = opts.port;
  return createXAuthAdapter(adapterOpts);
};

const summarizeCreds = (creds: StoredCredentials): Record<string, unknown> => ({
  clientId: creds.clientId,
  scope: creds.tokens.scope,
  expiresAt: new Date(creds.tokens.expiresAt).toISOString(),
  expiresInSec: Math.max(0, Math.round((creds.tokens.expiresAt - Date.now()) / 1000)),
  hasRefreshToken: creds.tokens.refreshToken !== undefined,
  user: creds.user,
  createdAt: new Date(creds.createdAt).toISOString(),
  updatedAt: new Date(creds.updatedAt).toISOString(),
});

const summarizeUser = (user: XUserSummary): Record<string, unknown> => ({
  id: user.id,
  username: user.username,
  ...(user.name !== undefined ? { name: user.name } : {}),
});

export const registerAuthCommand = (program: Command): void => {
  const auth = program.command("auth").description("Manage X OAuth 2.0 credentials");

  auth
    .command("login")
    .description("Start OAuth 2.0 PKCE flow for X and store tokens locally")
    .option("--port <n>", "Loopback port (must match X Portal callback URL)", "8989")
    .option("--redirect-uri <url>", "Override redirect URI (advanced)")
    .option("--profile <name>", "Profile name (defaults to 'default')")
    .option("--scope <scope...>", "Extra scopes (e.g. media.write)")
    .action(async (flags: LoginFlags) => {
      try {
        const adapter = await buildAdapter(flags);
        logger.info("Launching browser for X authorization…");
        const opts: { profile?: string } = {};
        if (flags.profile !== undefined) opts.profile = flags.profile;
        const creds = await adapter.login(opts);
        logger.info(summarizeCreds(creds), "auth login: success");
      } catch (err) {
        exitFromError(err);
      }
    });

  auth
    .command("status")
    .description("Show locally stored X credentials (no network call, no X_CLIENT_ID required)")
    .option("--profile <name>", "Profile name", "default")
    .action(async (flags: ProfileFlags) => {
      try {
        const store = createTokenStore(defaultCredentialsPath());
        const creds = await store.read(flags.profile);
        if (creds === null) {
          logger.warn(
            { profile: flags.profile ?? "default" },
            "No credentials found. Run `yt2x auth login` first.",
          );
          process.exit(EXIT_NOT_LOGGED_IN);
        }
        logger.info(summarizeCreds(creds), "auth status");
      } catch (err) {
        exitFromError(err);
      }
    });

  auth
    .command("whoami")
    .description("Verify token by calling GET /2/users/me (refreshes if near expiry)")
    .option("--profile <name>", "Profile name", "default")
    .action(async (flags: ProfileFlags) => {
      try {
        const adapter = await buildAdapter();
        const opts: { profile?: string } = {};
        if (flags.profile !== undefined) opts.profile = flags.profile;
        const user = await adapter.whoami(opts);
        logger.info(summarizeUser(user), "auth whoami");
      } catch (err) {
        exitFromError(err);
      }
    });

  auth
    .command("refresh")
    .description("Force a refresh of the access token")
    .option("--profile <name>", "Profile name", "default")
    .action(async (flags: ProfileFlags) => {
      try {
        const adapter = await buildAdapter();
        const opts: { profile?: string } = {};
        if (flags.profile !== undefined) opts.profile = flags.profile;
        const creds = await adapter.refresh(opts);
        logger.info(summarizeCreds(creds), "auth refresh: success");
      } catch (err) {
        exitFromError(err);
      }
    });

  auth
    .command("logout")
    .description("Revoke tokens at X and delete local credentials")
    .option("--profile <name>", "Profile name", "default")
    .action(async (flags: ProfileFlags) => {
      try {
        const adapter = await buildAdapter();
        const opts: { profile?: string } = {};
        if (flags.profile !== undefined) opts.profile = flags.profile;
        await adapter.logout(opts);
        logger.info("auth logout: done");
      } catch (err) {
        exitFromError(err);
      }
    });
};
