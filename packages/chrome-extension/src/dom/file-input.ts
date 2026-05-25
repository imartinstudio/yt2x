/** Assign files to hidden inputs in a way React-controlled X forms accept. */

export const ASSIGN_FILE_MAIN_WORLD_MESSAGE = "yt2x:assign-file-main-world";
export const TRIGGER_FILE_UPLOAD_MAIN_WORLD_MESSAGE = "yt2x:trigger-file-upload-main-world";

export type AssignFileMainWorldRequest = {
  type: typeof ASSIGN_FILE_MAIN_WORLD_MESSAGE;
  selector: string;
  blobUrl: string;
  name: string;
  mimeType: string;
};

export type AssignFileMainWorldResponse = {
  ok: boolean;
  error?: string;
};

export type TriggerFileUploadMainWorldRequest = {
  type: typeof TRIGGER_FILE_UPLOAD_MAIN_WORLD_MESSAGE;
  selector: string;
  blobUrl: string;
  name: string;
  mimeType: string;
};

export type TriggerFileUploadMainWorldResponse = AssignFileMainWorldResponse & {
  intercepted?: boolean;
};

export const normalizeUploadFile = (file: File): File => {
  if (file.type.length > 0) return file;
  const lower = file.name.toLowerCase();
  if (/\.(?:mp4|m4v|webm|mov)$/iu.test(lower)) {
    return new File([file], file.name, { type: "video/mp4" });
  }
  if (/\.(?:jpe?g)$/iu.test(lower)) {
    return new File([file], file.name, { type: "image/jpeg" });
  }
  if (/\.webp$/iu.test(lower)) {
    return new File([file], file.name, { type: "image/webp" });
  }
  if (/\.gif$/iu.test(lower)) {
    return new File([file], file.name, { type: "image/gif" });
  }
  return new File([file], file.name, { type: "image/png" });
};

const assignInIsolatedWorld = (input: HTMLInputElement, file: File): void => {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const files = transfer.files;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
  if (descriptor?.set !== undefined) {
    descriptor.set.call(input, files);
  } else {
    input.files = files;
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

/** Runs in the page MAIN world (not the content-script isolated world). */
export const assignFileMainWorld = (
  selector: string,
  blobUrl: string,
  name: string,
  type: string,
): void => {
  void (async () => {
    const input = document.querySelector(selector);
    if (!(input instanceof HTMLInputElement)) return;
    try {
      const response = await fetch(blobUrl);
      const blob = await response.blob();
      const upload = new File([blob], name, { type });
      const transfer = new DataTransfer();
      transfer.items.add(upload);
      const files = transfer.files;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
      if (descriptor?.set !== undefined) {
        descriptor.set.call(input, files);
      } else {
        input.files = files;
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {
      // Page context assignment failed; caller will surface upload errors.
    }
  })();
};

/** Trigger a React-owned upload action while replacing the native chooser with the supplied file. */
export const triggerFileUploadMainWorld = async (
  selector: string,
  blobUrl: string,
  name: string,
  type: string,
): Promise<boolean> => {
  const action =
    document.querySelector(selector) ??
    [...document.querySelectorAll("[role='menuitem'],[role='option']")].find((node) =>
      /^(?:media|媒体)$/iu.test((node.textContent ?? "").trim()),
    );
  if (!(action instanceof HTMLElement)) return false;

  const blob = await (await fetch(blobUrl)).blob();
  const upload = new File([blob], name, { type });
  const nativeClick = HTMLInputElement.prototype.click;
  const nativeShowPicker = HTMLInputElement.prototype.showPicker;
  const observedInputs = new Set<HTMLInputElement>();
  let intercepted = false;
  let resolveIntercepted: ((value: boolean) => void) | null = null;
  const interceptedPromise = new Promise<boolean>((resolve) => {
    resolveIntercepted = resolve;
  });

  const assign = (input: HTMLInputElement): void => {
    if (intercepted) return;
    const transfer = new DataTransfer();
    transfer.items.add(upload);
    const files = transfer.files;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
    if (descriptor?.set !== undefined) {
      descriptor.set.call(input, files);
    } else {
      input.files = files;
    }
    intercepted = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    resolveIntercepted?.(true);
  };

  const interceptDefaultActivation = (event: Event): void => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    assign(input);
  };

  const observeInput = (input: HTMLInputElement): void => {
    if (input.type !== "file" || observedInputs.has(input)) return;
    observedInputs.add(input);
    input.addEventListener("click", interceptDefaultActivation, true);
  };

  const observeInputsWithin = (root: ParentNode): void => {
    if (root instanceof HTMLInputElement) observeInput(root);
    root.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach(observeInput);
  };

  observeInputsWithin(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) observeInputsWithin(node);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  HTMLInputElement.prototype.click = function (...args: Parameters<HTMLInputElement["click"]>): void {
    if (this.type === "file") {
      assign(this);
      return;
    }
    nativeClick.apply(this, args);
  };
  HTMLInputElement.prototype.showPicker = function (): void {
    if (this.type === "file") {
      assign(this);
      return;
    }
    nativeShowPicker.call(this);
  };

  try {
    action.click();
    return await Promise.race([
      interceptedPromise,
      new Promise<boolean>((resolve) => {
        window.setTimeout(() => resolve(false), 2_000);
      }),
    ]);
  } finally {
    observer.disconnect();
    observedInputs.forEach((input) => {
      input.removeEventListener("click", interceptDefaultActivation, true);
    });
    HTMLInputElement.prototype.click = nativeClick;
    HTMLInputElement.prototype.showPicker = nativeShowPicker;
  }
};

export const requestMainWorldFileAssignment = async (
  selector: string,
  blobUrl: string,
  name: string,
  mimeType: string,
): Promise<void> => {
  const request: AssignFileMainWorldRequest = {
    type: ASSIGN_FILE_MAIN_WORLD_MESSAGE,
    selector,
    blobUrl,
    name,
    mimeType,
  };
  const response = (await chrome.runtime.sendMessage(request)) as
    | AssignFileMainWorldResponse
    | undefined;
  if (response?.ok !== true) {
    throw new Error(response?.error ?? "Failed to assign an X Articles upload in the page context.");
  }
};

export const assignFileToInput = async (input: HTMLInputElement, file: File): Promise<void> => {
  const normalized = normalizeUploadFile(file);
  assignInIsolatedWorld(input, normalized);

  const token = `yt2x-${Date.now().toString(36)}`;
  input.setAttribute("data-yt2x-upload-target", token);
  const selector = `input[type="file"][data-yt2x-upload-target="${token}"]`;
  const blobUrl = URL.createObjectURL(normalized);

  try {
    await requestMainWorldFileAssignment(selector, blobUrl, normalized.name, normalized.type);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);
    input.removeAttribute("data-yt2x-upload-target");
  }
};

export const uploadFileThroughAction = async (
  action: HTMLElement,
  file: File,
): Promise<boolean> => {
  const normalized = normalizeUploadFile(file);
  const token = `yt2x-action-${Date.now().toString(36)}`;
  action.setAttribute("data-yt2x-upload-action", token);
  const selector = `[data-yt2x-upload-action="${token}"]`;
  const blobUrl = URL.createObjectURL(normalized);
  const request: TriggerFileUploadMainWorldRequest = {
    type: TRIGGER_FILE_UPLOAD_MAIN_WORLD_MESSAGE,
    selector,
    blobUrl,
    name: normalized.name,
    mimeType: normalized.type,
  };

  try {
    const response = (await chrome.runtime.sendMessage(request)) as
      | TriggerFileUploadMainWorldResponse
      | undefined;
    if (response?.ok !== true) {
      throw new Error(response?.error ?? "Failed to invoke the X Articles media upload action.");
    }
    return response.intercepted === true;
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);
    action.removeAttribute("data-yt2x-upload-action");
  }
};
