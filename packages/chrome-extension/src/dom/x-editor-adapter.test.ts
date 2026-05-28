import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeArticleDraftToPage } from "./x-editor-adapter.js";
import type { PreparedArticleImport } from "../files/prepare-import.js";

const actionMocks = vi.hoisted(() => ({
  dismissOpenOverlays: vi.fn(),
  insertCodeBlock: vi.fn(),
  insertContentMedia: vi.fn(),
  insertDivider: vi.fn(),
  resetInsertButtonCache: vi.fn(),
  waitForMediaUploadComplete: vi.fn(),
}));

const locatorMocks = vi.hoisted(() => ({
  articleEditor: vi.fn(),
  findTitleField: vi.fn(),
  readTitleFieldText: vi.fn(),
  waitForArticleDraftReady: vi.fn(),
}));

const anchorMocks = vi.hoisted(() => ({
  focusInsertionAnchor: vi.fn(),
}));

const coverMocks = vi.hoisted(() => ({
  uploadCoverImage: vi.fn(),
}));

vi.mock("./x-insert-actions.js", () => actionMocks);
vi.mock("./locators.js", () => locatorMocks);
vi.mock("./insertion-anchor.js", () => anchorMocks);
vi.mock("./cover-upload.js", () => coverMocks);

describe("writeArticleDraftToPage", () => {
  let editor: HTMLElement;
  let title: HTMLElement;
  let clipboardHtml = "";

  beforeEach(() => {
    document.body.innerHTML = `
      <div contenteditable="true" id="title"></div>
      <div class="DraftEditor-root">
        <div class="public-DraftEditor-content" contenteditable="true" id="editor"></div>
      </div>
    `;
    editor = document.querySelector("#editor") as HTMLElement;
    title = document.querySelector("#title") as HTMLElement;
    locatorMocks.articleEditor.mockReturnValue(editor);
    locatorMocks.findTitleField.mockReturnValue(title);
    locatorMocks.readTitleFieldText.mockImplementation((field: HTMLElement) => field.textContent ?? "");
    locatorMocks.waitForArticleDraftReady.mockResolvedValue({ editor });
    actionMocks.insertDivider.mockResolvedValue(true);
    actionMocks.insertCodeBlock.mockResolvedValue(undefined);
    actionMocks.insertContentMedia.mockResolvedValue(undefined);
    actionMocks.waitForMediaUploadComplete.mockResolvedValue(undefined);
    coverMocks.uploadCoverImage.mockResolvedValue(undefined);

    vi.stubGlobal(
      "ClipboardItem",
      class {
        readonly entries: Record<string, Blob>;
        constructor(entries: Record<string, Blob>) {
          this.entries = entries;
        }
      },
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn(),
      },
    });
    document.execCommand = vi.fn((command: string, _showUi?: boolean, value?: string) => {
      if (command === "delete") {
        if (document.activeElement === editor) editor.innerHTML = "";
        else title.textContent = "";
        return true;
      }
      if (command === "paste") {
        editor.innerHTML = `<div data-block="true">${clipboardHtml}</div>`;
        return true;
      }
      if (command === "insertText") {
        if (document.activeElement === title) title.textContent = value ?? "";
        else editor.innerHTML = `<div data-block="true">${value ?? ""}</div>`;
        return true;
      }
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("uploads only the cover and defers content media to manual insertion", async () => {
    const events: string[] = [];
    actionMocks.insertCodeBlock.mockImplementation(async () => {
      events.push("code");
    });
    actionMocks.insertDivider.mockImplementation(async () => {
      events.push("divider");
      return true;
    });
    coverMocks.uploadCoverImage.mockImplementation(async () => {
      events.push("cover");
      throw new Error("cover failed");
    });
    const file = new File(["asset"], "asset.bin");
    clipboardHtml = "<p>Intro content long enough.</p><p>Tail content remains here.</p>";
    const prepared = {
      parseResult: {
        title: "Title",
        coverImage: "cover.jpg",
        contentImages: [],
        contentVideos: [{ path: "clip.mp4", alt: "", blockIndex: 1, afterText: "Tail" }],
        contentCodeBlocks: [
          { code: "code", language: "text", blockIndex: 1, afterText: "Intro" },
        ],
        dividers: [{ blockIndex: 1, afterText: "Intro" }],
        html: clipboardHtml,
        htmlBlocks: ["<p>Intro content long enough.</p>", "<p>Tail content remains here.</p>"],
        totalBlocks: 2,
      },
      mediaRegistry: {
        getUploadable: () => file,
      },
      generatedBlobs: new Map(),
    } as unknown as PreparedArticleImport;

    const result = await writeArticleDraftToPage(prepared);

    expect(events).toEqual(["code", "divider", "cover"]);
    expect(result.skippedMedia).toEqual(["cover.jpg"]);
    expect(result.lastMediaError).toBe("cover failed");
    expect(result.manualContentMedia).toEqual(["clip.mp4"]);
    expect(actionMocks.insertContentMedia).not.toHaveBeenCalled();
    expect(editor.textContent).toContain("Tail content remains here.");
  });

  it("does not begin media uploads when structural formatting fails", async () => {
    clipboardHtml = "<p>Intro content long enough.</p><p>Tail content remains here.</p>";
    actionMocks.insertDivider.mockResolvedValue(false);
    const prepared = {
      parseResult: {
        title: "Title",
        coverImage: "cover.jpg",
        contentImages: [],
        contentVideos: [],
        contentCodeBlocks: [],
        dividers: [{ blockIndex: 1, afterText: "Intro" }],
        html: clipboardHtml,
        htmlBlocks: [clipboardHtml],
        totalBlocks: 2,
      },
      mediaRegistry: {
        getUploadable: () => new File(["cover"], "cover.jpg"),
      },
      generatedBlobs: new Map(),
    } as unknown as PreparedArticleImport;

    await expect(writeArticleDraftToPage(prepared)).rejects.toThrow("X Articles 分割线无法插入");
    expect(coverMocks.uploadCoverImage).not.toHaveBeenCalled();
    expect(actionMocks.insertContentMedia).not.toHaveBeenCalled();
  });

  it("restores the pasted body and stops when a legacy structural insert replaces it", async () => {
    clipboardHtml = "<p>Intro content long enough.</p><p>Tail content remains here.</p>";
    actionMocks.insertCodeBlock.mockImplementation(async () => {
      editor.innerHTML = "<pre><code>Only inserted code remains.</code></pre>";
    });
    const prepared = {
      parseResult: {
        title: "Title",
        coverImage: "cover.jpg",
        contentImages: [],
        contentVideos: [],
        contentCodeBlocks: [
          { code: "Only inserted code remains.", language: "text", blockIndex: 1, afterText: "Intro" },
        ],
        dividers: [],
        html: clipboardHtml,
        htmlBlocks: [clipboardHtml],
        totalBlocks: 2,
      },
      mediaRegistry: {
        getUploadable: () => new File(["cover"], "cover.jpg"),
      },
      generatedBlobs: new Map(),
    } as unknown as PreparedArticleImport;

    await expect(writeArticleDraftToPage(prepared)).rejects.toThrow(
      "X Articles code insertion replaced the article body",
    );
    expect(editor.textContent).toContain("Tail content remains here.");
    expect(coverMocks.uploadCoverImage).not.toHaveBeenCalled();
  });

  it("falls back to persistent text editing without using raw DOM HTML insertion", async () => {
    clipboardHtml = "<p>Intro content long enough.</p><p>Tail content remains here.</p>";
    vi.mocked(document.execCommand).mockImplementation(
      (command: string, _showUi?: boolean, value?: string) => {
        if (command === "delete") {
          if (document.activeElement === editor) editor.innerHTML = "";
          else title.textContent = "";
          return true;
        }
        if (command === "paste") return false;
        if (command === "insertText") {
          if (document.activeElement === title) title.textContent = value ?? "";
          else editor.innerHTML = `<div data-block="true">${value ?? ""}</div>`;
          return true;
        }
        return false;
      },
    );
    const prepared = {
      parseResult: {
        title: "Title",
        coverImage: null,
        contentImages: [],
        contentVideos: [],
        contentCodeBlocks: [],
        dividers: [],
        html: clipboardHtml,
        htmlBlocks: [clipboardHtml],
        totalBlocks: 2,
      },
      mediaRegistry: { getUploadable: () => undefined },
      generatedBlobs: new Map(),
    } as unknown as PreparedArticleImport;

    await expect(writeArticleDraftToPage(prepared)).resolves.toEqual(
      expect.objectContaining({ skippedMedia: [] }),
    );
    expect(editor.textContent).toContain("Tail content remains here.");
    expect(document.execCommand).not.toHaveBeenCalledWith("insertHTML", false, expect.anything());
  });

  it("does not invoke content-media insertion even when body media is present", async () => {
    clipboardHtml = "<p>Intro content long enough.</p><p>Tail content remains here.</p>";
    actionMocks.insertContentMedia.mockImplementation(async () => {
      editor.innerHTML = "";
      throw new Error("media picker failed");
    });
    const prepared = {
      parseResult: {
        title: "Title",
        coverImage: null,
        contentImages: [{ path: "shot.png", alt: "", blockIndex: 1, afterText: "Intro" }],
        contentVideos: [],
        contentCodeBlocks: [],
        dividers: [],
        html: clipboardHtml,
        htmlBlocks: [clipboardHtml],
        totalBlocks: 2,
      },
      mediaRegistry: { getUploadable: () => new File(["shot"], "shot.png") },
      generatedBlobs: new Map(),
    } as unknown as PreparedArticleImport;

    const result = await writeArticleDraftToPage(prepared);

    expect(result.lastMediaError).toBeNull();
    expect(result.manualContentMedia).toEqual(["shot.png"]);
    expect(actionMocks.insertContentMedia).not.toHaveBeenCalled();
    expect(editor.textContent).toContain("Tail content remains here.");
  });
});
