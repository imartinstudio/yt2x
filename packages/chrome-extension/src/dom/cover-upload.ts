import { assignFileToInput } from "./file-input.js";
import { queryAllDeep } from "./dom-query.js";
import { dismissOpenOverlays, waitForMediaUploadComplete } from "./x-insert-actions.js";
import { findTitleField, LOCALE_PATTERNS, isAddMediaContentButton } from "./locators.js";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

const buttonLabel = (button: HTMLButtonElement): string =>
  (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? button.textContent ?? "").trim();

const toButton = (node: Element): HTMLButtonElement | null => {
  if (node instanceof HTMLButtonElement) return node;
  const button = node.closest("button");
  return button instanceof HTMLButtonElement ? button : null;
};

const titleFieldTop = (): number | null => {
  try {
    return findTitleField().getBoundingClientRect().top;
  } catch {
    return null;
  }
};

export const findCoverUploadButton = (): HTMLButtonElement | null => {
  const titleTop = titleFieldTop();
  for (const node of queryAllDeep(document, "button,[role='button']")) {
    const button = toButton(node);
    if (button === null) continue;
    const label = buttonLabel(button);
    if (isAddMediaContentButton(label)) continue;
    if (!LOCALE_PATTERNS.addMedia.test(label)) continue;
    if (titleTop !== null && button.getBoundingClientRect().bottom > titleTop + 80) continue;
    return button;
  }
  return null;
};

const findFileInputNear = (root: ParentNode): HTMLInputElement | null => {
  for (const node of queryAllDeep(root, 'input[type="file"]')) {
    if (node instanceof HTMLInputElement) return node;
  }
  return null;
};

export const findCoverFileInput = (): HTMLInputElement | null => {
  const coverButton = findCoverUploadButton();
  if (coverButton !== null) {
    let node: HTMLElement | null = coverButton;
    for (let depth = 0; depth < 10 && node !== null; depth += 1) {
      const input = findFileInputNear(node);
      if (input !== null) return input;
      node = node.parentElement;
    }
  }

  const titleTop = titleFieldTop();
  if (titleTop === null) return null;
  for (const node of queryAllDeep(document, 'input[type="file"]')) {
    if (!(node instanceof HTMLInputElement)) continue;
    if (node.getBoundingClientRect().bottom <= titleTop + 12) return node;
  }
  return null;
};

const waitForCoverFileInput = async (timeoutMs = 4_000): Promise<HTMLInputElement | null> => {
  const initial = findCoverFileInput();
  if (initial !== null) return initial;

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const input = findCoverFileInput();
      if (input === null) return;
      window.clearTimeout(timeout);
      observer.disconnect();
      resolve(input);
    });
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
};

const clickDialogButton = async (pattern: RegExp): Promise<boolean> => {
  for (const dialog of [...document.querySelectorAll('[role="dialog"]')].reverse()) {
    for (const button of dialog.querySelectorAll("button,[role='button']")) {
      const label = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
      if (!pattern.test(label)) continue;
      (button as HTMLElement).click();
      await wait(200);
      return true;
    }
  }
  return false;
};

export const uploadCoverImage = async (file: File): Promise<void> => {
  dismissOpenOverlays();

  let input = findCoverFileInput();
  if (input === null) {
    const coverButton = findCoverUploadButton();
    if (coverButton !== null) {
      coverButton.click();
      await wait(400);
      input = await waitForCoverFileInput(4_000);
    }
  }

  if (input === null) {
    throw new Error("X Articles cover upload control was not found in the cover hero area.");
  }

  await assignFileToInput(input, file);
  await waitForMediaUploadComplete();
  await clickDialogButton(/^(?:应用|apply)$/iu);
  await wait(300);
  dismissOpenOverlays();
};
