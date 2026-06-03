import type { MainWorldWritePayload } from "../import/markdown-to-draft-payload.js";

import { CHANNEL_FROM_MAIN, CHANNEL_TO_MAIN } from "../shared/main-world-messages.js";

/** Must match `INJECT_DRAFT_WRITER_MESSAGE` in shared/main-world-messages.ts (local binding for sendMessage). */
const INJECT_DRAFT_WRITER_REQUEST = "yt2x:inject-draft-writer" as const;

type MainWorldSummary = {
  atomicOk: number;
  atomicFail: number;
  imgOk: number;
  imgFail: number;
  imageErrors: Array<{ index: number; marker: string; source: string | null; error: string }>;
  markersCleaned: number;
};

export type MainWorldImportResult = {
  summary: MainWorldSummary;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

const pingMainWorld = (): Promise<boolean> =>
  new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      resolve(false);
    }, 400);
    const listener = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const message = event.data as { source?: string; kind?: string };
      if (message?.source !== CHANNEL_FROM_MAIN || message.kind !== "ready") return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", listener);
      resolve(true);
    };
    window.addEventListener("message", listener);
    window.postMessage({ source: CHANNEL_TO_MAIN, kind: "ready?" }, "*");
  });

const ensureMainWorldWriter = async (): Promise<void> => {
  if (await pingMainWorld()) return;

  const response = (await chrome.runtime.sendMessage({ type: INJECT_DRAFT_WRITER_REQUEST })) as
    | { ok?: boolean; error?: string }
    | undefined;
  if (response?.ok !== true) {
    throw new Error(response?.error ?? "Failed to inject the yt2x MAIN world draft writer.");
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await pingMainWorld()) return;
    await wait(120);
  }
  throw new Error("yt2x MAIN world draft writer did not become ready.");
};

export const runMainWorldImport = async (
  payload: MainWorldWritePayload,
  options: { onProgress?: (message: string) => void } = {},
): Promise<MainWorldImportResult> => {
  await ensureMainWorldWriter();

  const imageFilesByToken = new Map(payload.imageFiles.map((file) => [file.token, file]));

  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const message = event.data as {
        source?: string;
        kind?: string;
        text?: string;
        summary?: MainWorldSummary;
        error?: string;
        requestId?: string;
        token?: string;
      };
      if (message?.source !== CHANNEL_FROM_MAIN) return;

      if (message.kind === "progress" && typeof message.text === "string") {
        options.onProgress?.(message.text);
        return;
      }

      if (message.kind === "file-request" && typeof message.requestId === "string") {
        const token = message.token ?? "";
        const file = imageFilesByToken.get(token);
        window.postMessage(
          {
            source: CHANNEL_TO_MAIN,
            kind: "file-response",
            requestId: message.requestId,
            ...(file
              ? { ok: true, file }
              : { ok: false, error: `Prepared image token was not found: ${token}` }),
          },
          "*",
        );
        return;
      }

      if (message.kind === "done" && message.summary) {
        window.removeEventListener("message", listener);
        resolve({ summary: message.summary });
        return;
      }

      if (message.kind === "cancelled") {
        window.removeEventListener("message", listener);
        reject(new Error(message.error ?? "Import stopped by user."));
        return;
      }

      if (message.kind === "error") {
        window.removeEventListener("message", listener);
        reject(new Error(message.error ?? "MAIN world import failed."));
      }
    };

    window.addEventListener("message", listener);
    window.postMessage(
      {
        source: CHANNEL_TO_MAIN,
        kind: "run",
        payload: {
          title: payload.title,
          blocks: payload.blocks,
          plan: payload.plan,
          html: payload.html,
          plain: payload.plain,
          markerPrefix: payload.markerPrefix,
          imageFiles: payload.imageFiles,
        },
      },
      "*",
    );
  });
};
