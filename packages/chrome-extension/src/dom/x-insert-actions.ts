import { assignFileToInput, normalizeUploadFile } from "./file-input.js";
import { queryAllDeep } from "./dom-query.js";
import {
  activateInsertionAnchor,
  focusByBlockIndex,
  focusEditorEnd,
  focusInsertionAnchor,
  restoreEditorSelection,
  saveEditorSelection,
  type SavedEditorSelection,
} from "./insertion-anchor.js";
import {
  LOCALE_PATTERNS,
  articleEditor,
  collectToolbarButtonLabels,
  findButtonByName,
  findGenericInsertButton,
  findMenuItemByName,
  findTitleField,
  findToolbarActionButton,
  isTitleComposerElement,
  menuHasInsertItems,
} from "./locators.js";

export type InsertionAnchor = {
  editor: HTMLElement;
  afterText: string;
  blockIndex: number;
  totalBlocks?: number;
};

const restoreInsertionAnchor = (anchor: InsertionAnchor): void => {
  try {
    if (anchor.afterText.trim().length > 0) {
      activateInsertionAnchor(
        anchor.editor,
        anchor.afterText,
        anchor.blockIndex,
        anchor.totalBlocks ?? 0,
      );
      return;
    }
    focusInsertionAnchor(anchor.editor, anchor.afterText, anchor.blockIndex, anchor.totalBlocks ?? 0);
  } catch {
    focusByBlockIndex(anchor.editor, anchor.blockIndex);
  }
};

const draftEditorRoot = (editor: HTMLElement): HTMLElement =>
  editor.closest(".DraftEditor-root") ?? editor;

type EditorSnapshot = {
  signature: string;
  mediaNodes: number;
  blocks: number;
};

const takeEditorSnapshot = (editor: HTMLElement): EditorSnapshot => {
  const root = draftEditorRoot(editor);
  const mediaNodes = root.querySelectorAll(
    [
      "img",
      "video",
      "figure",
      "[role='img']",
      "[data-testid*='tweetPhoto']",
      "[data-testid*='video']",
      "[data-testid*='media']",
      "[data-testid*='card']",
      "[class*='Media']",
      "[class*='media']",
    ].join(","),
  ).length;
  const blocks = root.querySelectorAll("div[data-block='true'],div[data-block]").length;
  return {
    signature: `${mediaNodes}|${blocks}|${root.innerHTML.length}`,
    mediaNodes,
    blocks,
  };
};

const editorMediaChanged = (editor: HTMLElement, before: EditorSnapshot): boolean => {
  const after = takeEditorSnapshot(editor);
  if (after.signature !== before.signature) return true;
  if (after.mediaNodes > before.mediaNodes) return true;
  if (after.blocks > before.blocks) return true;
  return false;
};

const waitForEditorMediaChange = async (
  editor: HTMLElement,
  before: EditorSnapshot,
  timeoutMs: number,
): Promise<boolean> => {
  if (editorMediaChanged(editor, before)) return true;

  const root = draftEditorRoot(editor);
  const changed = await new Promise<boolean>((resolve) => {
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      resolve(editorMediaChanged(editor, before));
    }, timeoutMs);
    const observer = new MutationObserver(() => {
      if (!editorMediaChanged(editor, before)) return;
      window.clearTimeout(timeout);
      observer.disconnect();
      resolve(true);
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  });
  return changed;
};

const dialogHasUploadPreview = (dialog: HTMLElement): boolean => {
  if (dialog.querySelector("img,video,canvas,[role='img'],[data-testid*='media']") !== null) {
    return true;
  }
  const text = dialog.textContent ?? "";
  return /preview|预览|thumbnail|缩略|uploaded|已上传|crop|裁剪/iu.test(text);
};

const waitForDialogUploadPreview = async (dialog: HTMLElement, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dialogHasUploadPreview(dialog)) return true;
    if (!isMediaUploadBusy()) return dialogHasUploadPreview(dialog);
    await wait(150);
  }
  return dialogHasUploadPreview(dialog);
};

const titleFieldBottom = (): number | null => {
  try {
    return findTitleField().getBoundingClientRect().bottom;
  } catch {
    return null;
  }
};

const isCoverFileInput = (input: HTMLInputElement): boolean => {
  const titleBottom = titleFieldBottom();
  if (titleBottom === null) return false;
  return input.getBoundingClientRect().bottom <= titleBottom + 16;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

let verifiedInsertButton: HTMLButtonElement | null = null;

export const dismissOpenOverlays = (): void => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      for (const button of dialog.querySelectorAll("button,[role='button']")) {
        const label = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
        if (/^(?:关闭|取消|close|cancel|done|完成)$/iu.test(label)) {
          (button as HTMLElement).click();
        }
      }
      const closeIcon = dialog.querySelector(
        '[aria-label*="close" i],[aria-label*="关闭" i],[data-testid="app-bar-close"]',
      );
      if (closeIcon instanceof HTMLElement) closeIcon.click();
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  }
};

const buttonLabel = (button: HTMLButtonElement): string =>
  (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? button.textContent ?? "").trim();

const waitForInsertMenu = async (timeoutMs = 4_000): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (menuHasInsertItems()) return true;
    await wait(80);
  }
  return false;
};

const buttonOpensInsertMenu = async (button: HTMLButtonElement): Promise<boolean> => {
  dismissOpenOverlays();
  articleEditor().focus();
  button.click();
  const opened = await waitForInsertMenu(2_000);
  dismissOpenOverlays();
  return opened;
};

const resolveInsertMenuButton = async (): Promise<HTMLButtonElement> => {
  if (verifiedInsertButton !== null) return verifiedInsertButton;

  const direct = findGenericInsertButton();
  if (direct !== null && (await buttonOpensInsertMenu(direct))) {
    verifiedInsertButton = direct;
    return direct;
  }

  const editor = articleEditor();
  const nearby = collectToolbarButtonLabels(editor);
  throw new Error(
    `X Articles insert menu button was not found. Nearby toolbar controls: ${nearby.join(" | ") || "(none)"}`,
  );
};

const openGenericInsertMenu = async (): Promise<void> => {
  const insert = await resolveInsertMenuButton();
  dismissOpenOverlays();
  articleEditor().focus();
  insert.click();
  if (!(await waitForInsertMenu(4_000))) {
    throw new Error("X Articles insert menu did not open.");
  }
};

const clickMenuItem = async (pattern: RegExp, label: string): Promise<void> => {
  const direct = findToolbarActionButton(pattern);
  if (direct !== null) {
    direct.click();
    await wait(200);
    return;
  }
  const item = findMenuItemByName(pattern);
  if (item === null) {
    throw new Error(`X Articles ${label} menu item was not found.`);
  }
  item.click();
  await wait(200);
};

const editorMainRoot = (): ParentNode => {
  const editor = articleEditor();
  return editor.closest("main,article,section,[role='main']") ?? document.body;
};

const isVisibleElement = (element: HTMLElement): boolean => {
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.offsetParent !== null;
};

/** X may use a dialog, popover textarea, or an inline nested code block — never the article title field. */
const canAcceptCodeText = (element: Element): boolean => {
  if (!(element instanceof HTMLElement) || !isVisibleElement(element)) return false;
  if (isTitleComposerElement(element)) return false;
  const editor = articleEditor();
  if (element instanceof HTMLTextAreaElement) {
    return element.closest('[role="dialog"]') !== null || editor.contains(element);
  }
  if (!element.isContentEditable) return false;
  if (element === editor) return false;
  if (element.closest('[role="dialog"]') !== null) return true;
  return editor.contains(element);
};

const findCodeInsertionTarget = (): HTMLElement | null => {
  const editor = articleEditor();

  for (const dialog of [...document.querySelectorAll('[role="dialog"]')].reverse()) {
    for (const node of queryAllDeep(dialog, "textarea,[contenteditable='true']")) {
      if (!(node instanceof HTMLElement) || !canAcceptCodeText(node)) continue;
      return node;
    }
  }

  for (const node of queryAllDeep(editor, '[contenteditable="true"]')) {
    if (!(node instanceof HTMLElement) || !canAcceptCodeText(node)) continue;
    return node;
  }

  const active = document.activeElement;
  if (active instanceof HTMLElement && canAcceptCodeText(active)) return active;

  const focused = editor.querySelector('[contenteditable="true"]:focus-within');
  if (focused instanceof HTMLElement && canAcceptCodeText(focused)) return focused;

  return null;
};

const waitForCodeInsertionTarget = async (timeoutMs = 6_000): Promise<HTMLElement | null> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const target = findCodeInsertionTarget();
    if (target !== null) return target;
    await wait(80);
  }
  return null;
};

const fillCodeTarget = async (target: HTMLElement, code: string): Promise<void> => {
  target.focus();
  if (target instanceof HTMLTextAreaElement) {
    target.value = code;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, code);
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: code }));
  }
  await wait(200);
  if (document.querySelector('[role="dialog"]') !== null) {
    await confirmDialogAction();
  }
};

const openCodeInsertionSurface = async (): Promise<void> => {
  const directCode = findToolbarActionButton(LOCALE_PATTERNS.codeMenu);
  if (directCode !== null) {
    directCode.click();
    await wait(250);
    if (findCodeInsertionTarget() !== null) return;
    dismissOpenOverlays();
  }

  await openGenericInsertMenu();
  await clickMenuItem(LOCALE_PATTERNS.codeMenu, "code");
  await wait(250);
};

export const insertCodeBlock = async (code: string, anchor: InsertionAnchor): Promise<void> => {
  dismissOpenOverlays();
  restoreInsertionAnchor(anchor);
  await openCodeInsertionSurface();

  const target = await waitForCodeInsertionTarget();
  if (target === null) {
    throw new Error(
      "X Articles code insertion surface was not found. The code menu may have changed; try refreshing the draft page.",
    );
  }

  await fillCodeTarget(target, code);
  dismissOpenOverlays();
};

const dialogLooksLikeContentMedia = (dialog: HTMLElement): boolean => {
  if (findDeepFileInput([dialog]) !== null) return !isCoverFileInput(findDeepFileInput([dialog])!);
  const text = dialog.textContent ?? "";
  return /媒体|media|photo|video|照片|视频|upload|choose file|选择文件|裁剪|crop/iu.test(text);
};

const activeMediaDialog = (): HTMLElement | null => {
  const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  );
  for (const dialog of dialogs.reverse()) {
    if (dialogLooksLikeContentMedia(dialog)) return dialog;
  }
  return dialogs.at(-1) ?? null;
};

const contentMediaDialogSearchRoots = (): ParentNode[] => {
  const dialog = activeMediaDialog();
  return dialog === null ? [] : [dialog];
};

const findDeepFileInput = (roots: ParentNode[] = contentMediaDialogSearchRoots()): HTMLInputElement | null => {
  for (const root of roots) {
    for (const node of queryAllDeep(root, 'input[type="file"]')) {
      if (!(node instanceof HTMLInputElement)) continue;
      if (isCoverFileInput(node)) continue;
      return node;
    }
  }
  return null;
};

const waitForDeepFileInput = (
  timeoutMs = 4_000,
  roots: ParentNode[] = contentMediaDialogSearchRoots(),
): Promise<HTMLInputElement | null> =>
  new Promise((resolve) => {
    const initial = findDeepFileInput(roots);
    if (initial !== null) {
      resolve(initial);
      return;
    }

    let timeout = 0;
    const observer = new MutationObserver(() => {
      const input = findDeepFileInput(roots);
      if (input === null) return;
      window.clearTimeout(timeout);
      observer.disconnect();
      resolve(input);
    });

    timeout = window.setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });

const dialogChooseFileButton = (dialog: ParentNode): HTMLButtonElement | null => {
  for (const node of queryAllDeep(dialog, "button,[role='button']")) {
    if (!(node instanceof HTMLButtonElement)) continue;
    const label = (node.getAttribute("aria-label") ?? node.textContent ?? "").trim();
    if (LOCALE_PATTERNS.chooseFile.test(label) || /上传|browse/i.test(label)) return node;
  }
  return null;
};

let chooseFileTriggeredForUpload = false;

const triggerChooseFileInActiveDialogOnce = async (): Promise<HTMLInputElement | null> => {
  if (chooseFileTriggeredForUpload) return findDeepFileInput();
  const dialog = activeMediaDialog();
  if (dialog === null) return null;
  const choose = dialogChooseFileButton(dialog);
  if (choose === null) return null;
  chooseFileTriggeredForUpload = true;
  choose.click();
  return waitForDeepFileInput(4_000, [dialog]);
};

const isMediaUploadInProgress = (): boolean =>
  document.querySelector('[role="progressbar"],[aria-busy="true"]') !== null ||
  [...document.querySelectorAll("*")].some((node) =>
    LOCALE_PATTERNS.uploading.test(node.textContent ?? ""),
  );

const isContentMediaUploadDialogOpen = (): boolean => {
  const dialog = activeMediaDialog();
  if (dialog === null) return false;
  if (findDeepFileInput([dialog]) !== null) return true;
  if (dialogChooseFileButton(dialog) !== null) return true;
  const text = dialog.textContent ?? "";
  return /媒体|media|photo|video|照片|视频|upload|choose file|选择文件/iu.test(text);
};

const openContentMediaUploadSurface = async (): Promise<void> => {
  if (isContentMediaUploadDialogOpen()) return;

  const openViaAddMediaToolbar = async (): Promise<boolean> => {
    const root = editorMainRoot();
    const addMedia = findButtonByName(LOCALE_PATTERNS.insertAddMedia, root);
    if (addMedia === null) return false;
    addMedia.click();
    await wait(450);
    const mediaItem = findMenuItemByName(LOCALE_PATTERNS.mediaMenu);
    if (mediaItem !== null) {
      mediaItem.click();
      await wait(450);
    }
    return isContentMediaUploadDialogOpen();
  };

  if (await openViaAddMediaToolbar()) return;

  await openGenericInsertMenu();
  const mediaItem = findMenuItemByName(LOCALE_PATTERNS.mediaMenu);
  if (mediaItem === null) {
    throw new Error("X Articles media menu item was not found.");
  }
  mediaItem.click();
  await wait(450);

  if (!isContentMediaUploadDialogOpen()) {
    throw new Error("X Articles content media upload dialog did not open.");
  }
};

const clickDialogButton = async (pattern: RegExp, dialog?: HTMLElement | null): Promise<boolean> => {
  const roots =
    dialog instanceof HTMLElement
      ? [dialog]
      : [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].reverse();
  for (const root of roots) {
    for (const button of root.querySelectorAll("button,[role='button']")) {
      const label = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
      if (!pattern.test(label)) continue;
      (button as HTMLElement).click();
      await wait(200);
      return true;
    }
  }
  return false;
};

const finishContentMediaUpload = async (
  anchor: InsertionAnchor,
  dialog: HTMLElement,
): Promise<void> => {
  const editor = anchor.editor;
  const before = takeEditorSnapshot(editor);

  await waitForMediaUploadComplete(30_000);
  await wait(800);

  if (await waitForEditorMediaChange(editor, before, 4_000)) return;

  if (/编辑媒体|edit media/i.test(dialog.textContent ?? "")) {
    await clickDialogButton(/^(?:应用|apply)$/iu, dialog);
    await wait(800);
    await waitForMediaUploadComplete(20_000);
    if (await waitForEditorMediaChange(editor, before, 4_000)) return;
  }

  // Playwright path: upload completes at caret; give Draft.js time to insert the block.
  await wait(2_500);
  if (await waitForEditorMediaChange(editor, before, 5_000)) return;

  if (dialogHasUploadPreview(dialog)) {
    await clickDialogButton(/^(?:插入|insert)$/iu, dialog);
    await wait(1_000);
    await waitForMediaUploadComplete(15_000);
    if (await waitForEditorMediaChange(editor, before, 6_000)) return;

    await clickDialogButton(/^(?:完成|done|确认|ok|保存|save)$/iu, dialog);
    await wait(800);
    if (await waitForEditorMediaChange(editor, before, 4_000)) return;
  }

  throw new Error("X Articles content media was not inserted into the editor body.");
};

const listDialogFileInputs = (dialog: HTMLElement): HTMLInputElement[] =>
  queryAllDeep(dialog, 'input[type="file"]').filter(
    (node): node is HTMLInputElement =>
      node instanceof HTMLInputElement && !isCoverFileInput(node),
  );

const uploadFileThroughDialog = async (dialog: HTMLElement, file: File): Promise<void> => {
  const normalized = normalizeUploadFile(file);
  let inputs = listDialogFileInputs(dialog);
  if (inputs.length === 0) {
    const waited = await waitForDeepFileInput(6_000, [dialog]);
    if (waited !== null && !isCoverFileInput(waited)) inputs = [waited];
  }

  if (inputs.length === 0) {
    throw new Error("X Articles content media upload control was not found inside the insert dialog.");
  }

  for (const input of inputs) {
    await assignFileToInput(input, normalized);
    await wait(600);
    if (await waitForDialogUploadPreview(dialog, 12_000)) return;
  }

  throw new Error("X Articles did not accept the media file in the upload dialog.");
};

const pasteMediaFileAtCursor = async (file: File): Promise<boolean> => {
  const isVideo = /^video\//iu.test(file.type) || /\.(?:mp4|webm|mov|m4v)$/iu.test(file.name);
  if (isVideo) return false;

  const type = file.type || "image/png";
  try {
    await navigator.clipboard.write([new ClipboardItem({ [type]: file })]);
  } catch {
    return false;
  }
  await wait(120);
  return document.execCommand("paste");
};

const dropFileOnEditor = (editor: HTMLElement, file: File): void => {
  const root = draftEditorRoot(editor);
  const transfer = new DataTransfer();
  transfer.items.add(file);
  for (const type of ["dragenter", "dragover", "drop"] as const) {
    root.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  }
};

const placeInsertionCaret = (anchor: InsertionAnchor): SavedEditorSelection | null => {
  const editor = anchor.editor;
  editor.focus();
  if (anchor.afterText.trim().length > 0) {
    activateInsertionAnchor(editor, anchor.afterText, anchor.blockIndex, anchor.totalBlocks ?? 0);
  } else {
    focusByBlockIndex(editor, anchor.blockIndex);
  }
  return saveEditorSelection(editor);
};

const confirmDialogAction = async (): Promise<void> => {
  for (const dialog of [...document.querySelectorAll('[role="dialog"]')].reverse()) {
    for (const button of dialog.querySelectorAll("button,[role='button']")) {
      const label = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
      if (/^(?:保存|插入|完成|确认|apply|save|insert|done|ok)$/iu.test(label)) {
        (button as HTMLElement).click();
        await wait(200);
        return;
      }
    }
  }
};

export const insertContentMedia = async (file: File, anchor: InsertionAnchor): Promise<void> => {
  chooseFileTriggeredForUpload = false;
  const editor = anchor.editor;
  const before = takeEditorSnapshot(editor);

  if (activeMediaDialog() !== null) {
    dismissOpenOverlays();
    await wait(200);
  }

  let savedSelection = placeInsertionCaret(anchor);
  await wait(250);

  await openContentMediaUploadSurface();

  const dialog = activeMediaDialog();
  if (dialog === null) {
    throw new Error("X Articles content media upload dialog was not found.");
  }

  restoreEditorSelection(savedSelection);
  editor.focus();
  await uploadFileThroughDialog(dialog, normalizeUploadFile(file));

  try {
    restoreEditorSelection(savedSelection);
    await finishContentMediaUpload(anchor, dialog);
  } catch (primaryError) {
    restoreEditorSelection(savedSelection);
    editor.focus();
    const pasted = await pasteMediaFileAtCursor(file);
    if (pasted && (await waitForEditorMediaChange(editor, before, 5_000))) {
      dismissOpenOverlays();
      return;
    }
    restoreEditorSelection(savedSelection);
    dropFileOnEditor(editor, file);
    if (await waitForEditorMediaChange(editor, before, 5_000)) {
      dismissOpenOverlays();
      return;
    }
    savedSelection = placeInsertionCaret(anchor);
    focusEditorEnd(editor);
    dropFileOnEditor(editor, file);
    if (await waitForEditorMediaChange(editor, before, 5_000)) {
      dismissOpenOverlays();
      return;
    }
    throw primaryError;
  }

  if (activeMediaDialog() !== null) {
    await clickDialogButton(/^(?:完成|done|确认|ok|关闭|close)$/iu, activeMediaDialog());
    await wait(300);
  }
  restoreEditorSelection(savedSelection);
  dismissOpenOverlays();
};

export const insertDivider = async (anchor?: InsertionAnchor): Promise<boolean> => {
  dismissOpenOverlays();
  if (anchor !== undefined) restoreInsertionAnchor(anchor);
  try {
    const direct = findToolbarActionButton(LOCALE_PATTERNS.dividerMenu);
    if (direct !== null) {
      direct.click();
      await wait(150);
      dismissOpenOverlays();
      return true;
    }
    await openGenericInsertMenu();
    const item = findMenuItemByName(LOCALE_PATTERNS.dividerMenu);
    if (item === null) return false;
    item.click();
    await wait(150);
    dismissOpenOverlays();
    return true;
  } catch {
    dismissOpenOverlays();
    return false;
  }
};

const elementIsVisible = (element: HTMLElement): boolean => {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

const isMediaUploadBusy = (): boolean => {
  const progressbar = document.querySelector('[role="progressbar"]');
  if (progressbar instanceof HTMLElement && elementIsVisible(progressbar)) return true;

  for (const node of document.querySelectorAll('[aria-busy="true"]')) {
    if (node instanceof HTMLElement && elementIsVisible(node)) return true;
  }

  for (const node of document.querySelectorAll("span,div,p,button,label")) {
    if (!(node instanceof HTMLElement) || !elementIsVisible(node)) continue;
    const text = (node.textContent ?? "").trim();
    if (text.length === 0 || text.length > 48) continue;
    if (LOCALE_PATTERNS.uploading.test(text)) return true;
  }

  return false;
};

export const waitForMediaUploadComplete = async (timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isMediaUploadBusy()) return;
    await wait(150);
  }
};

export const resetInsertButtonCache = (): void => {
  verifiedInsertButton = null;
};
