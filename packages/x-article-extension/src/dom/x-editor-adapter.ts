import {
  articleEditor,
  findTitleField,
  readTitleFieldText,
  waitForArticleDraftReady,
} from "./locators.js";
import {
  dismissOpenOverlays,
  resetInsertButtonCache,
  waitForMediaUploadComplete,
} from "./x-insert-actions.js";
import { type PreparedArticleImport, resolveUploadFile } from "../files/prepare-import.js";
import { uploadCoverImage } from "./cover-upload.js";
import { buildMainWorldWritePayload } from "../import/markdown-to-draft-payload.js";
import { runMainWorldImport } from "./main-world-import.js";

export type WriteArticleDraftOptions = {
  onProgress?: (message: string) => void;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

export { dismissOpenOverlays };

export type WriteArticleDraftResult = {
  skippedDividers: number[];
  skippedPromptCodeBlocks: number;
  skippedMedia: string[];
  lastMediaError: string | null;
  manualContentMedia: string[];
  filteredVideos: string[];
};

export const writeArticleDraftToPage = async (
  prepared: PreparedArticleImport,
  options: WriteArticleDraftOptions = {},
): Promise<WriteArticleDraftResult> => {
  const parseResult = prepared.parseResult;
  const skippedDividers: number[] = [];
  const skippedMedia: string[] = [];
  const manualContentMedia: string[] = [];
  let lastMediaError: string | null = null;
  const skippedPromptCodeBlocks = 0;
  const report = (message: string): void => {
    options.onProgress?.(message);
  };
  resetInsertButtonCache();

  try {
    report("等待草稿编辑器加载…");
    const { editor } = await waitForArticleDraftReady();
    dismissOpenOverlays();

    report("正在写入标题…");
    await fillTitle(parseResult.title);
    const filteredVideos = parseResult.contentVideos.map((media) => media.path);

    if (parseResult.coverImage !== null) {
      const coverFile = resolveUploadFile(prepared, parseResult.coverImage);
      if (coverFile === undefined) {
        lastMediaError = `Cover image is not authorized: ${parseResult.coverImage}`;
        skippedMedia.push(parseResult.coverImage);
      } else {
        report("正在上传封面…");
        try {
          await uploadCoverImage(coverFile);
          dismissOpenOverlays();
          await wait(350);
        } catch (err: unknown) {
          lastMediaError = err instanceof Error ? err.message : "Unknown cover upload error";
          skippedMedia.push(parseResult.coverImage);
          dismissOpenOverlays();
        }
      }
    }

    report("正在准备 MAIN world 导入数据…");
    const payload = await buildMainWorldWritePayload(prepared);

    report("正在通过 Draft.js 写入正文、代码块与图片…");
    const result = await runMainWorldImport(payload, {
      onProgress: (message) => report(message),
    });

    for (const imageError of result.summary.imageErrors) {
      if (/placeholder was not found/iu.test(imageError.error)) {
        if (imageError.source !== null) manualContentMedia.push(imageError.source);
        continue;
      }
      if (imageError.source !== null) skippedMedia.push(imageError.source);
      lastMediaError = imageError.error;
    }

    await fillTitle(parseResult.title);
    if (!editorHasMeaningfulContent(editor)) {
      throw new Error("X Articles body did not finish writing before import completed.");
    }

    if (filteredVideos.length > 0) {
      report("已过滤正文视频，仅导入文字和图片…");
    }

    report("正在等待草稿自动保存…");
    await waitForMediaUploadComplete(6_000);
    await wait(1_200);
    await fillTitle(parseResult.title);
    dismissOpenOverlays();

    return {
      skippedDividers,
      skippedPromptCodeBlocks,
      skippedMedia,
      lastMediaError,
      manualContentMedia,
      filteredVideos,
    };
  } finally {
    dismissOpenOverlays();
  }
};

export const readEditorContentState = (): { hasContent: boolean } => ({
  hasContent: editorHasMeaningfulContent(articleEditor()),
});

const isDraftBodyEditor = (editor: HTMLElement): boolean =>
  editor.classList.contains("public-DraftEditor-content") ||
  editor.closest(".DraftEditor-root") !== null;

const liveArticleEditor = (fallback: HTMLElement): HTMLElement => {
  try {
    return articleEditor();
  } catch {
    return fallback;
  }
};

const editorPlainText = (editor: HTMLElement): string => {
  const activeEditor = liveArticleEditor(editor);
  const root = (activeEditor.closest(".DraftEditor-root") as HTMLElement | null) ?? activeEditor;
  return (root.innerText ?? root.textContent ?? "").replace(/\u200b/gu, "").trim();
};

const editorHasMeaningfulContent = (editor: HTMLElement, minLength = 24): boolean => {
  const threshold = Math.max(1, Math.min(isDraftBodyEditor(editor) ? 8 : minLength, minLength));
  if (editorPlainText(editor).length < threshold) return false;
  if (!isDraftBodyEditor(editor)) return true;
  const activeEditor = liveArticleEditor(editor);
  const root = (activeEditor.closest(".DraftEditor-root") as HTMLElement | null) ?? activeEditor;
  return root.querySelector("div[data-block='true'],div[data-block]") !== null;
};

const titleLooksWritten = (expectedTitle: string, field: HTMLElement): boolean => {
  const written = readTitleFieldText(field);
  const expected = expectedTitle.trim();
  if (expected.length === 0) return true;
  if (written.length === 0 || /^添加标题$/u.test(written)) return false;
  return written.includes(expected) || expected.includes(written);
};

const selectAllIn = (element: HTMLElement): void => {
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

const fillTitle = async (title: string): Promise<void> => {
  const field = findTitleField();
  field.focus();

  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
    if (setter !== undefined) setter.call(field, title);
    else field.value = title;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  selectAllIn(field);
  if (!document.execCommand("insertText", false, title)) {
    throw new Error("X Articles title editor did not accept typed content.");
  }
  await wait(120);
  if (!titleLooksWritten(title, field)) {
    throw new Error("X Articles title editor did not retain typed content.");
  }
};
