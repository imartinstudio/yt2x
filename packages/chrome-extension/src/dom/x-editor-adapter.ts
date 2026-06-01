import {
  articleEditor,
  findTitleField,
  readTitleFieldText,
  waitForArticleDraftReady,
} from "./locators.js";
import { focusInsertionAnchor } from "./insertion-anchor.js";
import {
  dismissOpenOverlays,
  insertCodeBlock,
  insertContentMedia,
  insertDivider,
  resetInsertButtonCache,
  waitForMediaUploadComplete,
} from "./x-insert-actions.js";
import { type PreparedArticleImport, resolveUploadFile } from "../files/prepare-import.js";
import { uploadCoverImage } from "./cover-upload.js";
import { formatIndexedStep } from "../ui/import-loading.js";

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

class ArticleStructureRestoreError extends Error {}

export const writeArticleDraftToPage = async (
  prepared: PreparedArticleImport,
  options: WriteArticleDraftOptions = {},
): Promise<WriteArticleDraftResult> => {
  const parseResult = prepared.parseResult;
  const skippedDividers: number[] = [];
  const skippedMedia: string[] = [];
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
    report("正在写入正文…");
    await writeHtmlToEditor(editor, parseResult.html);
    report("正在确认标题与正文…");
    await fillTitle(parseResult.title);
    if (parseResult.html.trim().length > 0) {
      await waitForWrittenDraft(parseResult.title, editor);
    } else {
      await waitForWrittenTitle(parseResult.title);
    }

    dismissOpenOverlays();
    await wait(350);

    report("正在应用正文格式…");
    await applyStructuralFormatting(editor, parseResult, report);
    await fillTitle(parseResult.title);
    if (parseResult.html.trim().length > 0) {
      await waitForWrittenDraft(parseResult.title, editor);
    } else {
      await waitForWrittenTitle(parseResult.title);
    }
    report("正文格式已完成，正在处理封面…");

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

    const contentImages = [...parseResult.contentImages].sort((a, b) => b.blockIndex - a.blockIndex);
    for (let index = 0; index < contentImages.length; index += 1) {
      const image = contentImages[index]!;
      const imageFile = resolveUploadFile(prepared, image.path);
      if (imageFile === undefined) {
        lastMediaError = `Content image is not authorized: ${image.path}`;
        skippedMedia.push(image.path);
        continue;
      }
      report(formatIndexedStep("正在插入正文图片", index + 1, contentImages.length));
      try {
        await insertContentMedia(imageFile, {
          editor,
          afterText: image.afterText,
          blockIndex: image.blockIndex,
          totalBlocks: parseResult.totalBlocks,
          appendAtEnd: parseResult.totalBlocks === 0,
        });
        dismissOpenOverlays();
        await wait(350);
      } catch (err: unknown) {
        lastMediaError = err instanceof Error ? err.message : "Unknown content image upload error";
        skippedMedia.push(image.path);
        dismissOpenOverlays();
        if (parseResult.html.trim().length > 0 && !editorRetainsExpectedBody(editor, parseResult.html)) {
          report("检测到图片插入失败后正文丢失，正在恢复正文…");
          await restoreBaseBodyAfterStructuralDamage(editor, parseResult);
        }
      }
      await fillTitle(parseResult.title);
    }

    if (filteredVideos.length > 0) {
      report("已过滤正文视频，仅导入文字和图片…");
    }

    await fillTitle(parseResult.title);
    if (parseResult.html.trim().length > 0) {
      await waitForWrittenDraft(parseResult.title, editor);
    } else {
      await waitForWrittenTitle(parseResult.title);
    }

    report("正在等待草稿自动保存…");
    await waitForMediaUploadComplete(6_000);
    await wait(1_200);
    if (parseResult.html.trim().length > 0) {
      await waitForWrittenDraft(parseResult.title, editor);
    } else {
      await waitForWrittenTitle(parseResult.title);
    }
    dismissOpenOverlays();
    return {
      skippedDividers,
      skippedPromptCodeBlocks,
      skippedMedia,
      lastMediaError,
      manualContentMedia: [],
      filteredVideos,
    };
  } finally {
    dismissOpenOverlays();
  }
};

const restoreBaseBodyAfterStructuralDamage = async (
  editor: HTMLElement,
  parseResult: PreparedArticleImport["parseResult"],
): Promise<void> => {
  try {
    await writeHtmlToEditor(editor, parseResult.html);
    await fillTitle(parseResult.title);
    await waitForWrittenDraft(parseResult.title, editor);
  } catch (error: unknown) {
    throw new ArticleStructureRestoreError(
      `X Articles structural insertion damaged the article body and restoration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const applyStructuralFormatting = async (
  editor: HTMLElement,
  parseResult: PreparedArticleImport["parseResult"],
  report: (message: string) => void,
): Promise<void> => {
  const codeBlocks = parseResult.contentCodeBlocks;
  for (let index = 0; index < codeBlocks.length; index += 1) {
    const codeBlock = codeBlocks[index]!;
    report(formatIndexedStep("正在插入代码块", index + 1, codeBlocks.length));
    try {
      await insertCodeBlock(codeBlock.code, {
        editor,
        afterText: codeBlock.afterText,
        blockIndex: codeBlock.blockIndex,
        totalBlocks: parseResult.totalBlocks,
      });
    } catch (error: unknown) {
      throw new Error(
        `X Articles 代码块无法插入（block ${codeBlock.blockIndex}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!editorRetainsExpectedBody(editor, parseResult.html)) {
      report("检测到结构块覆盖正文，正在恢复正文…");
      await restoreBaseBodyAfterStructuralDamage(editor, parseResult);
      throw new ArticleStructureRestoreError(
        "X Articles code insertion replaced the article body; the base body text was restored.",
      );
    }
    await fillTitle(parseResult.title);
  }

  const dividers = [...parseResult.dividers].sort((a, b) => b.blockIndex - a.blockIndex);
  for (let index = 0; index < dividers.length; index += 1) {
    const divider = dividers[index]!;
    report(formatIndexedStep("正在插入分割线", index + 1, dividers.length));
    let dividerAnchor:
      | { editor: HTMLElement; afterText: string; blockIndex: number; totalBlocks: number }
      | undefined;
    try {
      focusInsertionAnchor(editor, divider.afterText, divider.blockIndex, parseResult.totalBlocks);
      dividerAnchor = {
        editor,
        afterText: divider.afterText,
        blockIndex: divider.blockIndex,
        totalBlocks: parseResult.totalBlocks,
      };
    } catch (error: unknown) {
      throw new Error(
        `X Articles 分割线插入位置无法定位（block ${divider.blockIndex}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const inserted = await insertDivider(dividerAnchor);
    if (!inserted) {
      throw new Error(`X Articles 分割线无法插入（block ${divider.blockIndex}）。`);
    }
    if (!editorRetainsExpectedBody(editor, parseResult.html)) {
      report("检测到结构块覆盖正文，正在恢复正文…");
      await restoreBaseBodyAfterStructuralDamage(editor, parseResult);
      throw new ArticleStructureRestoreError(
        "X Articles divider insertion replaced the article body; the base body text was restored.",
      );
    }
  }
};

export const readEditorContentState = (): { hasContent: boolean } => ({
  hasContent: editorHasMeaningfulContent(articleEditor()),
});

const selectAllIn = (element: HTMLElement): void => {
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

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

const editorRetainsExpectedBody = (editor: HTMLElement, html: string): boolean => {
  const expected = htmlToPlainText(html).replace(/\s+/gu, " ").trim();
  if (expected.length === 0) return true;
  const actual = editorPlainText(editor).replace(/\s+/gu, " ");
  const head = expected.slice(0, Math.min(24, expected.length));
  const tail = expected.slice(-Math.min(24, expected.length));
  return actual.includes(head) && actual.includes(tail);
};

const htmlToPlainText = (html: string): string => {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const blocks: string[] = [];
  for (const node of doc.body.children) {
    if (node.tagName.toLowerCase() === "hr") {
      blocks.push("---");
      continue;
    }
    const text = (node.textContent ?? "").replace(/\u200b/gu, "").trim();
    if (text.length > 0) blocks.push(text);
  }
  if (blocks.length > 0) return blocks.join("\n\n");
  return (doc.body.textContent ?? "").replace(/\u200b/gu, "").trim();
};

const waitForEditorSettled = async (
  editor: HTMLElement,
  expectedPlain: string,
  timeoutMs: number,
): Promise<boolean> => {
  const needle = expectedPlain.slice(0, Math.min(32, expectedPlain.length));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = editorPlainText(editor);
    if (
      editorHasMeaningfulContent(editor, expectedPlain.length) &&
      (needle.length === 0 || text.includes(needle.slice(0, 12)))
    ) {
      return true;
    }
    await wait(120);
  }
  return editorHasMeaningfulContent(editor, expectedPlain.length);
};

const titleLooksWritten = (expectedTitle: string, field: HTMLElement): boolean => {
  const written = readTitleFieldText(field);
  const expected = expectedTitle.trim();
  if (expected.length === 0) return true;
  if (written.length === 0 || /^添加标题$/u.test(written)) return false;
  return written.includes(expected) || expected.includes(written);
};

const waitForWrittenDraft = async (expectedTitle: string, editor: HTMLElement): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const titleOk = titleLooksWritten(expectedTitle, findTitleField());
    const bodyOk = editorHasMeaningfulContent(editor);
    if (titleOk && bodyOk) return;
    await wait(120);
  }
  const titleOk = titleLooksWritten(expectedTitle, findTitleField());
  const bodyOk = editorHasMeaningfulContent(editor);
  if (!titleOk && !bodyOk) {
    throw new Error("X Articles title and body did not finish writing before media upload.");
  }
  if (!titleOk) {
    throw new Error("X Articles title did not finish writing before media upload.");
  }
  if (!bodyOk) {
    throw new Error("X Articles body did not finish writing before media upload.");
  }
};

const waitForWrittenTitle = async (expectedTitle: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (titleLooksWritten(expectedTitle, findTitleField())) return;
    await wait(120);
  }
  throw new Error("X Articles title did not finish writing before media upload.");
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

const clearEditorContent = (editor: HTMLElement): void => {
  editor.focus();
  selectAllIn(editor);
  document.execCommand("delete");
};

const pasteViaClipboard = async (html: string, plain: string): Promise<boolean> => {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      }),
    ]);
  } catch {
    try {
      await navigator.clipboard.writeText(plain);
    } catch {
      return false;
    }
  }
  return document.execCommand("paste");
};

const dispatchSyntheticPaste = (editor: HTMLElement, html: string, plain: string): void => {
  if (typeof DataTransfer !== "function" || typeof ClipboardEvent !== "function") return;
  const transfer = new DataTransfer();
  transfer.setData("text/html", html);
  transfer.setData("text/plain", plain);
  editor.dispatchEvent(
    new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }),
  );
};

const writeHtmlToEditor = async (editor: HTMLElement, html: string): Promise<void> => {
  if (html.trim().length === 0) return;

  const plain = htmlToPlainText(html);
  const draft = isDraftBodyEditor(editor);

  clearEditorContent(editor);
  await wait(draft ? 250 : 120);

  const attempts: Array<() => Promise<void>> = [
    async () => {
      if (!(await pasteViaClipboard(html, plain))) {
        dispatchSyntheticPaste(editor, html, plain);
      }
    },
    async () => {
      editor.focus();
      if (!document.execCommand("insertText", false, plain)) {
        throw new Error("X Articles body editor rejected persistent text insertion.");
      }
    },
  ];

  for (const attempt of attempts) {
    clearEditorContent(editor);
    await wait(120);
    await attempt();
    if (await waitForEditorSettled(editor, plain, draft ? 2_000 : 1_000)) return;
  }

  throw new Error("X Articles body editor did not accept pasted HTML content.");
};
