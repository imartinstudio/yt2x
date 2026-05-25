import {
  articleEditor,
  findTitleField,
  readTitleFieldText,
  waitForArticleDraftReady,
} from "./locators.js";
import { focusEditorEnd, focusInsertionAnchor } from "./insertion-anchor.js";
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
};

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
    const contentMedia = [...parseResult.contentImages, ...parseResult.contentVideos].sort(
      (a, b) => a.blockIndex - b.blockIndex,
    );
    let writtenBlocks = parseResult.totalBlocks;
    const initialHtml =
      contentMedia.length === 0
        ? parseResult.html
        : parseResult.htmlBlocks.slice(0, contentMedia[0]!.blockIndex).join("");
    if (contentMedia.length > 0) {
      writtenBlocks = contentMedia[0]!.blockIndex;
    }
    report("正在写入正文…");
    await writeHtmlToEditor(editor, initialHtml);
    report("正在确认标题与正文…");
    await fillTitle(parseResult.title);
    if (initialHtml.trim().length > 0) {
      await waitForWrittenDraft(parseResult.title, editor);
    }

    dismissOpenOverlays();
    await wait(350);

    if (parseResult.coverImage !== null) {
      const coverFile = resolveUploadFile(prepared, parseResult.coverImage);
      if (coverFile === undefined) {
        throw new Error(`Cover image is not authorized: ${parseResult.coverImage}`);
      }
      report("正在上传封面…");
      await uploadCoverImage(coverFile);
      dismissOpenOverlays();
      await wait(350);
    }

    for (let index = 0; index < contentMedia.length; index += 1) {
      const media = contentMedia[index]!;
      if (media.blockIndex > writtenBlocks) {
        const nextHtml = parseResult.htmlBlocks.slice(writtenBlocks, media.blockIndex).join("");
        report("正在追加正文片段…");
        await appendHtmlToEditor(
          editor,
          nextHtml,
          parseResult.htmlBlocks.slice(0, media.blockIndex).join(""),
        );
        writtenBlocks = media.blockIndex;
      }
      const file = resolveUploadFile(prepared, media.path);
      if (file === undefined) {
        throw new Error(`Content media is not authorized: ${media.path}`);
      }
      report(formatIndexedStep("正在插入图片/视频", index + 1, contentMedia.length));
      try {
        await insertContentMedia(file, {
          editor,
          afterText: media.afterText,
          blockIndex: media.blockIndex,
          totalBlocks: parseResult.totalBlocks,
          appendAtEnd: true,
        });
        const writtenHtml = parseResult.htmlBlocks.slice(0, writtenBlocks).join("");
        if (!editorRetainsExpectedBody(editor, writtenHtml)) {
          report("检测到媒体覆盖正文，正在恢复正文…");
          await writeHtmlToEditor(editor, parseResult.html);
          await fillTitle(parseResult.title);
          throw new Error("X Articles media insertion replaced the article body; the body text was restored.");
        }
      } catch (err: unknown) {
        lastMediaError =
          err instanceof Error ? err.message : "Unknown media insertion error";
        throw new Error(`X Articles 正文媒体未能插入（${media.path}）：${lastMediaError}`);
      }
    }

    if (writtenBlocks < parseResult.totalBlocks) {
      report("正在追加剩余正文…");
      await appendHtmlToEditor(
        editor,
        parseResult.htmlBlocks.slice(writtenBlocks).join(""),
        parseResult.html,
      );
    }
    await fillTitle(parseResult.title);
    await waitForWrittenDraft(parseResult.title, editor);

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
    }

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
      await fillTitle(parseResult.title);
    }

    await fillTitle(parseResult.title);

    report("正在等待媒体上传完成…");
    await waitForMediaUploadComplete(6_000);
    dismissOpenOverlays();
    return { skippedDividers, skippedPromptCodeBlocks, skippedMedia, lastMediaError };
  } finally {
    dismissOpenOverlays();
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
  const threshold = isDraftBodyEditor(editor) ? 8 : minLength;
  return editorPlainText(editor).length >= threshold;
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
    if (text.length >= 8 && (needle.length === 0 || text.includes(needle.slice(0, 12)))) {
      return true;
    }
    await wait(120);
  }
  return editorHasMeaningfulContent(editor);
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

const fillTitle = async (title: string): Promise<void> => {
  const field = findTitleField();
  field.focus();

  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    field.value = title;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  field.textContent = title;
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: title }));
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
      document.execCommand("insertHTML", false, html);
      editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    },
    async () => {
      if (!(await pasteViaClipboard(plain, plain))) {
        dispatchSyntheticPaste(editor, plain, plain);
      }
    },
    async () => {
      editor.focus();
      document.execCommand("insertText", false, plain);
      editor.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: plain }),
      );
    },
  ];

  for (const attempt of attempts) {
    clearEditorContent(editor);
    await wait(120);
    await attempt();
    if (await waitForEditorSettled(editor, plain, draft ? 4_000 : 2_000)) return;
  }

  throw new Error("X Articles body editor did not accept pasted HTML content.");
};

const appendHtmlToEditor = async (
  editor: HTMLElement,
  html: string,
  expectedHtml: string,
): Promise<void> => {
  if (html.trim().length === 0) return;

  const activeEditor = liveArticleEditor(editor);
  focusEditorEnd(activeEditor);
  document.execCommand("insertHTML", false, html);
  activeEditor.dispatchEvent(new InputEvent("input", { bubbles: true }));

  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (editorRetainsExpectedBody(editor, expectedHtml)) return;
    await wait(120);
  }
  throw new Error("X Articles body editor did not accept appended HTML content.");
};
