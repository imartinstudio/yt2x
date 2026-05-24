import os from "node:os";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import type { SaveArticleDraftInput, SaveArticleDraftResult, XArticlesDraftPort } from "@yt2x/core";

const DEFAULT_BROWSER_PROFILE_DIR = path.join(os.homedir(), ".config", "yt2x", "browser-profile");
const DEFAULT_TIMEOUT_MS = 45_000;

export const createXArticlesDraftAdapter = (): XArticlesDraftPort => ({
  saveDraft: async (input) => saveDraft(input),
});

const saveDraft = async (input: SaveArticleDraftInput): Promise<SaveArticleDraftResult> => {
  const context = await chromium.launchPersistentContext(input.browserProfileDir ?? DEFAULT_BROWSER_PROFILE_DIR, {
    headless: input.headless === true,
    timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const warnings: string[] = [];
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://x.com" });
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    await page.goto("https://x.com/compose/articles", { waitUntil: "domcontentloaded" });
    await clickCreate(page);

    if (input.parseResult.coverImage !== null) {
      await uploadCover(page, input.parseResult.coverImage);
    } else {
      warnings.push("No cover image was found for the X Article draft.");
    }

    await fillTitle(page, input.parseResult.title);
    const editor = await articleEditor(page);
    await copyHtmlToClipboard(page, input.parseResult.html);
    await editor.click();
    await editor.press(pasteShortcut());

    for (const codeBlock of input.parseResult.contentCodeBlocks) {
      await focusInsertionAnchor(editor, codeBlock.afterText, codeBlock.blockIndex);
      await insertCodeBlock(page, codeBlock.code);
    }

    const contentMedia = [...input.parseResult.contentImages, ...input.parseResult.contentVideos].sort(
      (a, b) => b.blockIndex - a.blockIndex,
    );
    for (const media of contentMedia) {
      await focusInsertionAnchor(editor, media.afterText, media.blockIndex);
      await insertContentMedia(page, media.path);
    }

    for (const divider of [...input.parseResult.dividers].sort((a, b) => b.blockIndex - a.blockIndex)) {
      await focusInsertionAnchor(editor, divider.afterText, divider.blockIndex);
      const inserted = await insertDivider(page);
      if (!inserted) {
        throw new Error(`X Article divider could not be inserted after block ${divider.blockIndex}.`);
      }
    }

    await waitForMediaUploadComplete(page);
    return {
      draftSavedAt: new Date().toISOString(),
      editorUrl: page.url(),
      warnings,
    };
  } finally {
    await context.close();
  }
};

const clickCreate = async (page: Page): Promise<void> => {
  const create = page.getByRole("button", { name: /create|创建|新建/iu }).first();
  if ((await create.count()) === 0) {
    throw new Error("X Articles create button was not found. Open the browser profile and log in to X Premium first.");
  }
  await create.click();
};

const uploadCover = async (page: Page, coverImage: string): Promise<void> => {
  const chooseFile = page.getByRole("button", { name: /choose file|选择文件/iu }).first();
  const addMedia = page.getByRole("button", { name: /add.*(?:photo|video)|添加照片或视频/iu }).first();
  const upload = (await chooseFile.count()) > 0 ? chooseFile : addMedia;
  if ((await upload.count()) > 0) {
    const chooser = page.waitForEvent("filechooser");
    await upload.click();
    await (await chooser).setFiles(coverImage);
    await waitForMediaUploadComplete(page);
    return;
  }
  const input = page.locator('input[type="file"]').first();
  if ((await input.count()) === 0) throw new Error("X Articles cover upload control was not found.");
  await input.setInputFiles(coverImage);
  await waitForMediaUploadComplete(page);
};

const fillTitle = async (page: Page, title: string): Promise<void> => {
  const byPlaceholder = page.locator('[placeholder*="title" i], [data-placeholder*="title" i]').first();
  if ((await byPlaceholder.count()) > 0) {
    await byPlaceholder.fill(title);
    return;
  }
  const textboxes = page.getByRole("textbox");
  if ((await textboxes.count()) === 0) throw new Error("X Articles title textbox was not found.");
  await textboxes.first().fill(title);
};

const articleEditor = async (page: Page): Promise<Locator> => {
  const editors = page.locator('[contenteditable="true"]');
  const count = await editors.count();
  if (count === 0) throw new Error("X Articles editor was not found after creating a draft.");
  return editors.nth(count - 1);
};

const focusInsertionAnchor = async (editor: Locator, afterText: string, blockIndex: number): Promise<void> => {
  if (afterText.trim().length === 0) {
    throw new Error(`X Article media after block ${blockIndex} has no text anchor for reliable insertion.`);
  }
  const anchor = editor.getByText(afterText, { exact: false }).last();
  if ((await anchor.count()) === 0) {
    throw new Error(`X Article insertion anchor was not found after block ${blockIndex}: "${afterText}"`);
  }
  await anchor.click();
  await anchor.press("End");
};

const insertContentMedia = async (page: Page, mediaPath: string): Promise<void> => {
  const insert = page.getByRole("button", { name: /add media content|添加媒体内容|insert/iu }).first();
  if ((await insert.count()) === 0) throw new Error("X Articles media insertion control was not found.");
  await insert.click();
  const media = page.getByRole("menuitem", { name: /^(?:media|媒体)$/iu }).first();
  if ((await media.count()) === 0) throw new Error("X Articles media menu item was not found.");
  await media.click();
  const dialog = page.getByRole("dialog").last();
  await dialog.waitFor({ state: "visible" });
  const input = dialog.locator('input[type="file"]').first();
  if ((await input.count()) > 0) {
    await input.setInputFiles(mediaPath);
  } else {
    const upload = dialog.getByRole("button", { name: /choose file|add.*(?:photo|video)|添加照片或视频|选择文件/iu }).first();
    if ((await upload.count()) === 0) throw new Error("X Articles content media upload control was not found.");
    const chooser = page.waitForEvent("filechooser");
    await upload.click();
    await (await chooser).setFiles(mediaPath);
  }
  await waitForMediaUploadComplete(page);
};

const insertDivider = async (page: Page): Promise<boolean> => {
  const insert = page.getByRole("button", { name: /insert|add.*media|插入|添加/iu }).first();
  if ((await insert.count()) === 0) return false;
  await insert.click();
  const divider = page.getByRole("menuitem", { name: /divider|分割线/iu }).first();
  if ((await divider.count()) === 0) return false;
  await divider.click();
  return true;
};

const insertCodeBlock = async (page: Page, code: string): Promise<void> => {
  const insert = page.getByRole("button", { name: /insert|add.*media|插入|添加/iu }).first();
  if ((await insert.count()) === 0) throw new Error("X Articles code insertion control was not found.");
  await insert.click();
  const codeItem = page.getByRole("menuitem", { name: /^(?:code|代码)$/iu }).first();
  if ((await codeItem.count()) === 0) throw new Error("X Articles code menu item was not found.");
  await codeItem.click();
  await page.keyboard.insertText(code);
};

const waitForMediaUploadComplete = async (page: Page): Promise<void> => {
  await page
    .locator('[role="progressbar"], [aria-busy="true"]')
    .waitFor({ state: "detached", timeout: 10_000 })
    .catch(() => {});
  await page
    .getByText(/uploading media|正在上传媒体/iu)
    .waitFor({ state: "detached", timeout: 3_000 })
    .catch(() => {});
};

const copyHtmlToClipboard = async (page: Page, html: string): Promise<void> => {
  await page.evaluate(
    async (richHtml) => {
      const clip = globalThis as unknown as {
        navigator: { clipboard: { write(items: unknown[]): Promise<void> } };
        ClipboardItem: new (items: Record<string, Blob>) => unknown;
        Blob: typeof Blob;
      };
      await clip.navigator.clipboard.write([
        new clip.ClipboardItem({
          "text/html": new clip.Blob([richHtml], { type: "text/html" }),
          "text/plain": new clip.Blob([richHtml], { type: "text/plain" }),
        }),
      ]);
    },
    html,
  );
};

const pasteShortcut = (): string => (process.platform === "darwin" ? "Meta+V" : "Control+V");
