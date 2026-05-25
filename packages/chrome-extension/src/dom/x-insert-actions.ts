import { assignFileToInput, normalizeUploadFile, uploadFileThroughAction } from "./file-input.js";
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
  findToolbarActionButton,
  isTitleComposerElement,
  menuHasInsertItems,
} from "./locators.js";

export type InsertionAnchor = {
  editor: HTMLElement;
  afterText: string;
  blockIndex: number;
  totalBlocks?: number;
  appendAtEnd?: boolean;
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

const liveArticleEditor = (fallback: HTMLElement): HTMLElement => {
  try {
    return articleEditor();
  } catch {
    return fallback;
  }
};

type EditorSnapshot = {
  signature: string;
  mediaNodes: number;
  blocks: number;
};

const takeEditorSnapshot = (editor: HTMLElement): EditorSnapshot => {
  const root = draftEditorRoot(liveArticleEditor(editor));
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
  return after.mediaNodes > before.mediaNodes;
};

const waitForEditorMediaChange = async (
  editor: HTMLElement,
  before: EditorSnapshot,
  timeoutMs: number,
): Promise<boolean> => {
  if (editorMediaChanged(editor, before)) return true;

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
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
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

export const isCoverFileInput = (input: HTMLInputElement): boolean => {
  const root = input.parentElement;
  if (root === null) return false;
  for (const node of queryAllDeep(root, "button,[role='button']")) {
    const label = (node.getAttribute("aria-label") ?? node.textContent ?? "").trim();
    if (LOCALE_PATTERNS.addMedia.test(label)) return true;
  }
  return false;
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
  return null;
};

const contentMediaDialogSearchRoots = (): ParentNode[] => {
  const dialog = activeMediaDialog();
  return dialog === null ? [editorMainRoot()] : [dialog, editorMainRoot()];
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

const isContentMediaUploadDialogOpen = (): boolean => {
  const dialog = activeMediaDialog();
  if (dialog === null) return false;
  if (findDeepFileInput([dialog]) !== null) return true;
  if (dialogChooseFileButton(dialog) !== null) return true;
  const text = dialog.textContent ?? "";
  return /媒体|media|photo|video|照片|视频|upload|choose file|选择文件/iu.test(text);
};

const openContentMediaUploadSurface = async (): Promise<void> => {
  if (isContentMediaUploadDialogOpen() || findDeepFileInput() !== null) return;

  const openViaAddMediaToolbar = async (): Promise<boolean> => {
    const root = editorMainRoot();
    const addMedia = findButtonByName(LOCALE_PATTERNS.insertAddMedia, root);
    if (addMedia === null) return false;
    addMedia.click();
    await wait(450);
    if (findDeepFileInput() !== null) return true;
    const mediaItem = findMenuItemByName(LOCALE_PATTERNS.mediaMenu);
    if (mediaItem !== null) {
      mediaItem.click();
      await wait(450);
    }
    return isContentMediaUploadDialogOpen() || findDeepFileInput() !== null;
  };

  if (await openViaAddMediaToolbar()) return;

  await openGenericInsertMenu();
  const mediaItem = findMenuItemByName(LOCALE_PATTERNS.mediaMenu);
  if (mediaItem === null) {
    throw new Error("X Articles media menu item was not found.");
  }
  mediaItem.click();
  await wait(450);

  if (!isContentMediaUploadDialogOpen() && findDeepFileInput() === null) {
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

const uploadFileThroughSurface = async (dialog: HTMLElement | null, file: File): Promise<void> => {
  const normalized = normalizeUploadFile(file);
  let inputs = dialog === null ? [] : listDialogFileInputs(dialog);
  if (inputs.length === 0) {
    const input = findDeepFileInput();
    if (input !== null) inputs = [input];
  }
  if (inputs.length === 0) {
    const roots = dialog === null ? contentMediaDialogSearchRoots() : [dialog, editorMainRoot()];
    const waited = await waitForDeepFileInput(6_000, roots);
    if (waited !== null && !isCoverFileInput(waited)) inputs = [waited];
  }

  if (inputs.length === 0) {
    throw new Error("X Articles content media upload control was not found after opening Add media content.");
  }

  for (const input of inputs) {
    await assignFileToInput(input, normalized);
    await wait(600);
    if (dialog === null || (await waitForDialogUploadPreview(dialog, 12_000))) return;
  }

  throw new Error("X Articles did not accept the media file in the upload dialog.");
};

const uploadFileThroughMediaAction = async (file: File): Promise<boolean> => {
  const addMedia = findButtonByName(LOCALE_PATTERNS.insertAddMedia, editorMainRoot());
  if (addMedia === null) return false;
  addMedia.click();
  await wait(250);
  const mediaItem = findMenuItemByName(LOCALE_PATTERNS.mediaMenu);
  if (mediaItem === null) return false;
  return uploadFileThroughAction(mediaItem, file);
};

const isVideoFile = (file: File): boolean =>
  /^video\//iu.test(file.type) || /\.(?:mp4|webm|mov|m4v)$/iu.test(file.name);

export const prepareClipboardImage = async (file: File): Promise<Blob> => {
  if (file.type === "image/png") return file;

  const bitmap = await createImageBitmap(file);
  try {
    const maxDimension = 2_000;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("X Articles image clipboard preparation failed: canvas is unavailable.");
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob === null) {
          reject(new Error("X Articles image clipboard preparation failed: PNG conversion failed."));
          return;
        }
        resolve(blob);
      }, "image/png");
    });
  } finally {
    bitmap.close();
  }
};

export const precedingContentBlockIndex = (blockIndex: number): number =>
  Math.max(0, blockIndex - 1);

const placeMediaInsertionCaret = (anchor: InsertionAnchor): SavedEditorSelection | null => {
  const editor = anchor.editor;
  editor.focus();
  if (anchor.appendAtEnd === true) {
    focusEditorEnd(liveArticleEditor(editor));
    return saveEditorSelection(liveArticleEditor(editor));
  }
  if (anchor.afterText.trim().length > 0) {
    activateInsertionAnchor(editor, anchor.afterText, anchor.blockIndex, anchor.totalBlocks ?? 0);
  } else {
    focusByBlockIndex(editor, precedingContentBlockIndex(anchor.blockIndex));
  }
  return saveEditorSelection(editor);
};

const pasteImageAtCaret = async (file: File): Promise<void> => {
  const png = await prepareClipboardImage(file);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  await wait(120);
  if (!document.execCommand("paste")) {
    throw new Error("X Articles rejected the clipboard image paste command.");
  }
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
  const editor = anchor.editor;
  const normalized = normalizeUploadFile(file);

  dismissOpenOverlays();
  await wait(200);

  const savedSelection = placeMediaInsertionCaret(anchor);
  await wait(250);
  const before = takeEditorSnapshot(editor);

  if (!isVideoFile(normalized)) {
    restoreEditorSelection(savedSelection);
    await pasteImageAtCaret(normalized);
    if (!(await waitForEditorMediaChange(editor, before, 90_000))) {
      throw new Error("X Articles did not insert the clipboard PNG into the editor body.");
    }
    dismissOpenOverlays();
    return;
  }

  restoreEditorSelection(savedSelection);
  await wait(100);
  if (await uploadFileThroughMediaAction(normalized)) {
    await waitForMediaUploadComplete(30_000);
    const dialog = activeMediaDialog();
    if (dialog !== null) {
      await finishContentMediaUpload(anchor, dialog);
    } else if (!(await waitForEditorMediaChange(editor, before, 8_000))) {
      throw new Error("X Articles accepted the media file but did not insert it into the editor body.");
    }
    dismissOpenOverlays();
    return;
  }
  if (await waitForEditorMediaChange(editor, before, 8_000)) {
    dismissOpenOverlays();
    return;
  }

  restoreEditorSelection(savedSelection);
  await openContentMediaUploadSurface();

  const dialog = activeMediaDialog();
  restoreEditorSelection(savedSelection);
  editor.focus();
  try {
    await uploadFileThroughSurface(dialog, normalized);
  } catch (error: unknown) {
    if (await waitForEditorMediaChange(editor, before, 15_000)) {
      dismissOpenOverlays();
      return;
    }
    throw error;
  }

  restoreEditorSelection(savedSelection);
  if (dialog !== null) {
    await finishContentMediaUpload(anchor, dialog);
  } else {
    await waitForMediaUploadComplete(30_000);
    if (!(await waitForEditorMediaChange(editor, before, 6_000))) {
      throw new Error("X Articles content media was not inserted into the editor body.");
    }
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
