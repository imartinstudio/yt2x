import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { XAuthError } from "@yt2x/core";

export type CallbackResult =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string; errorDescription?: string; state?: string };

export type LoopbackServerOptions = {
  port: number;
  /** 默认 "/callback" */
  path?: string;
  /** 默认 "127.0.0.1"；调用方应坚持环回地址 */
  host?: string;
  signal?: AbortSignal;
  /** 完成 / 失败后在浏览器展示的 HTML（已带最小 CSS） */
  successHtml?: string;
  failureHtml?: string;
};

export type LoopbackServerHandle = {
  result: Promise<CallbackResult>;
  close: () => Promise<void>;
};

const DEFAULT_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>yt2x – Signed in</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#0f172a;background:#f8fafc}
.card{padding:32px 40px;border-radius:16px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.08);max-width:420px;text-align:center}
h1{margin:0 0 12px;font-size:22px}p{margin:0;color:#475569;line-height:1.5}</style></head>
<body><div class="card"><h1>✓ Signed in</h1><p>You can close this window and return to your terminal.</p></div></body></html>`;

const DEFAULT_FAILURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>yt2x – Sign-in failed</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#0f172a;background:#fef2f2}
.card{padding:32px 40px;border-radius:16px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.08);max-width:480px;text-align:center}
h1{margin:0 0 12px;font-size:22px;color:#b91c1c}p{margin:0;color:#475569;line-height:1.5}</style></head>
<body><div class="card"><h1>× Sign-in failed</h1><p>Return to your terminal for details, then run <code>yt2x auth login</code> again.</p></div></body></html>`;

const sendHtml = (res: ServerResponse, html: string, status = 200): void => {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
};

const parseSearchParams = (req: IncomingMessage): URLSearchParams => {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  return url.searchParams;
};

/**
 * 启动一次性 HTTP loopback server，等待 OAuth 回调。
 *
 *  - 仅监听 host:port 一个路径（默认 /callback），其它路径返回 404。
 *  - 拿到 code / state 后立刻关闭 server，避免 hanging port。
 *  - 任意时刻 signal.abort 会立即关闭 server，并以 USER_CANCELLED 结束 result。
 *  - 端口占用 → 抛 XAuthError('PORT_IN_USE')，CLI 据此提示用户用 --port。
 */
export const startLoopbackServer = async (
  opts: LoopbackServerOptions,
): Promise<LoopbackServerHandle> => {
  const host = opts.host ?? "127.0.0.1";
  const callbackPath = opts.path ?? "/callback";
  const successHtml = opts.successHtml ?? DEFAULT_SUCCESS_HTML;
  const failureHtml = opts.failureHtml ?? DEFAULT_FAILURE_HTML;

  let resolveResult!: (value: CallbackResult) => void;
  const result = new Promise<CallbackResult>((resolve) => {
    resolveResult = resolve;
  });

  let settled = false;
  const settle = (value: CallbackResult): void => {
    if (settled) return;
    settled = true;
    resolveResult(value);
  };

  const server: Server = createServer((req, res) => {
    if (!req.url) {
      sendHtml(res, failureHtml, 400);
      return;
    }
    const url = new URL(req.url, `http://${host}:${opts.port}`);
    if (url.pathname !== callbackPath) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const params = parseSearchParams(req);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    const errorDescription = params.get("error_description");

    if (error !== null) {
      sendHtml(res, failureHtml, 400);
      const failure: CallbackResult =
        errorDescription !== null
          ? state !== null
            ? { ok: false, error, errorDescription, state }
            : { ok: false, error, errorDescription }
          : state !== null
            ? { ok: false, error, state }
            : { ok: false, error };
      settle(failure);
      return;
    }
    if (code === null || state === null) {
      sendHtml(res, failureHtml, 400);
      settle({ ok: false, error: "missing_code_or_state" });
      return;
    }
    sendHtml(res, successHtml, 200);
    settle({ ok: true, code, state });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === "EADDRINUSE") {
        reject(
          new XAuthError(
            "PORT_IN_USE",
            `Loopback port ${opts.port} is in use. Pick another with --port and update the X Portal callback URL accordingly.`,
          ),
        );
      } else {
        reject(err);
      }
    };
    server.once("error", onError);
    server.listen(opts.port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  // 安全断言：实际监听的端口与请求一致（避免 0 端口被分配但调用方误用）
  const addr = server.address() as AddressInfo | null;
  if (addr === null || addr.port !== opts.port) {
    server.close();
    throw new XAuthError(
      "PORT_IN_USE",
      `Expected to bind ${opts.port}, got ${addr?.port ?? "unknown"}`,
    );
  }

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  const onAbort = (): void => {
    settle({ ok: false, error: "user_cancelled" });
    void close();
  };
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  // result 一旦结算就自动 close，避免调用方忘记
  void result.then(() => {
    void close();
  });

  return { result, close };
};
