import { readFile } from "node:fs/promises";
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

    for (const image of [...input.parseResult.contentImages].sort((a, b) => b.blockIndex - a.blockIndex)) {
      await focusBlock(editor, image.blockIndex);
      await copyImageToClipboard(page, image.path);
      await editor.press(pasteShortcut());
      await waitForMediaUploadComplete(page);
    }

    for (const divider of [...input.parseResult.dividers].sort((a, b) => b.blockIndex - a.blockIndex)) {
      await focusBlock(editor, divider.blockIndex);
      const inserted = await insertDivider(page);
      if (!inserted) warnings.push(`Divider after block ${divider.blockIndex} needs manual insertion.`);
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
  const input = page.locator('input[type="file"]').first();
  if ((await input.count()) > 0) {
    await input.setInputFiles(coverImage);
    await waitForMediaUploadComplete(page);
    return;
  }
  const upload = page
    .getByRole("button", { name: /add.*(?:photo|media)|添加.*(?:照片|媒体|封面)/iu })
    .first();
  if ((await upload.count()) === 0) throw new Error("X Articles cover upload control was not found.");
  const chooser = page.waitForEvent("filechooser");
  await upload.click();
  await (await chooser).setFiles(coverImage);
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

const focusBlock = async (editor: Locator, blockIndex: number): Promise<void> => {
  const blocks = editor.locator(":scope > *");
  const count = await blocks.count();
  if (count === 0) {
    await editor.click();
    return;
  }
  await blocks.nth(Math.min(blockIndex, count - 1)).click();
  await editor.press("End");
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

const copyImageToClipboard = async (page: Page, imagePath: string): Promise<void> => {
  const bytes = await readFile(imagePath);
  const contentType = contentTypeForImage(imagePath);
  await page.evaluate(
    async ({ base64, type }) => {
      const clip = globalThis as unknown as {
        navigator: { clipboard: { write(items: unknown[]): Promise<void> } };
        ClipboardItem: new (items: Record<string, Blob>) => unknown;
        Blob: typeof Blob;
        fetch(url: string): Promise<{ blob(): Promise<Blob> }>;
      };
      const blob = await (await clip.fetch(`data:${type};base64,${base64}`)).blob();
      await clip.navigator.clipboard.write([new clip.ClipboardItem({ [type]: blob })]);
    },
    { base64: bytes.toString("base64"), type: contentType },
  );
};

const contentTypeForImage = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
};

const pasteShortcut = (): string => (process.platform === "darwin" ? "Meta+V" : "Control+V");
