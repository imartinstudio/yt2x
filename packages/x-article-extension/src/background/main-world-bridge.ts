import {
  ASSIGN_FILE_MAIN_WORLD_MESSAGE,
  TRIGGER_FILE_UPLOAD_MAIN_WORLD_MESSAGE,
  assignFileMainWorld,
  triggerFileUploadMainWorld,
  type AssignFileMainWorldRequest,
  type AssignFileMainWorldResponse,
  type TriggerFileUploadMainWorldRequest,
  type TriggerFileUploadMainWorldResponse,
} from "../dom/file-input.js";
import { INJECT_DRAFT_WRITER_MESSAGE } from "../shared/main-world-messages.js";

const isInjectDraftWriterRequest = (message: unknown): message is { type: typeof INJECT_DRAFT_WRITER_MESSAGE } =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: string }).type === INJECT_DRAFT_WRITER_MESSAGE;

const isAssignFileRequest = (message: unknown): message is AssignFileMainWorldRequest => {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as Partial<AssignFileMainWorldRequest>;
  return (
    candidate.type === ASSIGN_FILE_MAIN_WORLD_MESSAGE &&
    typeof candidate.selector === "string" &&
    typeof candidate.blobUrl === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.mimeType === "string"
  );
};

const isTriggerFileUploadRequest = (message: unknown): message is TriggerFileUploadMainWorldRequest => {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as Partial<TriggerFileUploadMainWorldRequest>;
  return (
    candidate.type === TRIGGER_FILE_UPLOAD_MAIN_WORLD_MESSAGE &&
    typeof candidate.selector === "string" &&
    typeof candidate.blobUrl === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.mimeType === "string"
  );
};

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isInjectDraftWriterRequest(message)) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, error: "Could not resolve the X Articles browser tab for MAIN world import." });
      return false;
    }
    void chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        files: ["main-world/draft-writer.js"],
      })
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (!isAssignFileRequest(message) && !isTriggerFileUploadRequest(message)) return false;

  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    const response: AssignFileMainWorldResponse = {
      ok: false,
      error: "Could not resolve the X Articles browser tab for media upload.",
    };
    sendResponse(response);
    return false;
  }

  const injection =
    message.type === ASSIGN_FILE_MAIN_WORLD_MESSAGE
      ? chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: assignFileMainWorld,
          args: [message.selector, message.blobUrl, message.name, message.mimeType],
        })
      : chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: triggerFileUploadMainWorld,
          args: [message.selector, message.blobUrl, message.name, message.mimeType],
        });

  void injection
    .then(
      (results) => {
        const response: TriggerFileUploadMainWorldResponse =
          message.type === TRIGGER_FILE_UPLOAD_MAIN_WORLD_MESSAGE
            ? { ok: true, intercepted: results[0]?.result === true }
            : { ok: true };
        sendResponse(response);
      },
      (error: unknown) => {
        const response: AssignFileMainWorldResponse = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        sendResponse(response);
      },
    );
  return true;
});
