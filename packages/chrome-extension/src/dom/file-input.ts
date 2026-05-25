/** Assign files to hidden inputs in a way React-controlled X forms accept. */

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

const assignViaInlineScript = (selector: string, blobUrl: string, name: string, type: string): void => {
  const script = document.createElement("script");
  script.textContent = `(${assignFileMainWorld.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(blobUrl)}, ${JSON.stringify(name)}, ${JSON.stringify(type)});`;
  document.documentElement.appendChild(script);
  script.remove();
};

export const assignFileToInput = async (input: HTMLInputElement, file: File): Promise<void> => {
  const normalized = normalizeUploadFile(file);
  assignInIsolatedWorld(input, normalized);

  const token = `yt2x-${Date.now().toString(36)}`;
  input.setAttribute("data-yt2x-upload-target", token);
  const selector = `input[type="file"][data-yt2x-upload-target="${token}"]`;
  const blobUrl = URL.createObjectURL(normalized);

  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: assignFileMainWorld,
        args: [selector, blobUrl, normalized.name, normalized.type],
      });
      return;
    }
    assignViaInlineScript(selector, blobUrl, normalized.name, normalized.type);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);
    input.removeAttribute("data-yt2x-upload-target");
  }
};
