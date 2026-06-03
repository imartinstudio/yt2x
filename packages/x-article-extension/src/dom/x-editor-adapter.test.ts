import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeArticleDraftToPage } from "./x-editor-adapter.js";
import type { PreparedArticleImport } from "../files/prepare-import.js";

const actionMocks = vi.hoisted(() => ({
  dismissOpenOverlays: vi.fn(),
  waitForMediaUploadComplete: vi.fn(),
}));

const locatorMocks = vi.hoisted(() => ({
  articleEditor: vi.fn(),
  findTitleField: vi.fn(),
  readTitleFieldText: vi.fn(),
  waitForArticleDraftReady: vi.fn(),
}));

const coverMocks = vi.hoisted(() => ({
  uploadCoverImage: vi.fn(),
}));

const payloadMocks = vi.hoisted(() => ({
  buildMainWorldWritePayload: vi.fn(),
}));

const mainWorldMocks = vi.hoisted(() => ({
  runMainWorldImport: vi.fn(),
}));

vi.mock("./x-insert-actions.js", () => actionMocks);
vi.mock("./locators.js", () => locatorMocks);
vi.mock("./cover-upload.js", () => coverMocks);
vi.mock("../import/markdown-to-draft-payload.js", () => payloadMocks);
vi.mock("./main-world-import.js", () => mainWorldMocks);

describe("writeArticleDraftToPage", () => {
  let editor: HTMLElement;
  let title: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div contenteditable="true" id="title"></div>
      <div class="DraftEditor-root">
        <div class="public-DraftEditor-content" contenteditable="true" id="editor">
          <div data-block="true"><div>Imported body content long enough for verification.</div></div>
        </div>
      </div>
    `;
    editor = document.querySelector("#editor") as HTMLElement;
    title = document.querySelector("#title") as HTMLElement;
    locatorMocks.articleEditor.mockReturnValue(editor);
    locatorMocks.findTitleField.mockReturnValue(title);
    locatorMocks.readTitleFieldText.mockImplementation((field: HTMLElement) => field.textContent ?? "");
    locatorMocks.waitForArticleDraftReady.mockResolvedValue({ editor });
    actionMocks.waitForMediaUploadComplete.mockResolvedValue(undefined);
    coverMocks.uploadCoverImage.mockResolvedValue(undefined);
    payloadMocks.buildMainWorldWritePayload.mockResolvedValue({
      title: "Title",
      blocks: [{ type: "unstyled", text: "Body", inlineStyleRanges: [], links: [] }],
      plan: [],
      html: "<p>Body</p>",
      plain: "Body",
      markerPrefix: "__YT2X_test_",
      imageFiles: [],
    });
    mainWorldMocks.runMainWorldImport.mockResolvedValue({
      summary: {
        atomicOk: 1,
        atomicFail: 0,
        imgOk: 1,
        imgFail: 0,
        imageErrors: [],
        markersCleaned: 1,
      },
    });
    document.execCommand = vi.fn((command: string, _showUi?: boolean, value?: string) => {
      if (command === "insertText" && document.activeElement === title) {
        title.textContent = value ?? "";
        return true;
      }
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the MAIN world import pipeline for body, code blocks, and images", async () => {
    const prepared = {
      parseResult: {
        title: "Title",
        coverImage: null,
        contentImages: [{ path: "images/scene.png", alt: "scene", blockIndex: 1, afterText: "Body" }],
        contentVideos: [],
        contentCodeBlocks: [{ code: "pnpm test", language: "bash", blockIndex: 0, afterText: "" }],
        dividers: [],
        html: "<p>Body</p>",
        htmlBlocks: ["<p>Body</p>"],
        totalBlocks: 1,
      },
      adapted: { markdown: "# Title\n\nBody", adaptations: [], warnings: [] },
      mediaRegistry: { getUploadable: vi.fn(), resolveMediaPath: (source: string) => source },
      generatedBlobs: new Map(),
    } as unknown as PreparedArticleImport;

    const result = await writeArticleDraftToPage(prepared);

    expect(payloadMocks.buildMainWorldWritePayload).toHaveBeenCalledWith(prepared);
    expect(mainWorldMocks.runMainWorldImport).toHaveBeenCalled();
    expect(result.skippedMedia).toEqual([]);
    expect(result.manualContentMedia).toEqual([]);
  });

  it("reports image upload failures from the MAIN world summary", async () => {
    mainWorldMocks.runMainWorldImport.mockResolvedValue({
      summary: {
        atomicOk: 0,
        atomicFail: 0,
        imgOk: 0,
        imgFail: 1,
        imageErrors: [
          {
            index: 1,
            marker: "__YT2X_test_IMAGE_0__",
            source: "images/scene.png",
            error: "Image upload failed",
          },
        ],
        markersCleaned: 0,
      },
    });

    const prepared = {
      parseResult: {
        title: "Title",
        coverImage: null,
        contentImages: [],
        contentVideos: [],
        contentCodeBlocks: [],
        dividers: [],
        html: "<p>Body</p>",
        htmlBlocks: ["<p>Body</p>"],
        totalBlocks: 1,
      },
      adapted: { markdown: "# Title\n\nBody", adaptations: [], warnings: [] },
      mediaRegistry: { getUploadable: vi.fn(), resolveMediaPath: (source: string) => source },
      generatedBlobs: new Map(),
    } as unknown as PreparedArticleImport;

    const result = await writeArticleDraftToPage(prepared);

    expect(result.skippedMedia).toEqual(["images/scene.png"]);
    expect(result.lastMediaError).toBe("Image upload failed");
  });
});
