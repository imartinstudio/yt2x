import { classifyNetworkError } from "./errors.js";
import type { LlmError } from "@yt2x/core";

const DEFAULT_TIMEOUT_MS = 60_000;

export type Fetcher = typeof fetch;

export const postJson = async (input: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
  provider: string;
  model: string;
}): Promise<Response> => {
  const fetcher = input.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${input.provider} request timed out`)),
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (input.signal !== undefined) {
    if (input.signal.aborted) controller.abort(input.signal.reason);
    else input.signal.addEventListener("abort", () => controller.abort(input.signal?.reason));
  }
  const init: RequestInit = {
    method: "POST",
    headers: { ...input.headers, "content-type": "application/json" },
    body: JSON.stringify(input.body),
    signal: controller.signal,
  };
  try {
    return await fetcher(input.url, init);
  } catch (err: unknown) {
    throw classifyNetworkError({
      provider: input.provider,
      model: input.model,
      cause: err,
    }) satisfies LlmError;
  } finally {
    clearTimeout(timer);
  }
};

export const safeJson = async (resp: Response): Promise<unknown> => {
  const text = await resp.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { _raw: text.slice(0, 4096) };
  }
};
